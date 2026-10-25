//! Every live-data request the firmware receives at 2 Mbaud is answered, on
//! the P2-EC32MB module with the instruction-set simulator inside its P2
//! package: the package route's twin of `protocol_rx_overrun.rs`.
//!
//! The module of `ec32mb_flash_boot.rs` — the vendor netlist, powered from
//! its `J203` fingers, `S301` set to boot from flash, [`P2IssCore`] inside
//! [`P2Package`] — with the production firmware (`pio run -e propeller2`) in
//! its flash, the firmware's FAT16 card in its socket, and a host on the two
//! fingers the production build's protocol uses: `P63` (`J203` pin 49) into
//! the chip and `P62` (pin 50) out of it, the pair the Edge carrier's `J1`
//! carries. This is the route the project files run (`SIL/mad.toml`).
//!
//! The protocol's receive pin holds ONE byte, and the next byte overwrites
//! it 800 clocks later at 2 Mbaud and 160 MHz. A firmware that polls the pin
//! leaves it unread for longer than that between two receive calls, and for
//! a byte time per byte it sends: the production build sends through
//! flexspin's built-in serial, which waits out every byte's frame. So the
//! host keeps eight READ_SAMPLE requests in flight, each sent at a random
//! moment, many of them while the firmware is still sending replies, and
//! requires a reply to every request and no byte overwritten on the pin.
//!
//! Inside the package the simulated chip runs ahead of the board, so each
//! byte lands in the chip's present with the wire's spacing kept
//! (`p2iss/src/package.rs`, "Receive: one byte, landed in the guest's
//! present"): an overwritten byte is the firmware's own read gap. The
//! polling build before HAL_serial.c took RX by interrupt fails here.
//!
//! The run starts as the app does: the host asks once stage-1 has streamed
//! the program, again every 20 ms until the firmware first answers, waits
//! 30 ms for any late answer to its retries, and only
//! then starts the burst, from which it counts. Deterministic: every instant
//! is the board's, and the delays come from a fixed seed.
//!
//! `MAD_P2_PRODUCTION_IMAGE=path` runs it against another production build.
//! Skipped when the image is absent (`MAD_REQUIRE_P2_IMAGE` makes that a
//! failure).

use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use embsim_board::uart::UartFraming;
use embsim_board::{
    jesd8c01_lvcmos_thresholds, AttachError, Component, ComponentNetIo, DeadBand, EndpointRef,
    FramingError, Harness, JumperState, PinDecl, Scenario, SerialLevelBridge, System,
};
use embsim_boards::ec32mb::{Ec32mb, FLASH_SELECT_POLE, FLASH_SELECT_SWITCH, P59_PULL_DOWN_POLE};
use embsim_boards::p2::{P2Package, P2_RESTART_DELAY_NS};
use embsim_core::virtual_clock;
use embsim_models::sd_card::SdCard;
use p2iss::{sdimage, P2IssCore, P2IssHandle};
use protoemb_framing::{build_read_frame, FrameParser, ParsedFrame};
use vibes_behaviour::{behaviour, expect, Test};

/// The production build's protocol pins (`HW_pins.h`, `HAL_serial_config.c`).
const RX_PIN: u8 = 63;
const BAUD: u32 = 2_000_000;

/// The START instant: the module's reset releases at 2.5 ms (the AP62301
/// bucks' soft-start) and the chip starts 3 ms after.
const START_NS: u64 = 2_500_000 + P2_RESTART_DELAY_NS;

/// Board time stage-1 takes a byte of the program, with room: it streams the
/// flash at about 3.84 µs a byte (`mad-catalog/tests/boot.rs`, measured).
const STAGE1_NS_PER_BYTE: u64 = 4_000;

/// The card's capacity: what `make sd-image` writes.
const CARD_BYTES: usize = 32 * 1024 * 1024;

/// `sample`'s command id in `Protocol/MaDProtocol.yaml`.
const READ_SAMPLE: u8 = 0;
/// Requests in the burst.
const REQUESTS: usize = 24;
/// Requests the host keeps outstanding. The firmware answers in batches, once
/// per pass of its communication task, and transmits a batch back to
/// back: eight replies are a millisecond of the transmitter running.
const IN_FLIGHT: usize = 8;
/// While the firmware has not answered, the host asks again this often, as
/// the app's runtime does after a timeout.
const RETRY_NS: u64 = 20_000_000;
/// The window the burst's first requests spread over.
const TICK_NS: u64 = 10_000_000;
/// After the first answer, time for any late answer to a retry.
const QUIET_NS: u64 = 3 * TICK_NS;
/// Each reply that starts plans the next request this long after it, drawn
/// uniformly. A sample reply is 26 bytes, 130 us on the wire, so many land
/// while the batch is still being transmitted and the rest at arbitrary
/// points of the firmware's loop.
const SPREAD_NS: u64 = 400_000;
/// A request with no reply after 30 ms is lost.
const REPLY_TIMEOUT_NS: u64 = 30_000_000;
const SEED: u64 = 0x5EED_2B0D_1E55_0001;

