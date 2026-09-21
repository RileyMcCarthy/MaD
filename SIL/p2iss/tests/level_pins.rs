//! A P2 pin on a net, in both directions.
//!
//! This is the general seam. Everything the firmware does with a pin that is
//! not an async UART frame — GPIO, the endstops, the encoder's A/B channels,
//! the SD card's SPI — is a *level*, and a level is what a net resolves. There
//! is no second mechanism: the guest's `DIR`/`OUT` writes become a Thevenin
//! drive, and whatever the net resolves becomes the guest's `INA`/`INB`.
//!
//! The pin under test is `HW_PIN_ENDSTOP_UPPER` (P19), chosen because the
//! firmware leaves it an input: it is exactly the case that used to be
//! invisible, since `PinBus::ina` returned a constant zero and every endstop
//! read low no matter what was on the wire.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use embsim_board::{
    digital_drive, AttachError, Component, ComponentNetIo, Harness, Level, PinDecl, PinKind, System,
};
use embsim_core::virtual_clock;
use p2iss::{P2Iss, SerialLink};

/// The protocol link, declared so the machine boots the way it does elsewhere.
const PROTO: SerialLink = SerialLink {
    tx_pin: 55,
    rx_pin: 53,
    nominal_baud: 2_000_000,
};

/// `HW_PIN_ENDSTOP_UPPER`.
const ENDSTOP_UPPER: u8 = 19;

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

/// A switch: one output pin, driven from the test thread.
struct Switch {
    pins: Vec<PinDecl>,
    closed: Arc<AtomicBool>,
    io: Arc<Mutex<Option<ComponentNetIo>>>,
}

impl Switch {
    fn new(closed: Arc<AtomicBool>) -> Self {
        Self {
            pins: vec![PinDecl {
                number: "OUT",
                name: None,
                kind: PinKind::DigitalOut,
                stream: None,
                drive_impedance: None,
            }],
            closed,
            io: Arc::new(Mutex::new(None)),
        }
    }
}

impl Component for Switch {
    fn pins(&self) -> &[PinDecl] {
        &self.pins
    }

    fn attach(&mut self, io: ComponentNetIo) -> Result<(), AttachError> {
        let handle = io.pin("OUT")?;
        let closed = Arc::clone(&self.closed);
        *self.io.lock().expect("io never poisoned") = Some(io.clone());
        // Re-drive on every tick: the test flips `closed` from outside the
        // engine, and this is the cheapest way to let it in without a
        // component-specific command channel.
        io.on_wake_ns(move |_now| {
            handle.set_drive(Some(digital_drive(if closed.load(Ordering::Relaxed) {
                Level::High
            } else {
                Level::Low
            })));
        });
        io.schedule_every_ns(50_000);
        Ok(())
    }
}

/// A net's resolved level reaches the guest's pin, and follows it when it
/// changes.
#[test]
fn a_net_drives_a_guest_input_pin() {
    let Ok(image) = std::fs::read(image_path()) else {
        eprintln!(
            "\n*** SKIPPED: {} needs the P2 image at\n***   {}\n*** Build it with `make p2image`.\n*** This test asserted NOTHING.\n",
            module_path!(),
            image_path().display()
        );
        return;
    };
    let _g = lock_clock();
    virtual_clock::init(0.0, 160_000_000);

    let closed = Arc::new(AtomicBool::new(false));
    let iss =
        P2Iss::new(&image, p2core::SdCard::blank(0), &[PROTO]).with_level_pins(&[ENDSTOP_UPPER]);
    let handle = iss.handle();

    let _system = System::new()
        .component("P2", Box::new(iss))
        .component("SW", Box::new(Switch::new(Arc::clone(&closed))))
        .harness(
            Harness::new()
                .connect_str("P2.P19", "SW.OUT")
                .expect("endpoints parse"),
        )
        .start()
        .expect("the ISS system starts");

    // Liveness first. Every assertion below reads state the wake handler
    // maintains, and a guest that trapped on its first slice stops waking —
    // so without this the whole test could pass against a dead machine.
    assert!(
        wait_for(|| handle.running_cogs() > 1, Duration::from_secs(60)),
        "the guest must actually be executing; it has {} cogs running",
        handle.running_cogs()
    );
    assert!(
        !handle.input_level(ENDSTOP_UPPER),
        "an open switch must read low at the guest's pin"
    );

    closed.store(true, Ordering::Relaxed);
    assert!(
        wait_for(
            || handle.input_level(ENDSTOP_UPPER),
            Duration::from_secs(30)
        ),
        "closing the switch must reach the guest's pin — this is the path that \
         did not exist: `PinBus::ina` returned a constant 0, so every endstop \
         read low whatever was on the wire"
    );

    closed.store(false, Ordering::Relaxed);
    assert!(
        wait_for(
            || !handle.input_level(ENDSTOP_UPPER),
            Duration::from_secs(30)
        ),
        "and it must follow the net back down"
    );
}

