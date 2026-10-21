//! `mad-p2iss`, the instruction-set simulator as the P2's core, through the
//! `embsim` command over the catalogs embsim ships and MaD's
//! (`embsim_cli::shipped()` and `mad_catalog::register`), as `mad-runner`
//! runs a project naming it.
//!
//! The boot is a project of the P2-EC32MB module alone: powered from its
//! `J203` fingers as a carrier powers them, `S301` positions 2 (FLASH) and 4
//! (the `P59` pull-down) closed, the module's flash holding stage-1 and the
//! `propeller2_debug` program as `make flash-image` lays them out (the same
//! command, `embsim flash-image`, run in process), and a `host-serial` at
//! the firmware's console rate on the debug-transmit finger, `J203.50`
//! (`P62/PRG_DBG_TXD`). `embsim run` runs it stepped for the boot's time,
//! and the core's report carries the firmware's first console line. The
//! chain under it is `p2iss/tests/ec32mb_flash_boot.rs`'s; this is that boot
//! said by a project file.
//!
//! It keeps the `propeller2_debug` image while `SIL/mad.toml` boots the
//! production one (`tests/mad.rs`): the subject here is the core kind's
//! report of the firmware's console on `P62`, which the debug build writes at
//! 230 400 baud for the whole run. The production build prints its first
//! line there too, then gives `P62` to its 2 000 000 baud protocol once its
//! serial core starts, and the core's summary gives that rate.
//!
//! Stepped: `run` holds the virtual clock and advances it only while it
//! waits, so the report is the board's time and state. The boot skips,
//! saying why, when the `propeller2_debug` image is absent (`make p2image`),
//! as the `p2iss` suites that run the firmware do; `MAD_REQUIRE_P2_IMAGE`
//! turns the skip into a failure. The seating cases need no image and no
//! clock: a survey builds nothing.
//! The trap case runs stepped too, but on a 16-byte ROM of its own, so it
//! needs no image.

use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::sync::{Mutex, MutexGuard};

use embsim_board::{BoardSurvey, Project, ProjectError};
use embsim_boards::catalog::CatalogSet;
use vibes_behaviour::{behaviour, expect, Test};

/// The runs share the process's one virtual clock.
static CLOCK: Mutex<()> = Mutex::new(());

fn clock() -> MutexGuard<'static, ()> {
    CLOCK.lock().unwrap_or_else(|poisoned| {
        CLOCK.clear_poison();
        poisoned.into_inner()
    })
}

/// The catalogs embsim ships, with MaD's added: the set `mad-runner` runs.
fn set() -> CatalogSet {
    let mut set = embsim_cli::shipped();
    mad_catalog::register(&mut set).expect("MaD's catalog joins the set");
    set
}

/// A directory of the test's own, empty, under Cargo's scratch directory
/// for integration tests.
fn scratch(test: &str) -> PathBuf {
    let dir = Path::new(env!("CARGO_TARGET_TMPDIR"))
        .join("mad-catalog-boot")
        .join(test);
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("the scratch directory is writable");
    dir
}

/// The `embsim` command over [`set`], in process: its exit code, what it
/// printed and its errors.
fn embsim(args: &[&str]) -> (ExitCode, String, String) {
    let (mut out, mut err) = (Vec::new(), Vec::new());
    let code = embsim_cli::run(
        &set(),
        std::iter::once("embsim").chain(args.iter().copied()),
        &mut out,
        &mut err,
    );
    (
        code,
        String::from_utf8_lossy(&out).into_owned(),
        String::from_utf8_lossy(&err).into_owned(),
    )
}

fn path(path: &Path) -> &str {
    path.to_str().expect("the scratch path is UTF-8")
}

// ============================================================
// Seating: the core kind in the P2's package
// ============================================================

/// A P2-EC32MB project whose processor runs `mad-p2iss` with `options`
/// beside `core`.
fn module_project(options: &str) -> String {
    format!(
        "[[board]]\nname = \"EC32\"\nkind = \"p2-ec32mb\"\n\n[[board.model]]\n\
         value = \"P2X8C4M64P\"\nkind = \"p2\"\n[board.model.options]\n\
         core = \"mad-p2iss\"\n{options}\n"
    )
}

/// Survey the module's project, its files relative to `dir`.
fn survey(dir: &Path, options: &str) -> Result<BoardSurvey, ProjectError> {
    Project::parse(&module_project(options))
        .expect("the text is a project")
        .relative_to(dir)
        .survey(&set(), "EC32")
}

