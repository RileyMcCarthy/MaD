//! Every live-data request the firmware receives at 2 Mbaud is answered.
//!
//! The protocol link's receive pin is an async-RX smart pin, and on silicon it
//! holds ONE byte: the next byte to arrive overwrites it, 800 clocks later at
//! 2 Mbaud and 160 MHz. A receiver that leaves the pin unread for longer than
//! that loses a byte, and a request missing a byte is never answered — which
//! the app's stop-and-wait link turns into a 2 s freeze of the live data.
//!
//! The SERIAL cog is away from the pin for exactly that long in two places:
//! while it transmits (each byte holds it for a byte time until the smart pin
//! takes the next), and between two receive calls. So this test keeps several
//! READ_SAMPLE requests in flight, each sent at a random moment, many of them
//! while the firmware is still transmitting replies, and requires a reply to
//! every request and no byte ever overwritten on the pin.
//!
//! The ISS models the one-byte register and the transmitter's pacing (`RxPin`
//! and `TxPace` in `p2iss/src/lib.rs`), so a firmware that polls its receive
//! pin fails here the way it fails on a P2-EVAL: the polling build before
//! HAL_serial.c took RX by interrupt loses about a quarter of the requests.
//! p2core charges a flat cost per instruction, so the polling gap between
//! receive calls is shorter here than silicon's 1,600-4,500 clocks; the
//! transmit window is a byte time per byte on both, and is what this test
//! leans on.
//!
//! Deterministic: the host starts on the firmware's first byte, not on the
//! test thread's wall clock, and draws its delays from a fixed seed.
//!
//! `P2_IMAGE=path` runs it against another build of the firmware. Skipped when
//! the image is absent (MAD_REQUIRE_P2_IMAGE makes that a failure).

use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use embsim_board::uart::UartFraming;
use embsim_board::{
    jesd8c01_lvcmos_thresholds, AttachError, Component, ComponentNetIo, DeadBand, FramingError,
    Harness, PinDecl, SerialLevelBridge, System,
};
use embsim_core::virtual_clock;
use p2iss::{P2Iss, SerialLink};
use protoemb_framing::{build_read_frame, FrameParser, ParsedFrame};
use vibes_behaviour::{behaviour, expect, Test};

/// The MaD protocol link, as the firmware programs it.
const PROTO: SerialLink = SerialLink {
    tx_pin: 55,
    rx_pin: 53,
    nominal_baud: 2_000_000,
};

/// `sample`'s command id in `Protocol/MaDProtocol.yaml`.
const READ_SAMPLE: u8 = 0;
/// Requests per run.
const REQUESTS: usize = 24;
/// Requests the host keeps outstanding. The firmware answers in batches, once
/// per tick of its 100 Hz communication task, and transmits a batch back to
/// back: eight replies are a millisecond of the transmitter running.
const IN_FLIGHT: usize = 8;
/// Virtual time between the firmware's first byte and the first requests: the
/// cogs are still coming up when the protocol pins are configured.
const SETTLE_NS: u64 = 10_000_000;
/// The first requests spread over one communication tick.
const TICK_NS: u64 = 10_000_000;
/// Each reply that starts plans the next request this long after it, drawn
/// uniformly. A sample reply is 26 bytes, 130 us on the wire, so many land
/// while the batch is still being transmitted and the rest at arbitrary points
/// of the firmware's loop.
const SPREAD_NS: u64 = 400_000;
/// A request with no reply after three communication ticks is lost.
const REPLY_TIMEOUT_NS: u64 = 30_000_000;
const SEED: u64 = 0x5EED_2B0D_1E55_0001;

static CLOCK_LOCK: Mutex<()> = Mutex::new(());

fn lock_clock() -> MutexGuard<'static, ()> {
    CLOCK_LOCK.lock().unwrap_or_else(|poisoned| {
        CLOCK_LOCK.clear_poison();
        poisoned.into_inner()
    })
}

