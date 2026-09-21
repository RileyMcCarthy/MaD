//! The SD card as a component on the wire.
//!
//! The claim under test is not "the firmware mounts" — that is a separate
//! open question — but that **the bus is real**: clock edges cross a net, the
//! card counts them, bytes assemble out of bits, and the card recognises the
//! SPI-mode command sequence the firmware's own driver sends.
//!
//! Until now the SD transfer happened inside `p2core::Board` the instant the
//! guest wrote `WYPIN` to the clock pin. Nothing could sit between the two
//! ends, because there were no bits and no time.

use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, Instant};

use embsim_board::{
    AttachError, Component, ComponentNetIo, Harness, PinDecl, PinKind, System, TheveninDrive,
};
use embsim_core::virtual_clock;
use p2iss::sdnode::SdCardNode;
use p2iss::{P2Iss, SerialLink};

// The MaD SD pins, as FlexC's `_vfs_open_sdcard()` drives them:
// `_vfs_open_sdcardx(pclk = 61, pss = 60, pdi = 59, pdo = 58)`. The ISS no
// longer needs these — it discovers clock/TX/RX from the mode words — but the
// harness still has to wire the four physical nets.
const SD_CLK: u8 = 61;
const SD_CS: u8 = 60;
const SD_MOSI: u8 = 59;
const SD_MISO: u8 = 58;

const PROTO: SerialLink = SerialLink {
    tx_pin: 55,
    rx_pin: 53,
    nominal_baud: 2_000_000,
};

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
        std::thread::sleep(Duration::from_millis(2));
    }
    pred()
}

/// The 15 kΩ pull-up `sdmm.cc` configures on the receive pin, as a bench part.
///
/// Without it a deselected card leaves MISO floating and `disk_initialize`
/// cannot tell "no answer" from "a zero bit" — which is the whole reason the
/// driver asks for `P_HIGH_15K | P_LOW_15K` there.
struct PullUp {
    pins: [PinDecl; 1],
}

impl PullUp {
    fn new() -> Self {
        Self {
            pins: [PinDecl {
                number: "A",
                name: None,
                kind: PinKind::Analog,
                stream: None,
                drive_impedance: None,
            }],
        }
    }
}

impl Component for PullUp {
    fn pins(&self) -> &[PinDecl] {
        &self.pins
    }

    fn attach(&mut self, io: ComponentNetIo) -> Result<(), AttachError> {
        io.pin("A")?.set_drive(Some(TheveninDrive {
            volts: 3.3,
            impedance: 15_000.0,
        }));
        Ok(())
    }
}

#[test]
fn the_card_answers_on_the_wire() {
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

    let card_image = p2iss::sdimage::mad_card(32 * 1024 * 1024, None).expect("card builds");
    let node = SdCardNode::new(p2core::SdCard::with_image(card_image));
    let counters = node.counters();
    let card = node.card();

    // The four SD wires are plain net pins: clock and MOSI are outputs the
    // smart-pin hardware drives, CS is GPIO, MISO is an input. The ISS reads
    // the clock/TX/RX roles from the mode words the firmware programs.
    let iss = P2Iss::new(&image, p2core::SdCard::blank(0), &[PROTO])
        .with_level_pins(&[SD_MOSI, SD_CS, SD_CLK])
        .with_input_pins(&[SD_MISO])
        .with_sync_serial();
    let handle = iss.handle();

    let p = |pin: u8| format!("P2.{}", p2iss::pin_name(pin));
    let _system = System::new()
        .component("P2", Box::new(iss))
        .component("SD", Box::new(node))
        .component("PU", Box::new(PullUp::new()))
        .harness(
            Harness::new()
                .connect_str(&p(SD_CLK), "SD.CLK")
                .expect("endpoints parse")
                .connect_str(&p(SD_CS), "SD.CS")
                .expect("endpoints parse")
                .connect_str(&p(SD_MOSI), "SD.MOSI")
                .expect("endpoints parse")
                .connect_str(&p(SD_MISO), "SD.MISO")
                .expect("endpoints parse")
                .connect_str(&p(SD_MISO), "PU.A")
                .expect("endpoints parse"),
        )
        .start()
        .expect("the ISS system starts");

    assert!(
        wait_for(|| handle.running_cogs() > 1, Duration::from_secs(60)),
        "the guest must be executing"
    );

    // Clock edges crossing a net is the thing that did not exist before.
    assert!(
        wait_for(
            || counters.edges.load(Ordering::Relaxed) > 100,
            Duration::from_secs(90)
        ),
        "the card must see real clock transitions; it saw {}",
        counters.edges.load(Ordering::Relaxed)
    );
    assert!(
        counters.bytes.load(Ordering::Relaxed) > 0,
        "whole bytes must assemble out of those bits"
    );
    let counted = counters.edges.load(Ordering::Relaxed);
    let bytes = counters.bytes.load(Ordering::Relaxed);

    assert!(
        counted >= bytes * 16,
        "each byte needs eight rising edges to sample and eight falling to \
         shift: {bytes} bytes need {} transitions, the card counted {counted}",
        bytes * 16
    );

    // The driver's opening command, decoded off the wire — frame, argument and
    // CRC — by a card that only ever saw clock edges and levels.
    assert!(
        wait_for(
            || card.lock().expect("card").commands.contains(&0),
            Duration::from_secs(90)
        ),
        "the card must decode CMD0 (GO_IDLE) out of the bits; it saw {:?}",
        card.lock().expect("card").commands
    );
}