#[test]
fn the_simulator_is_a_core_the_p2_package_seats() {
    behaviour!(Test {
        id: "catalog.mad-p2iss-seated",
        covers: Some("SIL/mad-catalog/src/iss.rs#IssCores::seat"),
        given: "a P2-EC32MB module whose processor names MaD's instruction-set simulator as \
                its core, with no options of its own, surveyed with the catalogs embsim ships \
                and MaD's",
    });
    expect!(
        "listed",
        "the catalogs offer the simulator as a core kind, mad-p2iss, beside the chip held in \
         reset and QEMU"
    );
    expect!(
        "surveyed",
        "the module surveys with every part placed and nothing refused"
    );
    let cores: Vec<String> = set()
        .core_kinds()
        .into_iter()
        .map(|kind| kind.name.into_owned())
        .collect();
    assert_eq!(cores, ["held-in-reset", "qemu", "mad-p2iss"]);
    let survey = survey(&scratch("seated"), "").expect("the module surveys");
    assert!(survey.compliant(), "{survey}");
}

#[test]
fn a_boot_rom_file_beside_the_project_seats() {
    behaviour!(Test {
        id: "catalog.mad-p2iss-rom-file",
        covers: Some("SIL/mad-catalog/src/iss.rs#IssCores::seat"),
        given: "the module's processor running the simulator, its boot ROM option naming a file \
                beside the project that holds a copy of the ROM",
    });
    expect!(
        "seats",
        "the module surveys with every part placed and nothing refused"
    );
    let dir = scratch("rom-file");
    std::fs::write(dir.join("rom.bin"), mad_catalog::iss::BOOT_ROM).expect("rom.bin is writable");
    let survey = survey(&dir, "rom = \"rom.bin\"").expect("the module surveys");
    assert!(survey.compliant(), "{survey}");
}

#[test]
fn a_boot_rom_that_is_not_there_is_refused() {
    behaviour!(Test {
        id: "catalog.mad-p2iss-rom-missing",
        covers: Some("SIL/mad-catalog/src/iss.rs#IssCores::seat"),
        given: "the module's processor running the simulator, its boot ROM option naming a file \
                the project's directory does not hold",
    });
    expect!(
        "refused",
        "the survey refuses the processor's entry, naming the file it could not read"
    );
    let dir = scratch("rom-missing");
    let err = survey(&dir, "rom = \"no-such-rom.bin\"").expect_err("the ROM is not there");
    let text = err.to_string();
    assert!(text.contains("cannot read boot ROM"), "{text}");
    assert!(text.contains(path(&dir.join("no-such-rom.bin"))), "{text}");
}

#[test]
fn a_boot_rom_longer_than_the_chips_is_refused() {
    behaviour!(Test {
        id: "catalog.mad-p2iss-rom-too-long",
        covers: Some("SIL/mad-catalog/src/iss.rs#IssCores::seat"),
        given: "the module's processor running the simulator, its boot ROM option naming a file \
                one byte longer than 16 KB",
    });
    expect!(
        "refused",
        "the survey refuses the processor's entry, saying the chip boots from the 16 384 bytes \
         at the top of hub RAM",
        "the simulator fills that space from the ROM, so a longer file cannot be the chip's ROM"
    );
    let dir = scratch("rom-too-long");
    std::fs::write(
        dir.join("rom.bin"),
        vec![0u8; mad_catalog::iss::BOOT_ROM_MAX_BYTES + 1],
    )
    .expect("rom.bin is writable");
    let err = survey(&dir, "rom = \"rom.bin\"").expect_err("the ROM is too long");
    let text = err.to_string();
    assert!(text.contains("is 16385 bytes"), "{text}");
    assert!(
        text.contains("the 16384 bytes at the top of hub RAM"),
        "{text}"
    );
}

#[test]
fn the_cores_one_option_is_its_boot_rom() {
    behaviour!(Test {
        id: "catalog.mad-p2iss-one-option",
        covers: Some("SIL/mad-catalog/src/iss.rs#IssCores::seat"),
        given: "the module's processor running the simulator, its entry also naming a program \
                image to put in hub RAM",
    });
    expect!(
        "refused",
        "the survey refuses the processor's entry, naming the core and its boot ROM as the \
         options the entry takes",
        "the chip boots its ROM off whatever the board gives it; a program loaded straight \
         into hub RAM would skip the boot chain the board exists to check"
    );
    let err = survey(&scratch("one-option"), "image = \"program.bin\"")
        .expect_err("the core takes no program");
    let text = err.to_string();
    assert!(
        text.contains("unknown option \"image\"; this kind takes \"core\", \"rom\""),
        "{text}"
    );
}