fn image_path() -> PathBuf {
    let p = std::env::var_os("P2_IMAGE")
        .filter(|p| !p.is_empty())
        .map_or_else(
            || {
                PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                    .join("../../Firmware/MaDCore/.pio/build/propeller2_debug/program")
            },
            PathBuf::from,
        );
    if !p.exists() && std::env::var_os("MAD_REQUIRE_P2_IMAGE").is_some() {
        panic!(
            "MAD_REQUIRE_P2_IMAGE is set but the P2 image is missing at {}. \
             Build it with `make p2image` (or `cd Firmware/MaDCore && pio run -e propeller2_debug`).",
            p.display()
        );
    }
    p
}

// ============================================================
// The host: a requester on the board's clock
// ============================================================

/// xorshift64*: reproducible delays without a dependency.
fn next_random(state: &mut u64) -> u64 {
    *state ^= *state >> 12;
    *state ^= *state << 25;
    *state ^= *state >> 27;
    state.wrapping_mul(0x2545_F491_4F6C_DD1D)
}

/// Whether `frame`, a device frame from its sync byte on, is whole: three
/// bytes for an ACK or NACK, header + length + payload + CRC for DATA and
/// NOTIFICATION. Anything else is not a frame, so it ends here too.
fn frame_complete(frame: &[u8]) -> bool {
    match frame {
        [_, 0x00 | 0x01, _] => true,
        [_, 0x02 | 0x03, _, lo, hi, ..] => {
            frame.len() == 6 + usize::from(u16::from_le_bytes([*lo, *hi]))
        }
        [_, 0x00..=0x03, ..] | [_] | [] => false,
        _ => true,
    }
}

#[derive(Debug)]
struct Run {
    rng: u64,
    parser: FrameParser,
    /// The device frame arriving now, from its sync byte; empty between
    /// frames.
    frame: Vec<u8>,
    /// When the requests not yet sent go out.
    sends: Vec<u64>,
    /// Requests sent and not yet answered or given up on, oldest first.
    outstanding: VecDeque<u64>,
    sent: usize,
    answered: usize,
    lost: usize,
    /// Requests that went out while a reply was arriving.
    sent_mid_reply: usize,
    /// Other frames the firmware sent (NACKs, notifications).
    other: Vec<ParsedFrame>,
    framing_errors: usize,
    started: bool,
    done: bool,
}

impl Run {
    fn new() -> Self {
        Self {
            rng: SEED,
            parser: FrameParser::new(),
            frame: Vec::new(),
            sends: Vec::new(),
            outstanding: VecDeque::new(),
            sent: 0,
            answered: 0,
            lost: 0,
            sent_mid_reply: 0,
            other: Vec::new(),
            framing_errors: 0,
            started: false,
            done: false,
        }
    }

    /// Plan one more request a random `spread` after `from`, if one is owed.
    fn plan(&mut self, from: u64, spread: u64, io: &ComponentNetIo) {
        if self.sent + self.sends.len() == REQUESTS {
            return;
        }
        let at = from + next_random(&mut self.rng) % spread + 1;
        self.sends.push(at);
        io.schedule_at_ns(at);
    }

    fn on_frames(&mut self, frames: Vec<Result<u8, FramingError>>, now: u64, io: &ComponentNetIo) {
        for frame in frames {
            let Ok(byte) = frame else {
                self.framing_errors += 1;
                continue;
            };
            // The firmware's first byte (the transmit pin coming up) starts
            // the run: the first requests at random points of one tick.
            if !self.started {
                self.started = true;
                for _ in 0..IN_FLIGHT {
                    self.plan(now + SETTLE_NS, TICK_NS, io);
                }
            }
            if !self.frame.is_empty() || byte == 0x55 {
                self.frame.push(byte);
            }
            if self.frame == [0x55, 0x02, READ_SAMPLE] {
                // A reply has started: the next request goes out somewhere
                // across the rest of the batch or after it.
                self.plan(now, SPREAD_NS, io);
            }
            if frame_complete(&self.frame) {
                self.frame.clear();
            }
            match self.parser.feed(byte) {
                None => {}
                Some(ParsedFrame::Data {
                    command: READ_SAMPLE,
                    ..
                }) => {
                    self.answered += 1;
                    self.outstanding.pop_front();
                }
                Some(other) => self.other.push(other),
            }
        }
    }