/// The full initialisation sequence, bit by bit over the net.
///
/// This spent a while `#[ignore]`d for a four-bit frame slip whose cause is
/// worth recording: **AKPIN assembles as `WRPIN #1,S`** (confirmed against
/// flexspin's own listing), so the acknowledge that `rcvr_mmc` opens with
/// never arrived at the bit-level receiver. The stale word the receiver had
/// latched during the preceding *transmit* burst satisfied the guest's
/// `TESTP` immediately, the guest ran a byte ahead of the bus, and deselected
/// mid-burst — chopping the clock train and slipping every later frame.
#[test]
fn the_card_completes_the_full_initialisation_sequence() {
    let Ok(image) = std::fs::read(image_path()) else {
        return;
    };
    let _g = lock_clock();
    virtual_clock::init(0.0, 160_000_000);

    let card_image = p2iss::sdimage::mad_card(32 * 1024 * 1024, None).expect("card builds");
    let node = SdCardNode::new(p2core::SdCard::with_image(card_image));
    let card = node.card();

    let iss = P2Iss::new(&image, p2core::SdCard::blank(0), &[PROTO])
        .with_level_pins(&[SD_MOSI, SD_CS, SD_CLK])
        .with_input_pins(&[SD_MISO])
        .with_sync_serial();
    let p = |pin: u8| format!("P2.{}", p2iss::pin_name(pin));
    let _system = System::new()
        .component("P2", Box::new(iss))
        .component("SD", Box::new(node))
        .component("PU", Box::new(PullUp::new()))
        .harness(
            Harness::new()
                .connect_str(&p(SD_CLK), "SD.CLK")
                .expect("endpoints parse")
                .connect_str(&p(SD_CS), "SD.CS")
                .expect("endpoints parse")
                .connect_str(&p(SD_MOSI), "SD.MOSI")
                .expect("endpoints parse")
                .connect_str(&p(SD_MISO), "SD.MISO")
                .expect("endpoints parse")
                .connect_str(&p(SD_MISO), "PU.A")
                .expect("endpoints parse"),
        )
        .start()
        .expect("the ISS system starts");

    // CMD0, CMD8, CMD55, ACMD41, CMD58 — the SDv2 opening in full.
    assert!(
        wait_for(
            || {
                let seen = &card.lock().expect("card").commands;
                [0u8, 8, 55, 58].iter().all(|c| seen.contains(c))
            },
            Duration::from_secs(120)
        ),
        "the card must decode the whole init sequence; it saw {:?}",
        card.lock().expect("card").commands
    );
    assert!(
        card.lock().expect("card").initialised,
        "and finish initialisation"
    );

    // And then the firmware's own FatFs must MOUNT the volume: the boot
    // sector read (block 0) followed by the root directory (block 129 —
    // 1 reserved + 2×64 FAT sectors, this image's exact geometry). This line
    // was unreachable for most of the bring-up, for reasons worth the
    // recounting in `docs/dev/sil-iss-components.md`: a p2core `BITH` span
    // bug corrupted flexspin method-pointer tags, so `mount()` dispatched
    // into the cog manager's task table instead of the filesystem.
    assert!(
        wait_for(
            || card.lock().expect("card").reads.contains(&0),
            Duration::from_secs(120)
        ),
        "FatFs must read the boot sector through the wire"
    );
    assert!(
        wait_for(
            || card.lock().expect("card").reads.contains(&129),
            Duration::from_secs(60)
        ),
        "and walk to the root directory; it read {:?}",
        card.lock().expect("card").reads
    );
}