// ============================================================
// The boot: a project of the module, run
// ============================================================

/// The module's supplies from its `J203` fingers, as a carrier gives them:
/// unpowered, the package holds the core in reset and it never fetches. One
/// copy, taken in by [`BOOT_PROJECT`] and the trap case's project.
macro_rules! module_power {
    () => {
        r#"
[[wire]]
from = "CARRIER.5V"
to = "EC32.J203.41"
volts = 5.0

[[wire]]
from = "CARRIER.5Vb"
to = "EC32.J203.42"
volts = 5.0

[[wire]]
from = "CARRIER.GND"
to = "EC32.J203.43"
volts = 0.0

[[wire]]
from = "CARRIER.GNDb"
to = "EC32.J203.44"
volts = 0.0

[[wire]]
from = "CARRIER.GNDc"
to = "EC32.J203.45"
volts = 0.0
"#
    };
}

/// The module on a carrier's supplies, the simulator its processor, its
/// flash holding `flash.bin`, and a host's serial port at the firmware's
/// console rate on its debug-transmit finger.
const BOOT_PROJECT: &str = concat!(
    r#"
# The P2-EC32MB module powered from its fingers, booting the firmware off its
# flash on MaD's instruction-set simulator, a host's serial port on its
# debug-transmit finger.

[[board]]
name = "EC32"
kind = "p2-ec32mb"

[[board.model]]
value = "P2X8C4M64P"
kind = "p2"
[board.model.options]
core = "mad-p2iss"

# Stage-1 and the propeller2_debug program, laid out by `embsim flash-image`.
[[board.model]]
value = "SPI Flash 16MB (128Mb)"
kind = "w25q128jv"
[board.model.options]
pins = "by-function"
image = "flash.bin"

# The firmware's debug console: flexspin's printf on P62, at the propeller2
# environment's monitor_speed.
[[component]]
name = "HOST"
kind = "host-serial"
[component.options]
baud = 230400
path = "host.pty"
"#,
    module_power!(),
    r#"
# P62/PRG_DBG_TXD, the module's debug-transmit finger.
[[wire]]
from = "EC32.J203.50"
to = "HOST.RX"

[[wire]]
from = "HOSTS.3V3"
to = "HOST.VIO"
volts = 3.3

[[wire]]
from = "HOSTS.GND"
to = "HOST.GND"
volts = 0.0

# FLASH: P61 reaches the flash's chip select.
[[switch]]
part = "EC32.S301"
pole = 1
state = "closed"

# R303 holds P59 down: the ROM boots the program in flash.
[[switch]]
part = "EC32.S301"
pole = 3
state = "closed"
"#
);

/// The START instant: the module's reset releases at 2.5 ms (the AP62301
/// bucks' soft-start) and the chip starts 3 ms after (P2X8C4M64P
/// Datasheet, Pin Descriptions, p. 6), as `p2iss/tests/ec32mb_flash_boot.rs`
/// measures it.
const START_NS: u64 = 5_500_000;

/// Board time stage-1 takes a byte of the program: it bit-bangs the flash
/// at about 4 µs a byte on the 20 MHz RC oscillator
/// (`p2iss/tests/ec32mb_flash_boot.rs`).
const STAGE1_NS_PER_BYTE: u64 = 4_000;

/// Board time from the program's first instruction to its first line
/// ended, with room: `ec32mb_flash_boot.rs` measured the line ended at
/// 1.262 s with a 326 504-byte image, 6 ms after stage-1's 3.84 µs a byte
/// (measured).
const FIRST_LINE_NS: u64 = 100_000_000;

/// The firmware's console rate: the `propeller2` environment's
/// `monitor_speed`.
const CONSOLE_BAUD: f64 = 230_400.0;