    fn on_wake(&mut self, now: u64, bridge: &SerialLevelBridge, io: &ComponentNetIo) {
        let due = self.sends.iter().filter(|&&at| at <= now).count();
        self.sends.retain(|&at| at > now);
        for _ in 0..due {
            if !self.frame.is_empty() {
                self.sent_mid_reply += 1;
            }
            bridge.transmit(&build_read_frame(READ_SAMPLE));
            self.sent += 1;
            self.outstanding.push_back(now);
            io.schedule_at_ns(now + REPLY_TIMEOUT_NS);
        }
        // Replies come back in order, so only the oldest can be overdue. A
        // lost request is replaced, so the window stays full.
        while self
            .outstanding
            .front()
            .is_some_and(|&at| now >= at + REPLY_TIMEOUT_NS)
        {
            self.outstanding.pop_front();
            self.lost += 1;
            self.plan(now, SPREAD_NS, io);
        }
        self.done = self.sent == REQUESTS && self.outstanding.is_empty();
    }
}

#[derive(Debug, Clone)]
struct Requester(Arc<Mutex<Run>>);

impl Requester {
    fn lock(&self) -> MutexGuard<'_, Run> {
        self.0.lock().expect("run state never poisoned")
    }
}

/// A host UART that sends READ_SAMPLE on its own schedule and counts replies.
struct RequesterUart {
    pins: [PinDecl; 2],
    run: Requester,
    shutdown: Arc<AtomicBool>,
}

impl Component for RequesterUart {
    fn pins(&self) -> &[PinDecl] {
        &self.pins
    }

    fn attach(&mut self, io: ComponentNetIo) -> Result<(), AttachError> {
        let bridge = Arc::new(SerialLevelBridge::new(
            UartFraming::new_8n1(PROTO.nominal_baud),
            io.pin("TX")?,
            io.clone(),
            Arc::clone(&self.shutdown),
        ));
        bridge.idle();
        {
            let (run, bridge, rx, arm) = (
                self.run.clone(),
                Arc::clone(&bridge),
                io.pin("RX")?,
                io.clone(),
            );
            io.on_sense("RX", move |sense| {
                let frames = bridge.receive_sense(&rx, &sense);
                run.lock().on_frames(frames, sense.at_ns, &arm);
            })?;
        }
        {
            let (run, arm) = (self.run.clone(), io.clone());
            io.on_wake_ns(move |now| {
                let frames = bridge.service(now);
                let mut run = run.lock();
                run.on_frames(frames, now, &arm);
                run.on_wake(now, &bridge, &arm);
            });
        }
        Ok(())
    }
}

// ============================================================
// The test
// ============================================================