/// Board time the whole run is given: the boot (stage-1 streams the
/// 300 KB program in about 1.2 s), the firmware's start-up and the burst.
const BOARD_BUDGET_NS: u64 = 5_000_000_000;
/// Host time without any board time passing that ends the run: the engine
/// or the host stopped, which is no verdict on the firmware.
const STALL_WALL: Duration = Duration::from_secs(300);

fn ep(endpoint: &str) -> EndpointRef {
    EndpointRef::parse(endpoint).expect("endpoint parses")
}

fn rom(name: &str) -> Option<Vec<u8>> {
    std::fs::read(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("rom")
            .join(name),
    )
    .ok()
}

/// The production program: `MAD_P2_PRODUCTION_IMAGE` names a copy kept out
/// of `.pio` (the CI job's) or another build, else the build's own.
fn image_path() -> PathBuf {
    let p = std::env::var_os("MAD_P2_PRODUCTION_IMAGE")
        .filter(|p| !p.is_empty())
        .map_or_else(
            || {
                PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                    .join("../../Firmware/MaDCore/.pio/build/propeller2/program")
            },
            PathBuf::from,
        );
    if !p.exists() && std::env::var_os("MAD_REQUIRE_P2_IMAGE").is_some() {
        panic!(
            "MAD_REQUIRE_P2_IMAGE is set but the production P2 image is missing at {}. \
             Build it with `make p2image-production` (or `cd Firmware/MaDCore && pio run -e \
             propeller2`).",
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

/// Where the host is in the run.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Phase {
    /// Asking until the firmware first answers; the next ask is due then.
    Asking { next_ask: u64 },
    /// Answered; late answers to retries drain until then.
    Quiet { until: u64 },
    /// The burst the test counts.
    Burst,
}

#[derive(Debug)]
struct Run {
    phase: Phase,
    rng: u64,
    parser: FrameParser,
    /// The device frame arriving now, from its sync byte; empty between
    /// frames.
    frame: Vec<u8>,
    /// When the burst's requests not yet sent go out.
    sends: Vec<u64>,
    /// Burst requests sent and not yet answered or given up on, oldest first.
    outstanding: VecDeque<u64>,
    asks: usize,
    sent: usize,
    answered: usize,
    lost: usize,
    /// Burst requests that went out while a reply was arriving.
    sent_mid_reply: usize,
    /// The board instant the burst started, and the receive pin's overwrite
    /// count then.
    burst_from: Option<(u64, u64)>,
    /// Other frames the firmware sent during the burst (NACKs, notifications).
    other: Vec<ParsedFrame>,
    framing_errors: usize,
    done: bool,
}

impl Run {
    fn new(first_ask: u64) -> Self {
        Self {
            phase: Phase::Asking {
                next_ask: first_ask,
            },
            rng: SEED,
            parser: FrameParser::new(),
            frame: Vec::new(),
            sends: Vec::new(),
            outstanding: VecDeque::new(),
            asks: 0,
            sent: 0,
            answered: 0,
            lost: 0,
            sent_mid_reply: 0,
            burst_from: None,
            other: Vec::new(),
            framing_errors: 0,
            done: false,
        }
    }

    /// Plan one more burst request a random `spread` after `from`, if one is
    /// owed.
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
            let burst = self.phase == Phase::Burst;
            let Ok(byte) = frame else {
                // Before the burst the line carries the boot and whatever
                // the firmware prints at other rates.
                if burst {
                    self.framing_errors += 1;
                }
                continue;
            };
            if !self.frame.is_empty() || byte == 0x55 {
                self.frame.push(byte);
            }
            if burst && self.frame == [0x55, 0x02, READ_SAMPLE] {
                // A reply has started: the next request goes out somewhere
                // across the rest of the batch or after it.
                self.plan(now, SPREAD_NS, io);
            }
            if frame_complete(&self.frame) {
                self.frame.clear();
            }
            let parsed = self.parser.feed(byte);
            match (self.phase, parsed) {
                (_, None) => {}
                (
                    Phase::Asking { .. },
                    Some(ParsedFrame::Data {
                        command: READ_SAMPLE,
                        ..
                    }),
                ) => {
                    let until = now + QUIET_NS;
                    self.phase = Phase::Quiet { until };
                    io.schedule_at_ns(until);
                }
                (Phase::Asking { .. } | Phase::Quiet { .. }, Some(_)) => {}
                (
                    Phase::Burst,
                    Some(ParsedFrame::Data {
                        command: READ_SAMPLE,
                        ..
                    }),
                ) => {
                    self.answered += 1;
                    self.outstanding.pop_front();
                }
                (Phase::Burst, Some(other)) => self.other.push(other),
            }
        }
    }

    fn on_wake(
        &mut self,
        now: u64,
        bridge: &SerialLevelBridge,
        io: &ComponentNetIo,
        core: &P2IssHandle,
    ) {
        match self.phase {
            Phase::Asking { next_ask } => {
                if now >= next_ask {
                    bridge.transmit(&build_read_frame(READ_SAMPLE));
                    self.asks += 1;
                    let next_ask = now + RETRY_NS;
                    self.phase = Phase::Asking { next_ask };
                    io.schedule_at_ns(next_ask);
                }
                return;
            }
            Phase::Quiet { until } => {
                if now < until {
                    return;
                }
                // The burst: the first requests at random points of a 10 ms window.
                self.phase = Phase::Burst;
                self.burst_from = Some((now, core.rx_overruns(RX_PIN)));
                for _ in 0..IN_FLIGHT {
                    self.plan(now, TICK_NS, io);
                }
            }
            Phase::Burst => {}
        }
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

/// A host UART on the module's protocol fingers that sends READ_SAMPLE on
/// its own schedule and counts replies.
struct RequesterUart {
    pins: [PinDecl; 2],
    run: Requester,
    first_ask: u64,
    core: P2IssHandle,
    shutdown: Arc<AtomicBool>,
}

impl Component for RequesterUart {
    fn pins(&self) -> &[PinDecl] {
        &self.pins
    }

    fn attach(&mut self, io: ComponentNetIo) -> Result<(), AttachError> {
        let bridge = Arc::new(SerialLevelBridge::new(
            UartFraming::new_8n1(BAUD),
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
            let (run, arm, core) = (self.run.clone(), io.clone(), self.core.clone());
            io.on_wake_ns(move |now| {
                let frames = bridge.service(now);
                let mut run = run.lock();
                run.on_frames(frames, now, &arm);
                run.on_wake(now, &bridge, &arm, &core);
            });
        }
        io.schedule_at_ns(self.first_ask);
        Ok(())
    }
}

// ============================================================
// The test
// ============================================================

#[test]
fn every_read_sample_request_is_answered_on_the_module() {
    behaviour!(Test {
        id: "protocol.request-burst-at-2mbaud-on-the-module",
        covers: Some("Firmware/MaDCore/src/HAL/P2/HAL_serial.c#HAL_serial_recieveBytes"),
        given: "the firmware booted off the P2-EC32MB module's flash, with a host on its \
                protocol fingers keeping eight live-data requests outstanding at 2 Mbaud, sent at \
                random moments, at least a quarter during replies",
    });
    expect!(
        "every-request-answered",
        "the firmware sends one live-data reply for every request",
        "the app waits for each reply before it asks again, so an unanswered request freezes \
         the live data for two seconds"
    );
    expect!(
        "no-byte-overwritten",
        "every request byte is read off the receive pin before the next byte arrives",
        "the receive pin holds a single byte, and the next one replaces it a byte time later: \
         5 microseconds at 2 Mbaud"
    );

    let Ok(program) = std::fs::read(image_path()) else {
        eprintln!(
            "\n*** SKIPPED: {} needs the production P2 image at\n***   {}\n*** Build it with \
             `make p2image-production`.\n*** This test asserted NOTHING.\n",
            module_path!(),
            image_path().display()
        );
        return;
    };
    let (Some(boot_rom), Some(stage1)) = (rom("rom_booter_v33k.bin"), rom("stage1.bin")) else {
        eprintln!("\n*** SKIPPED: needs `make bootrom`. Asserted NOTHING.\n");
        return;
    };
    let flash_image = p2iss::flashimage::boot_flash(&stage1, &program).expect("flash image");
    let card = sdimage::mad_card(CARD_BYTES, None).expect("the card image builds");

    virtual_clock::init(0.0, 160_000_000);

    let core = P2IssCore::with_boot_rom(&boot_rom);
    let handle = core.handle();
    let slot = Mutex::new(Some(P2Package::new(core)));
    let board = Ec32mb::new()
        .with_flash_image(flash_image)
        .with_card(SdCard::with_image(card))
        .with_p2(move |_decl| -> Box<dyn Component> {
            Box::new(slot.lock().unwrap().take().expect("one P2 per module"))
        })
        .build()
        .expect("the module builds");

    // The host asks once stage-1 has streamed the program.
    let first_ask = START_NS + program.len() as u64 * STAGE1_NS_PER_BYTE;
    let run = Requester(Arc::new(Mutex::new(Run::new(first_ask))));
    let host = RequesterUart {
        pins: [
            PinDecl::digital_out("TX"),
            PinDecl::digital_in("RX", jesd8c01_lvcmos_thresholds(DeadBand::Unknown)),
        ],
        run: run.clone(),
        first_ask,
        core: handle.clone(),
        shutdown: Arc::new(AtomicBool::new(false)),
    };

    let system = System::new()
        .board("EC32", board)
        .component("HOST", Box::new(host))
        .harness(
            Harness::new()
                // P63/PRG_DBG_RXD and P62/PRG_DBG_TXD, the module's
                // programming-serial fingers.
                .connect_str("HOST.TX", "EC32.J203.49")
                .expect("the receive finger exists")
                .connect_str("EC32.J203.50", "HOST.RX")
                .expect("the transmit finger exists")
                // 5 V into the two `5V` fingers, 0 V into the three `GND`
                // fingers (`p2_ec32mb.net`: 41/42 and 43/44/45).
                .power(ep("CARRIER.5V"), ep("EC32.J203.41"), 5.0)
                .power(ep("CARRIER.5Vb"), ep("EC32.J203.42"), 5.0)
                .power(ep("CARRIER.GND"), ep("EC32.J203.43"), 0.0)
                .power(ep("CARRIER.GNDb"), ep("EC32.J203.44"), 0.0)
                .power(ep("CARRIER.GNDc"), ep("EC32.J203.45"), 0.0),
        )
        .scenario(
            Scenario::default()
                // S301 position 2 (FLASH): P61 reaches the flash's ~CS.
                .switch(
                    &format!("EC32.{FLASH_SELECT_SWITCH}"),
                    FLASH_SELECT_POLE,
                    JumperState::Closed,
                )
                // S301 position 4: R303 pulls P59 down, so the ROM boots
                // what the flash holds.
                .switch(
                    &format!("EC32.{FLASH_SELECT_SWITCH}"),
                    P59_PULL_DOWN_POLE,
                    JumperState::Closed,
                ),
        )
        .start()
        .expect("the system starts");

    // Wait on board time, with a watchdog on host time for a run whose board
    // time has stopped moving.
    let wall = Instant::now();
    let mut said = Instant::now();
    let mut last = (virtual_clock::virtual_ns(), Instant::now());
    loop {
        if run.lock().done || handle.trap().is_some() || handle.stalled() {
            break;
        }
        let board_ns = virtual_clock::virtual_ns();
        if board_ns >= BOARD_BUDGET_NS {
            break;
        }
        if board_ns != last.0 {
            last = (board_ns, Instant::now());
        } else if last.1.elapsed() > STALL_WALL {
            panic!(
                "no board time passed in {STALL_WALL:?} of host time, at board {board_ns} ns \
                 (guest {} ns): the engine or the host stopped, which says nothing about the \
                 firmware",
                handle.guest_now_ns()
            );
        }
        if said.elapsed() > Duration::from_secs(10) {
            said = Instant::now();
            let r = run.lock();
            eprintln!(
                "[package-rx-overrun] {:.0?}: board {} us, guest {} us; {:?}; {} asks, {} sent, \
                 {} answered, {} lost; bytes {:?}; overruns {}",
                wall.elapsed(),
                board_ns / 1_000,
                handle.guest_now_us(),
                r.phase,
                r.asks,
                r.sent,
                r.answered,
                r.lost,
                handle.byte_counts(),
                handle.rx_overruns(RX_PIN),
            );
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    let wall = wall.elapsed();
    let board_ns = virtual_clock::virtual_ns();
    system.shutdown();

    let run = run.lock();
    let overruns = handle.rx_overruns(RX_PIN);
    let (burst_ns, overruns_before) = run.burst_from.unwrap_or_default();
    let (tx, rx) = handle.byte_counts();
    println!(
        "[package-rx-overrun] {} asks; burst from {burst_ns} ns: {} sent ({} mid-reply), {} \
         answered, {} lost; {} bytes overwritten on P{RX_PIN} in the burst ({overruns_before} \
         before it); {tx} bytes out, {rx} in; {} other frames, {} framing errors; board {} us \
         in {wall:.1?}; trap {:?}",
        run.asks,
        run.sent,
        run.sent_mid_reply,
        run.answered,
        run.lost,
        overruns - overruns_before,
        run.other.len(),
        run.framing_errors,
        board_ns / 1_000,
        handle.trap(),
    );

    assert!(
        run.done,
        "the run must finish: {} asks, burst {:?}, {} of {REQUESTS} requests sent in {} us of \
         board time ({wall:.1?}); the firmware transmitting at {:?} baud",
        run.asks,
        run.burst_from,
        run.sent,
        board_ns / 1_000,
        handle.derived_baud(62),
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
        overruns - overruns_before,
        0,
        "no request byte may be overwritten on the receive pin before the firmware reads it"
    );
}