/// The `propeller2_debug` program: `MAD_P2_IMAGE` names a copy kept out of
/// `.pio` (the ledger job's), else the build's own.
fn image_path() -> PathBuf {
    let p = std::env::var_os("MAD_P2_IMAGE").map_or_else(
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

/// The run's lines whose subject is `subject`, each without the subject:
/// a look's with its stamp, `[  1260.700000 ms] …`, a summary's bare.
fn lines_of<'a>(out: &'a str, subject: &str) -> Vec<&'a str> {
    let at = format!(" {subject}: ");
    let bare = format!("{subject}: ");
    out.lines()
        .filter_map(|line| {
            line.strip_prefix(&bare)
                .or_else(|| line.split_once(&at).map(|(_, rest)| rest))
        })
        .collect()
}

/// The instant of the look that said `said` of `subject`, from its stamp.
fn said_at_ns(out: &str, subject: &str, said: &str) -> Option<u64> {
    let tail = format!(" {subject}: {said}");
    let line = out.lines().find(|line| line.ends_with(&tail))?;
    let stamp = line.strip_prefix('[')?.split_once(" ms]")?.0.trim();
    let (whole, frac) = stamp.split_once('.')?;
    Some(whole.parse::<u64>().ok()? * 1_000_000 + frac.parse::<u64>().ok()?)
}

#[test]
fn the_firmware_boots_off_the_modules_flash_and_its_core_reports_the_console() {
    behaviour!(Test {
        id: "catalog.mad-p2iss-boot",
        covers: Some("SIL/mad-catalog/src/iss.rs#IssReport"),
        given: "a P2-EC32MB module powered from its fingers, booting the MaD firmware off its \
                flash on the MaD instruction-set simulator, a host serial port on its \
                debug-transmit finger, the project run stepped for the boot",
    });
    expect!(
        "console-reported",
        "the core's report gives the firmware's first console line, \"Starting MaD Board\", \
         at the look that finds it, after the core started"
    );
    expect!(
        "rate-reported",
        "the core's summary gives the rate the firmware programmed on its debug pin, P62, \
         within 0.1 percent of 230 400 baud"
    );
    expect!(
        "nothing-lost",
        "the core's summary counts no pad edges dropped and no frames that did not deframe"
    );
    expect!(
        "host-received",
        "the host's serial port passes at least the first line's 20 bytes on to its terminal, \
         and counts no framing errors",
        "nothing reads the host's end, so the count stops once the terminal holds all it will \
         take; the first line always fits"
    );

    let image = image_path();
    let Ok(program) = std::fs::metadata(&image) else {
        eprintln!(
            "\n*** SKIPPED: {} needs the P2 image at\n***   {}\n*** Build it with `make \
             p2image`.\n*** This test asserted NOTHING.\n",
            module_path!(),
            image.display()
        );
        return;
    };
    let dir = scratch("boot");
    let (code, out, err) = embsim(&[
        "flash-image",
        path(&image),
        "-o",
        path(&dir.join("flash.bin")),
    ]);
    assert_eq!(code, ExitCode::SUCCESS, "flash-image: {err}\n{out}");
    let project = dir.join("boot.toml");
    std::fs::write(&project, BOOT_PROJECT).expect("the project is writable");

    // The boot's time: the start, stage-1 streaming the program, and the
    // firmware's first line.
    let run_ns = START_NS + program.len() * STAGE1_NS_PER_BYTE + FIRST_LINE_NS;
    let (code, out, err) = {
        let _clock = clock();
        embsim(&["run", path(&project), "--for", &format!("{run_ns}ns")])
    };
    let _ = writeln!(
        std::io::stderr(),
        "embsim run {}:\n{out}{err}",
        project.display()
    );
    assert_eq!(code, ExitCode::SUCCESS, "the run ends cleanly: {err}");

    let core = lines_of(&out, "EC32.U100");
    let first = "P62 \"Starting MaD Board\"";
    let said = said_at_ns(&out, "EC32.U100", first).unwrap_or_else(|| {
        panic!(
            "the core's report gives the firmware's first line within {run_ns} ns: if the \
             firmware grew past what stage-1 streams in that time, the boot needs longer; \
             the core said {core:#?}"
        )
    });
    assert!(
        said > START_NS,
        "the line is the running firmware's: {said} ns"
    );
    assert_eq!(
        core.iter().find(|line| line.starts_with("P62 ")),
        Some(&first),
        "\"Starting MaD Board\" is the firmware's first console line: {core:#?}"
    );
    assert!(
        core.contains(&"the core started at 5.500000 ms"),
        "the package started the core: {core:#?}"
    );

    let summary = core
        .iter()
        .find(|line| line.contains(" cogs running; "))
        .unwrap_or_else(|| panic!("the core's summary: {core:#?}"));
    let baud: f64 = summary
        .split_once("P62 at ")
        .and_then(|(_, rest)| rest.split_once(" baud"))
        .and_then(|(baud, _)| baud.parse().ok())
        .unwrap_or_else(|| panic!("the summary gives P62's rate: {summary}"));
    assert!(
        (baud - CONSOLE_BAUD).abs() / CONSOLE_BAUD < 0.001,
        "P62 at {baud} baud: {summary}"
    );
    assert!(
        summary.contains("; 0 frames on receive pins did not deframe; 0 pad edges dropped"),
        "{summary}"
    );

    let host = lines_of(&out, "HOST");
    let received = host
        .iter()
        .find_map(|line| {
            line.split_once(" bytes from the host, ")
                .and_then(|(_, rest)| rest.split_once(" to it, "))
        })
        .unwrap_or_else(|| panic!("the host's summary: {host:#?}"));
    let to_host: usize = received.0.parse().expect("a byte count");
    assert!(
        to_host >= "Starting MaD Board\r\n".len(),
        "the host's port passed {to_host} bytes to its terminal: {host:#?}"
    );
    assert_eq!(received.1, "0 framing errors", "{host:#?}");
}