#[test]
fn every_read_sample_request_is_answered() {
    behaviour!(Test {
        id: "protocol.request-burst-at-2mbaud",
        covers: Some("Firmware/MaDCore/src/HAL/P2/HAL_serial.c#HAL_serial_recieveBytes"),
        given: "a host keeping eight live-data requests outstanding on the 2 Mbaud protocol link, each sent at a random moment and at least a quarter of them while the firmware is still sending earlier replies",
    });
    expect!(
        "every-request-answered",
        "the firmware sends one live-data reply for every request",
        "the app waits for each reply before it asks again, so an unanswered request freezes the live data for two seconds"
    );
    expect!(
        "no-byte-overwritten",
        "every request byte is read off the receive pin before the next byte arrives",
        "the receive pin holds a single byte, and the next one replaces it a byte time later: 5 microseconds at 2 Mbaud"
    );

    let Ok(image) = std::fs::read(image_path()) else {
        eprintln!(
            "\n*** SKIPPED: {} needs the P2 image at\n***   {}\n*** Build it with `make p2image` (or `cd ../Firmware/MaDCore && pio run -e propeller2_debug`).\n*** This test asserted NOTHING.\n",
            module_path!(),
            image_path().display()
        );
        return;
    };
    let _g = lock_clock();
    virtual_clock::init(0.0, 160_000_000);

    let iss = P2Iss::new(&image, p2core::SdCard::blank(32 * 1024 * 1024), &[PROTO]);
    let handle = iss.handle();
    let run = Requester(Arc::new(Mutex::new(Run::new())));
    let host = RequesterUart {
        pins: [
            PinDecl::digital_out("TX"),
            PinDecl::digital_in("RX", jesd8c01_lvcmos_thresholds(DeadBand::Unknown)),
        ],
        run: run.clone(),
        shutdown: Arc::new(AtomicBool::new(false)),
    };

    let system = System::new()
        .component("P2", Box::new(iss))
        .component("HOST", Box::new(host))
        .harness(
            Harness::new()
                .connect_str("P2.P55", "HOST.RX")
                .expect("endpoints parse")
                .connect_str("HOST.TX", "P2.P53")
                .expect("endpoints parse"),
        )
        .start()
        .expect("the ISS system starts");

    let started = Instant::now();
    let mut said = Instant::now();
    while !run.lock().done && started.elapsed() < Duration::from_secs(240) {
        std::thread::sleep(Duration::from_millis(20));
        if said.elapsed() > Duration::from_secs(10) {
            said = Instant::now();
            let r = run.lock();
            eprintln!(
                "[rx-overrun] {:.0?}: guest {} us, virtual {} us, {} cogs; {} sent, {} answered, {} lost; bytes {:?}; overruns {}",
                started.elapsed(),
                handle.guest_now_us(),
                virtual_clock::virtual_us(),
                handle.running_cogs(),
                r.sent,
                r.answered,
                r.lost,
                handle.byte_counts(),
                handle.rx_overruns(PROTO.rx_pin),
            );
        }
    }
    let wall = started.elapsed();
    system.shutdown();

    let run = run.lock();
    let overruns = handle.rx_overruns(PROTO.rx_pin);
    let (tx, rx) = handle.byte_counts();
    println!(
        "[rx-overrun] {} sent ({} mid-reply), {} answered, {} lost; {overruns} bytes overwritten \
         on P{}; {tx} bytes out, {rx} in; {} other frames, {} framing errors; \
         {} virtual us in {wall:.1?}",
        run.sent,
        run.sent_mid_reply,
        run.answered,
        run.lost,
        PROTO.rx_pin,
        run.other.len(),
        run.framing_errors,
        virtual_clock::virtual_us(),
    );

    if !run.done || run.lost > 0 {
        eprintln!("[rx-overrun] console:\n{}", handle.console());
    }
    assert!(
        run.done,
        "the run must finish: {} of {REQUESTS} requests sent in {wall:.1?} (firmware booted: {})",
        run.sent,
        handle.derived_baud(PROTO.tx_pin).is_some()
    );
    // The condition the test claims: requests really did land on top of
    // replies. A change to the firmware's timing that stopped that would turn
    // this test into a stop-and-wait one that proves nothing.
    assert!(
        run.sent_mid_reply * 4 >= REQUESTS,
        "at least a quarter of the requests must go out while a reply is arriving; {} did",
        run.sent_mid_reply
    );
    assert_eq!(
        (run.answered, run.lost),
        (REQUESTS, 0),
        "every request must be answered; other frames from the firmware: {:?}",
        run.other
    );
    assert_eq!(
        overruns, 0,
        "no request byte may be overwritten on the receive pin before the firmware reads it"
    );
}
