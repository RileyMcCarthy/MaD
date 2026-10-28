//! `embsim run mad.toml --pty PATH`, live: one protocol round trip on the
//! host's PTY, with no browser (embsim `MIGRATING-MAD.md` step 10, moved
//! here from `MaDSim/tests/pty_protocol.rs`, which ran `mad-emulator`).
//!
//! The run is the one `mad-runner` makes of `SIL/mad.toml`: the Edge
//! carrier, the P2-EC32MB module with MaD's instruction-set simulator as its
//! processor booting the production firmware off the module's flash, the
//! module's card, the DS2 add-on, the machine, and a `host-serial` on the
//! carrier's debug header `J1`, whose PTY this test opens. `embsim_cli::run`
//! takes the command line `embsim run` hands the runner, over the set the
//! runner holds (`embsim_cli::shipped()` and `mad_catalog::register`), in
//! this test's process. The file's paths are made relative to a scratch
//! directory holding the two images it names, laid out as `make
//! flash-image` and `make sd-image` lay them out, as `tests/mad.rs` does.
//!
//! Live, not stepped: the run is unpaced and lasts `RUN_FOR` of virtual
//! time, and the host writes in wall time, so its bytes land at whatever
//! instant the run has reached (embsim `PROJECTS.md` §5, `host-serial`).
//! The host asks from the run's start and again until it is answered: what
//! decides the case is the firmware's answer on the line, not its console.
//! The test asserts nothing on host time: the answer must arrive before the
//! run's own end, in board time. Host time only paces the host's requests.
//! `tests/mad.rs` holds the same line stepped, instant by instant.
//!
//! Skipped, saying why, when the production image is absent (`make
//! p2image-production`); `MAD_REQUIRE_P2_IMAGE` turns the skip into a
//! failure.

#![cfg(unix)]

use std::io::{Read as _, Write};
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use embsim_boards::catalog::CatalogSet;
use protoemb_framing::{FrameParser, ParsedFrame};
use vibes_behaviour::{behaviour, expect, Test};

/// The catalogs embsim ships, with MaD's added: the set `mad-runner` runs.
fn set() -> CatalogSet {
    let mut set = embsim_cli::shipped();
    mad_catalog::register(&mut set).expect("MaD's catalog joins the set");
    set
}

/// `SIL/`, where the project files are.
fn sil() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..")
}

