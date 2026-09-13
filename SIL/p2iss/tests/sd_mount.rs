//! The firmware mounts the card the ISS gives it.
//!
//! The oracle here is not the harness — it is FlexC's own FatFs, compiled into
//! the image under test. `dev_nvram.c` calls
//! `mount(SD_CARD_MOUNT_PATH, _vfs_open_sdcard())` and narrates the result on
//! the debug console; the assertion reads that narration back. Nothing in this
//! test models a filesystem, which is the point: if the guest says it mounted,
//! the image is genuinely FAT16 down to the byte, because the code that
//! decided is the code that ships.
//!
//! Skipped when the firmware artifact is absent, like the other ISS tests.

use std::path::PathBuf;
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, Instant};

use embsim_board::{Harness, System};
use embsim_core::virtual_clock;
use p2iss::{sdimage, P2Iss, SerialLink};

/// The protocol link, declared so the ISS's pins exist; nothing is wired to
/// them here, because this test is about the card, not the wire.
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
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../Firmware/MaDCore/.pio/build/propeller2_debug/program")
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

/// Boot the ISS on `card` and return everything the guest said, up to
/// `timeout` or until `done` is satisfied.
fn boot_and_watch(
    card: p2core::SdCard,
    done: impl Fn(&str) -> bool,
    timeout: Duration,
) -> Option<(String, Vec<u8>, Vec<u32>)> {
    let image = std::fs::read(image_path()).ok()?;
    // The virtual clock is process-global and cargo runs these concurrently;
    // without both the lock and the init the guest never advances and the
    // console comes back empty — which reads as "no failure message" and
    // passes a mount assertion vacuously.
    let _g = lock_clock();
    virtual_clock::init(0.0, 160_000_000);
    let iss = P2Iss::new(&image, card, &[PROTO]);
    let handle = iss.handle();
    let _system = System::new()
        .component("P2", Box::new(iss))
        .harness(Harness::new())
        .start()
        .expect("the ISS system starts");
    wait_for(|| done(&handle.console()), timeout);
    Some((handle.console(), handle.sd_commands(), handle.sd_reads()))
}

fn skip_banner() {
    eprintln!(
        "\n*** SKIPPED: {} needs the P2 image at\n***   {}\n*** Build it with `make p2image` (or `cd ../Firmware/MaDCore && pio run -e propeller2_debug`).\n*** This test asserted NOTHING.\n",
        module_path!(),
        image_path().display()
    );
}

/// The card *initialises* — the SPI conversation completes.
///
/// This is the regression test for a `p2core` defect that made the SD card
/// unusable in the ISS: `Board` assembled a receive word at the width of the
/// *previous* transfer, because `sdmm.cc` programs the clock before the
/// receive width, and `xmit_mmc` leaves two bytes in the shifter that only
/// `dirl PIN_DI` discards. The guest read `00 00 00 00` for CMD8's R7, failed
/// its `buf[2] == 0x01 && buf[3] == 0xAA` gate, and stopped: the card never
/// saw CMD55, ACMD41 or CMD58.
///
/// Asserting on the commands the *card* received keeps the real driver in the
/// loop — a hand-built SPI conversation would drift from what the firmware
/// actually does, which is the whole reason the ISS exists.
#[test]
fn the_card_completes_its_initialisation_handshake() {
    let Some((console, commands, _)) = boot_and_watch(
        p2core::SdCard::with_image(
            sdimage::mad_card(32 * 1024 * 1024, None).expect("the card image builds"),
        ),
        |c| c.contains("failed to mount") || c.contains("NVRAM"),
        Duration::from_secs(90),
    ) else {
        return skip_banner();
    };
    let _ = console;
    // CMD55 + ACMD41 mark "left idle state"; CMD58 reads the OCR, which is
    // where the guest decides the card is SDHC and block-addressed.
    for (cmd, what) in [(55u8, "APP_CMD"), (58, "READ_OCR")] {
        assert!(
            commands.contains(&cmd),
            "the guest must reach CMD{cmd} ({what}); it only got as far as {commands:?}"
        );
    }
}

/// A blank card must be probed and REJECTED.
///
/// This is the control, and it is not ceremony: without it a passing mount
/// proves nothing, because a test that cannot tell a formatted card from
/// 32 MiB of zeroes is not testing the format.
///
/// What rejection looks like needs care, because two things changed together:
/// FlexC's `mount()` is **deferred** — it registers the volume without
/// touching the disk, so it succeeds identically for any card — and
/// `dev_nvram` treats a missing profile as silent defaults, not an error. So
/// there is no console line to assert on. The verdict is on the WIRE: FatFs
/// reads the boot sector at the first file operation, finds zeroes where a
/// FAT VBR should be, and walks no further. Block 0 read; block 129 (the
/// root directory) never read.
#[test]
fn a_blank_card_is_probed_and_rejected() {
    let Some((_console, _, reads)) = boot_and_watch(
        p2core::SdCard::blank(32 * 1024 * 1024),
        // The LOGGER channel's open is the last SD touch of the boot; by the
        // time it narrates, the probe has happened.
        |c| c.contains("IO_SDCARD"),
        Duration::from_secs(90),
    ) else {
        return skip_banner();
    };
    assert!(
        reads.contains(&0),
        "FatFs must at least probe the boot sector; it read {reads:?}"
    );
    assert!(
        !reads.contains(&129),
        "and must go no further on 32 MiB of zeroes — reading the root \
         directory of a volume with no boot signature means check_fs is not \
         checking; it read {reads:?}"
    );
}

/// The formatted card mounts, and the guest stops falling back to failsafe
/// records at the mount step.
///
/// This test spent its whole life `#[ignore]`d, and the reason deserves its
/// record. `mount()` returned -1/errno -1 above a *perfectly initialised*
/// card, and the trail ran three layers deep: `_seterror(-r)` with r = 1 came
/// from `(*v->init)(name)` dispatching into `dev_cogManager_taskInitMONITOR`
/// instead of the filesystem's `v_init` — because flexspin encodes
/// `obj | (index << 20)` with `BITH obj, #20 ADDBITS 4`, and p2core's `BITH`
/// set one bit instead of the five-bit span, turning method-pointer tag 31
/// into tag 1. One instruction's missing field, surfacing as "the SD card
/// will not mount". Fixed in `p2core` with its own regression test
/// (`bit_instructions_cover_their_addbits_span`).
#[test]
fn the_formatted_card_mounts() {
    let card = p2core::SdCard::with_image(
        sdimage::mad_card(32 * 1024 * 1024, None).expect("the card image builds"),
    );
    let Some((console, _, reads)) = boot_and_watch(
        card,
        // Either outcome ends the wait; the assertions below decide which it
        // was. Waiting only for success would burn the full timeout on a
        // regression and report it as a timeout rather than as a failed mount.
        |c| c.contains("failed to mount") || c.contains("IO_SDCARD"),
        Duration::from_secs(90),
    ) else {
        return skip_banner();
    };
    assert!(
        !console.contains("failed to mount"),
        "the guest's FatFs must accept the generated FAT16 image; console was:\n{console}"
    );
    assert!(
        reads.contains(&0) && reads.contains(&129),
        "a mount has a wire-visible shape: the boot sector, then the root \
         directory at block 129 (1 reserved + 2\u{d7}64 FAT sectors); it read {reads:?}"
    );
}
