//! The ISS's protocol link, carried as edges on a real net.
//!
//! This is step 6 of `docs/dev/sil-lossless-net-transport.md`, and the claim it
//! makes is narrow but load-bearing: **the ISS needs no byte→level synthesis**.
//! The native backend has to be *told* a baud rate, because
//! `HAL_serial_transmitData` hands it a byte and nothing ever computed a bit
//! period. The ISS executes `WRPIN`/`WXPIN`/`WYPIN` against a smart pin, so the
//! rate on the wire is derived from the divisor the firmware wrote and the
//! `clkfreq` it recorded.
//!
//! So the assertions here are not "a byte arrived". They are:
//!
//! 1. the firmware's reply reaches the peer as **decoded frames**, not bytes
//!    handed across;
//! 2. the rate it framed at is the one the firmware *programmed*, not the one
//!    the test declared.
//!
//! Skipped when the firmware artifact is absent, like `p2core`'s own
//! acceptance tests — this needs the real flexcc image, not a fixture.

use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use rstest::rstest;

use embsim_board::uart::UartFraming;
use embsim_board::{
    AttachError, Component, ComponentNetIo, Harness, PinDecl, PinKind, SerialLevelBridge, System,
};
use embsim_core::virtual_clock;
use p2iss::{P2Iss, SerialLink};

/// The MaD protocol link, as the firmware programs it: RX on P53, TX on P55,
/// 2,000,000 baud — one bit is 500 ns.
const PROTO: SerialLink = SerialLink {
    tx_pin: 55,
    rx_pin: 53,
    nominal_baud: 2_000_000,
};

/// The virtual clock is process-global; these tests take it one at a time.
static CLOCK_LOCK: Mutex<()> = Mutex::new(());

fn lock_clock() -> MutexGuard<'static, ()> {
    CLOCK_LOCK.lock().unwrap_or_else(|poisoned| {
        CLOCK_LOCK.clear_poison();
        poisoned.into_inner()
    })
}

fn image_path() -> PathBuf {
    // A missing image makes every test in this file skip. That is right for a
    // laptop that has not run `make p2image`, and wrong for CI: a job meant to
    // exercise the FlexC-compiled firmware would report green while asserting
    // nothing, which is how this suite once reported 54 passed on an empty run.
    // MAD_REQUIRE_P2_IMAGE turns the skip into a failure wherever the image is
    // supposed to exist.
    let p = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../Firmware/MaDCore/.pio/build/propeller2_debug/program");
    if !p.exists() && std::env::var_os("MAD_REQUIRE_P2_IMAGE").is_some() {
        panic!(
            "MAD_REQUIRE_P2_IMAGE is set but the P2 image is missing at {}. \
             Build it with `make p2image` (or `cd Firmware/MaDCore && pio run -e propeller2_debug`).",
            p.display()
        );
    }
    p
}

fn firmware_image() -> Option<Vec<u8>> {
    std::fs::read(image_path()).ok()
}

fn wait_for(mut pred: impl FnMut() -> bool, timeout: Duration) -> bool {
    let start = Instant::now();
    while start.elapsed() < timeout {
        if pred() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(1));
    }
    pred()
}

// ============================================================
// The host: a UART that speaks only edges
// ============================================================

/// The peer uses the shared [`SerialLevelBridge`] deliberately.
///
/// An earlier revision hand-rolled its bit clock to keep the peer independent
/// of the code under test. That is the wrong independence to buy here: the
/// subject is the *ISS adapter*, not the codec, and a hand-rolled clock
/// promptly reintroduced the late-wake bug the bridge already fixes — a wake
/// that lands after its deadline clocked the rest of a byte out at one
/// instant. The codec is checked against something it did not produce in
/// embsim's own `board/tests/serial_levels.rs`; here it is a dependency.
#[derive(Debug, Default)]
struct HostState {
    /// Every frame the host deframed off the wire, good and bad.
    frames: Vec<Result<u8, embsim_board::FramingError>>,
    bridge: Option<Arc<SerialLevelBridge>>,
}

#[derive(Debug, Clone, Default)]
struct Host(Arc<Mutex<HostState>>);

impl Host {
    fn lock(&self) -> MutexGuard<'_, HostState> {
        self.0.lock().expect("host state never poisoned")
    }

    fn send(&self, bytes: &[u8]) {
        let bridge = self
            .lock()
            .bridge
            .clone()
            .expect("the host must be attached before it can transmit");
        bridge.transmit(bytes);
    }

    fn received(&self) -> Vec<u8> {
        self.lock()
            .frames
            .iter()
            .filter_map(|f| f.as_ref().ok().copied())
            .collect()
    }

    fn frames(&self) -> Vec<Result<u8, embsim_board::FramingError>> {
        self.lock().frames.clone()
    }
}

/// Two plain digital pins and a codec — no stream role anywhere.
struct HostUart {
    pins: [PinDecl; 2],
    framing: UartFraming,
    state: Host,
    shutdown: Arc<AtomicBool>,
}