// ============================================================
// Transitions, not levels
// ============================================================

/// `HW_PIN_SERVO_ENCODER_A` / `_B`.
const ENC_A: u8 = 9;
const ENC_B: u8 = 10;

/// An encoder walking its Gray sequence far faster than the guest's slice.
struct Spinner {
    pins: Vec<PinDecl>,
    count: Arc<Mutex<i64>>,
}

impl Spinner {
    fn new(count: Arc<Mutex<i64>>) -> Self {
        Self {
            pins: vec![
                PinDecl {
                    number: "A",
                    name: None,
                    kind: PinKind::DigitalOut,
                    stream: None,
                    drive_impedance: None,
                },
                PinDecl {
                    number: "B",
                    name: None,
                    kind: PinKind::DigitalOut,
                    stream: None,
                    drive_impedance: None,
                },
            ],
            count,
        }
    }
}

impl Component for Spinner {
    fn pins(&self) -> &[PinDecl] {
        &self.pins
    }

    fn attach(&mut self, io: ComponentNetIo) -> Result<(), AttachError> {
        let a = io.pin("A")?;
        let b = io.pin("B")?;
        let count = Arc::clone(&self.count);
        io.on_wake_ns(move |_now| {
            let mut n = count.lock().expect("count never poisoned");
            *n += 1;
            // The same Gray order the encoder model and `p2core` agree on:
            // (0,0) (1,0) (1,1) (0,1). Exactly one channel changes per step.
            let (la, lb) = match n.rem_euclid(4) {
                0 => (false, false),
                1 => (true, false),
                2 => (true, true),
                _ => (false, true),
            };
            a.set_drive(Some(digital_drive(if la {
                Level::High
            } else {
                Level::Low
            })));
            b.set_drive(Some(digital_drive(if lb {
                Level::High
            } else {
                Level::Low
            })));
        });
        // One step every microsecond — a hundred per 100 µs guest slice, so
        // every step but the last happens *between* two slices. A level
        // snapshot would see one phase change per slice and count ~1 % of
        // them, most of those as unrecoverable two-state jumps.
        io.schedule_every_ns(1_000);
        Ok(())
    }
}

/// Every transition reaches the guest's decoder, in order, even when a hundred
/// of them fall inside one slice.
#[test]
fn transitions_between_slices_are_not_collapsed() {
    let Ok(image) = std::fs::read(image_path()) else {
        eprintln!(
            "\n*** SKIPPED: {} needs the P2 image at\n***   {}\n*** Build it with `make p2image`.\n*** This test asserted NOTHING.\n",
            module_path!(),
            image_path().display()
        );
        return;
    };
    let _g = lock_clock();
    virtual_clock::init(0.0, 160_000_000);

    let steps = Arc::new(Mutex::new(0i64));
    let iss =
        P2Iss::new(&image, p2core::SdCard::blank(0), &[PROTO]).with_level_pins(&[ENC_A, ENC_B]);
    let handle = iss.handle();

    let _system = System::new()
        .component("P2", Box::new(iss))
        .component("ENC", Box::new(Spinner::new(Arc::clone(&steps))))
        .harness(
            Harness::new()
                .connect_str("P2.P9", "ENC.A")
                .expect("endpoints parse")
                .connect_str("P2.P10", "ENC.B")
                .expect("endpoints parse"),
        )
        .start()
        .expect("the ISS system starts");

    // The firmware configures P9 as a quadrature smart pin during boot; until
    // it does, there is no counter to read.
    assert!(
        wait_for(
            || handle.encoder_count(ENC_A).is_some(),
            Duration::from_secs(60)
        ),
        "the firmware must configure its encoder pin (cogs running: {})",
        handle.running_cogs()
    );

    assert!(
        wait_for(
            || handle.encoder_count(ENC_A).unwrap_or(0).abs() > 200,
            Duration::from_secs(60)
        ),
        "the guest's counter must follow the wire; it reached {:?} after {} steps",
        handle.encoder_count(ENC_A),
        *steps.lock().expect("count never poisoned")
    );

    assert_eq!(
        handle.encoder_slips(ENC_A),
        0,
        "no transition may arrive folded with another — a two-state jump has \
         no recoverable direction, and a snapshot-per-slice produces nothing else"
    );
    assert_eq!(
        handle.edges_dropped(),
        0,
        "no transition may be dropped for want of queue space"
    );
}