/// The production program (pio env `propeller2`), the one `make
/// flash-image` lays out: `MAD_P2_PRODUCTION_IMAGE` names a copy kept out
/// of `.pio` (the CI jobs'), else the build's own.
fn image_path() -> PathBuf {
    let p = std::env::var_os("MAD_P2_PRODUCTION_IMAGE").map_or_else(
        || sil().join("../Firmware/MaDCore/.pio/build/propeller2/program"),
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

/// The card's size: what `make sd-image` writes.
const CARD_BYTES: usize = 32 * 1024 * 1024;

/// How long the run lasts, in virtual time: the firmware's first console
/// line comes at about 1.18 s of board time, once stage-1 has streamed the
/// program off the flash (measured, `tests/mad.rs` and `make e2e-emulator`),
/// and it answers a version read within milliseconds of it.
const RUN_FOR: &str = "2s";

/// How often, in host time, the host repeats its request until it is
/// answered, and how often it looks: pacing only.
const POLL: Duration = Duration::from_millis(100);

/// A scratch directory holding `mad.toml` as the file names it, beside the
/// two images it names (`build/flash.bin`, `build/sd.img`): the flash laid
/// out from the production program by `embsim flash-image`, the command
/// `make flash-image` runs, here in process; the card `make sd-image`
/// writes. With it, the program's bytes. `None`, having said why, without
/// the program.
fn scratch() -> Option<(PathBuf, Vec<u8>)> {
    let image = image_path();
    let Ok(program) = std::fs::read(&image) else {
        eprintln!(
            "\n*** SKIPPED: {} needs the production P2 image at\n***   {}\n*** Build it with \
             `make p2image-production`.\n*** This test asserted NOTHING.\n",
            module_path!(),
            image.display()
        );
        return None;
    };
    let dir = Path::new(env!("CARGO_TARGET_TMPDIR")).join("mad-catalog-pty");
    let _ = std::fs::remove_dir_all(&dir);
    let build = dir.join("build");
    std::fs::create_dir_all(&build).expect("the scratch directory is writable");
    let flash = build.join("flash.bin");
    let (mut out, mut err) = (Vec::new(), Vec::new());
    let code = embsim_cli::run(
        &set(),
        [
            "embsim",
            "flash-image",
            image.to_str().expect("the image path is UTF-8"),
            "-o",
            flash.to_str().expect("the scratch path is UTF-8"),
        ],
        &mut out,
        &mut err,
    );
    assert_eq!(
        code,
        ExitCode::SUCCESS,
        "flash-image: {}",
        String::from_utf8_lossy(&err)
    );
    let card = p2iss::sdimage::mad_card(CARD_BYTES, Some(&sil().join("sd")))
        .expect("the card image builds");
    std::fs::write(build.join("sd.img"), card).expect("sd.img is writable");
    // The file as it is, its catalog crate named where it is: the run
    // reads the file's head, which names the crate by a path relative to
    // the file.
    let text = std::fs::read_to_string(sil().join("mad.toml")).expect("SIL/mad.toml reads");
    let crate_line = "crates = [\"mad-catalog\"]";
    assert_eq!(
        text.matches(crate_line).count(),
        1,
        "mad.toml names its crate once"
    );
    let crate_dir = sil().join("mad-catalog");
    let text = text.replacen(
        crate_line,
        &format!("crates = [{:?}]", crate_dir.to_str().expect("UTF-8")),
        1,
    );
    std::fs::write(dir.join("mad.toml"), text).expect("the scratch mad.toml is writable");
    Some((dir, program))
}

/// What the run prints, shared with the host's side as it prints it.
#[derive(Clone, Default)]
struct Printed(Arc<Mutex<Vec<u8>>>);

impl Printed {
    fn text(&self) -> String {
        String::from_utf8_lossy(&self.0.lock().expect("never poisoned")).into_owned()
    }
}

impl Write for Printed {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.0
            .lock()
            .expect("never poisoned")
            .extend_from_slice(buf);
        Ok(buf.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

/// The payload of the first data frame answering `command` in `received`
/// from `at` on: the bytes before a request are no answer to it. The
/// firmware's boot line, at the console's rate, reads on this line as
/// noise that a parser could take for a header, swallowing the answer as a
/// payload; a request sent after it has the noise behind it.
fn answer(received: &[u8], at: usize, command: u8) -> Option<Vec<u8>> {
    FrameParser::new()
        .feed_bytes(&received[at.min(received.len())..])
        .into_iter()
        .find_map(|frame| match frame {
            ParsedFrame::Data {
                command: answered,
                payload,
            } if answered == command => Some(payload),
            _ => None,
        })
}

/// Whether `program` holds `text` as a C string: its bytes, then a NUL.
fn holds_c_string(program: &[u8], text: &str) -> bool {
    let mut needle = text.as_bytes().to_vec();
    needle.push(0);
    program.windows(needle.len()).any(|window| window == needle)
}

#[test]
fn the_firmware_answers_its_version_on_the_hosts_pty() {
    behaviour!(Test {
        id: "mad-project.pty-round-trip",
        covers: Some("SIL/mad.toml"),
        given: "the production firmware run live for 2 s of board time, with a host program on \
                the PTY reading the firmware's version every 100 ms until answered",
    });
    expect!(
        "version-answered",
        "the program receives a data frame answering its read before the run ends",
        "the debug header carries the firmware's protocol channel, P63 and P62, to the \
         host, and the PTY is the host's end of that line"
    );
    expect!(
        "version-decodes",
        "the answer reads, by MaD's protocol, as a firmware version that the program carries \
         as text"
    );
    expect!(
        "run-completes",
        "the run lasts its 2 s of board time and ends with its summary, no part having failed"
    );
    let Some((dir, program)) = scratch() else {
        return;
    };
    let project = dir.join("mad.toml");
    let pty = dir.join("host.pty");
    let printed = Printed::default();
    let run = {
        let (project, pty) = (project.clone(), pty.clone());
        let mut out = printed.clone();
        std::thread::spawn(move || {
            let mut err = Vec::new();
            let code = embsim_cli::run(
                &set(),
                [
                    "embsim",
                    "run",
                    project.to_str().expect("UTF-8"),
                    "--pty",
                    pty.to_str().expect("UTF-8"),
                    "--for",
                    RUN_FOR,
                ],
                &mut out,
                &mut err,
            );
            (code, String::from_utf8_lossy(&err).into_owned())
        })
    };

    // The run prints the PTY's path at its first look, before virtual time
    // moves: the host opens it then, and reads it from then on.
    while !(pty.exists() || run.is_finished()) {
        std::thread::sleep(POLL);
    }
    let mut port = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(&pty)
        .unwrap_or_else(|e| {
            panic!(
                "the host's PTY {} opens: {e}\n{}",
                pty.display(),
                printed.text()
            )
        });
    let received = Arc::<Mutex<Vec<u8>>>::default();
    {
        let mut reader = port.try_clone().expect("the PTY's handle clones");
        let sink = Arc::clone(&received);
        // The read ends, with an error or the end of the file, once the
        // run's shutdown closes the PTY.
        std::thread::spawn(move || {
            let mut buf = [0u8; 512];
            while let Ok(n @ 1..) = reader.read(&mut buf) {
                sink.lock()
                    .expect("never poisoned")
                    .extend_from_slice(&buf[..n]);
            }
        });
    }
    // The host asks from the start and again until answered: a request in
    // the boot ROM's or stage-1's time reaches nothing that answers, and a
    // later one reaches the firmware.
    let request = protoemb_framing::build_read_frame(protocol::MSG_READ_FIRMWARE_VERSION);
    // Where what the host received ended at each request: each request's
    // answer is parsed from there, so nothing received before it is taken
    // for a frame.
    let mut sent = Vec::new();
    let mut version = None;
    while version.is_none() && !run.is_finished() {
        let at = received.lock().expect("never poisoned").len();
        // The slave can refuse a write for a moment while the run shuts
        // the line down; the run's end decides the case.
        if port.write_all(&request).and_then(|()| port.flush()).is_ok() {
            sent.push(at);
        }
        std::thread::sleep(POLL);
        let received = received.lock().expect("never poisoned");
        version = sent
            .iter()
            .find_map(|&at| answer(&received, at, protocol::MSG_READ_FIRMWARE_VERSION));
    }
    let requests = sent.len();
    let (code, err) = run.join().expect("the run's thread ends");
    let printed = printed.text();
    let version = version.unwrap_or_else(|| {
        panic!(
            "no answer to {requests} version reads on {} before the run ended: received \
             {:02X?}\n{printed}\n{err}",
            pty.display(),
            received.lock().expect("never poisoned")
        )
    });
    let version = protocol::FirmwareVersion::decode(&version)
        .unwrap_or_else(|| panic!("the version's payload decodes: {version:02X?}"))
        .version;
    assert!(
        !version.is_empty() && holds_c_string(&program, &version),
        "the firmware version {version:?} is a string the program holds"
    );
    assert_eq!(
        code,
        ExitCode::SUCCESS,
        "the run ends cleanly:\n{printed}\n{err}"
    );
    assert!(
        printed.contains("ran 2000.000000 ms of virtual time"),
        "the run lasted its {RUN_FOR}:\n{printed}"
    );
    let _ = writeln!(
        std::io::stderr(),
        "version {version:?} after {requests} requests; {}",
        printed
            .lines()
            .filter(|line| line.starts_with("HOST:") || line.starts_with("ran "))
            .collect::<Vec<_>>()
            .join("; ")
    );
}