// ============================================================
// A trap: a ROM the simulator cannot run
// ============================================================

/// A long `p2core`'s `decode` rejects, so COG 0 traps with
/// `Trap::UndecodedWord` rather than an unimplemented instruction's trap:
/// the D-only group (`1101011`) with an `S` it gives no instruction.
/// Should `decode` come to accept it, the trap text below stops matching.
const UNDECODABLE: u32 = 0xFD60_007F;

#[test]
fn a_rom_that_traps_on_its_first_fetch_stops_the_run() {
    behaviour!(Test {
        id: "catalog.mad-p2iss-trap",
        covers: Some("SIL/mad-catalog/src/iss.rs#IssReport"),
        given: "the module's processor running the simulator, its boot ROM option naming a file \
                whose first long decodes as no instruction, the project run stepped past the \
                core's start",
    });
    expect!(
        "run-fails",
        "the run fails, its error saying the guest trapped and runs no more, naming the word \
         and where COG 0 fetched it",
        "a trapped guest runs no further, so nothing after the trap is the firmware's"
    );
    expect!(
        "said-once",
        "the core's looks say the trap once, at the look that finds it"
    );
    expect!(
        "summary-says",
        "the core's summary says it stopped by a trap, naming the same word"
    );

    let dir = scratch("trap");
    let rom: Vec<u8> = [UNDECODABLE, 0, 0, 0]
        .iter()
        .flat_map(|word| word.to_le_bytes())
        .collect();
    std::fs::write(dir.join("rom.bin"), rom).expect("rom.bin is writable");
    let project = dir.join("trap.toml");
    std::fs::write(
        &project,
        module_project("rom = \"rom.bin\"") + module_power!(),
    )
    .expect("the project is writable");

    let run_ns = START_NS + 1_000_000;
    let (code, out, err) = {
        let _clock = clock();
        embsim(&["run", path(&project), "--for", &format!("{run_ns}ns")])
    };
    let _ = writeln!(
        std::io::stderr(),
        "embsim run {}:\n{out}{err}",
        project.display()
    );

    let trap = format!("cog 0: no decoding for word {UNDECODABLE:08X} at $00000");
    assert_ne!(code, ExitCode::SUCCESS, "the run fails: {out}{err}");
    assert!(
        format!("{out}{err}").contains(&format!("the guest trapped and runs no more: {trap}")),
        "the run's error names the trap: {out}{err}"
    );

    let core = lines_of(&out, "EC32.U100");
    let said = format!("the guest trapped: {trap}");
    let at = said_at_ns(&out, "EC32.U100", &said)
        .unwrap_or_else(|| panic!("a look says the trap: {core:#?}"));
    assert!(
        at >= START_NS,
        "the trap is said after the core started: {at} ns"
    );
    assert_eq!(
        core.iter().filter(|line| **line == said).count(),
        1,
        "the looks say the trap once: {core:#?}"
    );
    assert!(
        core.contains(&format!("stopped by a trap: {trap}").as_str()),
        "the summary says the trap stopped the guest: {core:#?}"
    );
}