impl HostUart {
    fn new(framing: UartFraming, state: Host) -> Self {
        Self {
            pins: [
                PinDecl {
                    number: "TX",
                    name: None,
                    kind: PinKind::DigitalOut,
                    stream: None,
                    drive_impedance: None,
                },
                PinDecl {
                    number: "RX",
                    name: None,
                    kind: PinKind::DigitalIn,
                    stream: None,
                    drive_impedance: None,
                },
            ],
            framing,
            state,
            shutdown: Arc::new(AtomicBool::new(false)),
        }
    }
}

impl Component for HostUart {
    fn pins(&self) -> &[PinDecl] {
        &self.pins
    }

    fn attach(&mut self, io: ComponentNetIo) -> Result<(), AttachError> {
        let bridge = Arc::new(SerialLevelBridge::new(
            self.framing,
            io.pin("TX")?,
            io.clone(),
            Arc::clone(&self.shutdown),
        ));
        // An idle asynchronous line still drives: without it the ISS has no
        // reference against which the first start bit is a falling edge.
        bridge.idle();
        self.state.lock().bridge = Some(Arc::clone(&bridge));

        {
            let (state, bridge) = (self.state.clone(), Arc::clone(&bridge));
            io.on_sense("RX", move |net_state| {
                let frames = bridge.receive_sense(net_state);
                state.lock().frames.extend(frames);
            })?;
        }
        {
            let state = self.state.clone();
            io.on_wake_ns(move |now_ns| {
                let frames = bridge.service(now_ns);
                state.lock().frames.extend(frames);
            });
        }
        Ok(())
    }
}

// ============================================================
// The test
// ============================================================

/// SYNC + READ + READ_FIRMWARE_VERSION goes in as edges; the firmware's reply
/// comes back as edges, and the rate is the one the firmware programmed.
#[rstest]
fn the_iss_answers_the_protocol_over_a_wire() {
    let Some(image) = firmware_image() else {
        eprintln!(
            "\n*** SKIPPED: {} needs the P2 image at\n***   {}\n*** Build it with `make p2image` (or `cd ../Firmware/MaDCore && pio run -e propeller2_debug`).\n*** This test asserted NOTHING.\n",
            module_path!(),
            image_path().display()
        );
        return;
    };
    let _g = lock_clock();
    virtual_clock::init(0.0, 160_000_000);

    let host = Host::default();
    let framing = UartFraming::new_8n1(PROTO.nominal_baud);

    let iss = P2Iss::new(&image, p2core::SdCard::blank(32 * 1024 * 1024), &[PROTO]);
    let iss_handle = iss.handle();

    let system = System::new()
        .component("P2", Box::new(iss))
        .component("HOST", Box::new(HostUart::new(framing, host.clone())))
        .harness(
            Harness::new()
                .connect_str("P2.P55", "HOST.RX")
                .expect("endpoints parse")
                .connect_str("HOST.TX", "P2.P53")
                .expect("endpoints parse"),
        )
        .start()
        .expect("the ISS system starts");

    // The firmware boots, brings up its cogs and configures its smart pins.
    // A derived baud is the signal that it got that far: the bridge is built
    // on the guest's first transmit, from the pin's own configuration.
    assert!(
        wait_for(
            || iss_handle.derived_baud(PROTO.tx_pin).is_some(),
            Duration::from_secs(60)
        ),
        "the firmware must configure and use its transmit pin (clkfreq {}, {} cogs)",
        iss_handle.clkfreq(),
        iss_handle.running_cogs()
    );

    // [SYNC, READ, READ_FIRMWARE_VERSION] — the generated runtime's request.
    host.send(&[0x55, 0x00, 0x03]);

    // The reply's header: SYNC, a data frame, and the command it answers.
    // Not asserted as a prefix of the stream — the firmware transmits before
    // the request too, and this test is about the wire, not the protocol.
    const REPLY: [u8; 3] = [0x55, 0x02, 0x03];
    let arrived = wait_for(
        || host.received().windows(REPLY.len()).any(|w| w == REPLY),
        Duration::from_secs(60),
    );
    let frames = host.frames();
    assert!(
        arrived,
        "the firmware's reply must reach the host as decoded frames; got {:02X?}",
        host.received()
    );

    // Every frame that crossed decoded cleanly. A stop-bit failure here would
    // mean the two ends disagree about the rate — which is exactly what this
    // path exists to be able to say.
    assert!(
        frames.iter().all(|f| f.is_ok()),
        "every frame on the wire must decode; got {frames:?}"
    );

    // The point of running an ISS: the rate on the wire is the firmware's own.
    // 2,000,000 baud at 160 MHz is 80 clocks exactly, so this is not a
    // rounding-tolerance assertion — it is the number the firmware computed
    // from the divisor it wrote and the clkfreq it recorded.
    assert_eq!(
        iss_handle.derived_baud(PROTO.tx_pin),
        Some(PROTO.nominal_baud),
        "the wire must clock at the rate the firmware programmed \
         (clkfreq {}, {} cogs running)",
        iss_handle.clkfreq(),
        iss_handle.running_cogs()
    );

    let (tx, rx) = iss_handle.byte_counts();
    println!(
        "[iss] {} guest us in {} virtual us; {tx} bytes framed out, {rx} deframed in, \
         {} decoded by the host at {} baud",
        iss_handle.guest_now_us(),
        virtual_clock::virtual_us(),
        host.received().len(),
        iss_handle.derived_baud(PROTO.tx_pin).unwrap_or(0),
    );

    system.shutdown();
}
