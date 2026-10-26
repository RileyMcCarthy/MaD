//! `SIL/mad-serial-boot.toml`, the ROM's serial boot, stepped: the file as
//! the app's flasher finds the machine (Software/Control/src/firmware/
//! p2loader.ts). The Edge carrier, the P2-EC32MB module in its socket with
//! MaD's instruction-set simulator as its processor, `S301` set for a serial
//! boot (position 3, R302 holding `P59` up) and the module's flash erased,
//! the card, the DS2 add-on, the machine, and a `host-serial` on the
//! carrier's debug header `J1`, the Prop Plug's, at the flasher's 2 000 000
//! baud. The file is loaded with `Project::load` and built with the set
//! `mad-runner` runs, its card made relative to a scratch directory, as
//! `tests/mad.rs` builds `mad.toml`.
//!
//! The host does what the flasher does once the chip has started: the boot
//! ROM's check-device probe (`> Prop_Chk 0 0 0 0  `), then a program as hex
//! (`> Prop_Hex 0 0 0 0`, the bytes, a ` > ` after every 128, the
//! complement of the program's longs and `?`), the flasher's RAM load. The
//! probe arrives once the ROM has read `P59` and waits on `P63`; nothing
//! pulses `RESn` (`J1.3` is unwired in the file), so the chip has run its
//! ROM from the START instant. The probe's reply is read off the host's
//! line; the load's status character off the core's report of what the chip
//! wrote on `P62` (see [`status`]).
//!
//! Stepped (embsim `TESTING.md` rule 9), as `tests/mad.rs` is: the clock
//! stepped before the project builds, the system started with time held,
//! the case's thread a registered actor; every assertion is on board time,
//! on what the host received and on what the core reports. The host's PTY is written by the case and
//! read by a thread of its own that touches no clock. No image is needed:
//! the flash is erased and the ROM is the simulator's own.

#![cfg(unix)]

use std::io::{Read as _, Write as _};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use embsim_board::{Finding, Project, Report, Reports, SystemHandle};
use embsim_boards::catalog::CatalogSet;
use embsim_boards::p2::P2_RESTART_DELAY_NS;
use embsim_core::virtual_clock::{self, ClockMode};
use embsim_models::ads122u04_component::PUMP_POLL_VIRTUAL_US;
use embsim_models::oscillator::TG2520SMN_START_UP_NS;
use embsim_models::rail::AP62301_SOFT_START_NS;
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

/// The card's size: what `make sd-image` writes.
const CARD_BYTES: usize = 32 * 1024 * 1024;

/// A directory of the case's own under Cargo's scratch directory for
/// integration tests, holding the card the file names (`build/sd.img`),
/// written as `make sd-image` writes it.
fn scratch(case: &str) -> PathBuf {
    let dir = Path::new(env!("CARGO_TARGET_TMPDIR"))
        .join("mad-catalog-serial-boot")
        .join(case);
    let _ = std::fs::remove_dir_all(&dir);
    let build = dir.join("build");
    std::fs::create_dir_all(&build).expect("the scratch directory is writable");
    let card = p2iss::sdimage::mad_card(CARD_BYTES, Some(&sil().join("sd")))
        .expect("the card image builds");
    std::fs::write(build.join("sd.img"), card).expect("sd.img is writable");
    dir
}

/// The runs share the process's one virtual clock.
static CLOCK: Mutex<()> = Mutex::new(());

fn clock() -> MutexGuard<'static, ()> {
    CLOCK.lock().unwrap_or_else(|poisoned| {
        CLOCK.clear_poison();
        poisoned.into_inner()
    })
}

/// The virtual time the run is handed before the host speaks: 10.1 ms, past
/// the longest chain the boards arm from their supplies (the module's
/// bucks' 2.5 ms soft-start, the P2's 3 ms restart, the TCXO's 1 ms
/// start-up), and off the converter pump's 250 µs polls, as `tests/mad.rs`
/// settles `mad.toml`. The core starts at 5.5 ms; the ROM has read `P59` and
/// waits on `P63` well inside the 4.6 ms left.
const SETTLE_NS: u64 = 10_100_000;
const _: () =
    assert!(SETTLE_NS > AP62301_SOFT_START_NS + P2_RESTART_DELAY_NS + TG2520SMN_START_UP_NS);
const _: () = assert!(!SETTLE_NS.is_multiple_of(PUMP_POLL_VIRTUAL_US * 1_000));

/// The step the case hands the engine while it waits for the ROM.
const STEP_NS: u64 = 1_000_000;

/// The most board time the host waits for each answer: the flasher waits
/// 200 ms for the probe's reply and 300 ms for the checksum's
/// (`p2loader.ts`); a twentieth of that is room for a reply that, at
/// 2 000 000 baud, takes under 100 µs on the wire.
const ANSWER_WAIT_NS: u64 = 10_000_000;

/// How long, in wall time, a case waits for the converter's protocol
/// thread to end after the system shuts down: sized for a hang.
const THREAD_END_HANG: Duration = Duration::from_secs(20);

/// The flasher's probe: the ROM autobauds on its leading `>` and takes
/// `Prop_Chk` with four zero masks as "any chip" (`p2loader.ts`,
/// `CHK_COMMAND`).
const PROBE: &[u8] = b"> Prop_Chk 0 0 0 0  ";

/// The ROM's answer to the probe: its version, `G` on the silicon
/// (`rom_booter_v33k.spin2`, `text_ver`).
const VERSION_REPLY: &[u8] = b"\r\nProp_Ver G\r\n";

/// The program the host loads: FW-ISS's twelve bytes (`Software/Control/
/// e2e/run-all.mjs`), three instructions that end in a jump to itself.
const PROGRAM: [u8; 12] = [
    0x42, 0xEC, 0x07, 0xF6, 0x3E, 0xEC, 0x27, 0xFC, 0xFC, 0xFF, 0x9F, 0xFD,
];

/// The flasher's RAM load of `program`, as `p2loader.ts`'s `loadImage`
/// frames it: the command, each byte as ` xx`, ` > ` after every 128, then
/// the long that brings the program's longs to `"Prop"` and `?`.
fn hex_load(program: &[u8]) -> Vec<u8> {
    const CHECKSUM_MAGIC: u32 = 0x706f_7250;
    let mut out = b"> Prop_Hex 0 0 0 0".to_vec();
    let mut sum = 0u32;
    for chunk in program.chunks(128) {
        for long in chunk.chunks(4) {
            sum = sum.wrapping_add(u32::from_le_bytes(
                long.try_into().expect("the program is whole longs"),
            ));
        }
        for byte in chunk {
            out.extend_from_slice(format!(" {byte:02x}").as_bytes());
        }
        out.extend_from_slice(b" > ");
    }
    for byte in CHECKSUM_MAGIC.wrapping_sub(sum).to_le_bytes() {
        out.extend_from_slice(format!(" {byte:02x}").as_bytes());
    }
    out.push(b'?');
    out
}

/// A running `mad-serial-boot.toml`.
struct Rig {
    system: SystemHandle,
    reports: Vec<Box<dyn Report>>,
    actor: Option<virtual_clock::Actor>,
    actors_before: usize,
    _clock: MutexGuard<'static, ()>,
}

impl Rig {
    /// Build `project` with the set, start it with time held, release it
    /// and settle to [`SETTLE_NS`].
    fn start(project: Project) -> Self {
        let lock = clock();
        let actors_before = virtual_clock::registered_actors();
        virtual_clock::init_mode(ClockMode::Stepped, 1_000_000);
        // Held from zero across the build, as `embsim run` holds it: the
        // converter's protocol thread joins the clock as an actor when it is
        // built.
        let hold = virtual_clock::take_time_authority();
        let reports = Reports::new();
        let system = project
            .instantiate_with(&set(), &reports)
            .expect("mad-serial-boot.toml builds with embsim's catalogs and MaD's")
            .hold_time()
            .start()
            .expect("the machine starts");
        drop(hold);
        let reports = reports.take();
        let actor = virtual_clock::register_actor("mad-serial-boot-case");
        system.release_time();
        virtual_clock::wait_virtual_ns(SETTLE_NS);
        Self {
            system,
            reports,
            actor: Some(actor),
            actors_before,
            _clock: lock,
        }
    }

    /// Every summary line of the reports on `subject`.
    fn summary(&mut self, subject: &str) -> Vec<String> {
        self.reports
            .iter_mut()
            .filter(|report| report.subject() == subject)
            .flat_map(|report| report.summary())
            .collect()
    }

    /// Why a report on `subject` says its subject failed, if one does.
    fn failure(&mut self, subject: &str) -> Option<String> {
        self.reports
            .iter_mut()
            .filter(|report| report.subject() == subject)
            .find_map(|report| report.failure())
    }

    /// Step the board [`STEP_NS`] from `at`, stopping the case if the core
    /// has failed.
    fn step(&mut self, at: &mut u64) {
        virtual_clock::wait_virtual_ns(STEP_NS);
        *at += STEP_NS;
        if let Some(failure) = self.failure("EC32.U100") {
            panic!("the core failed at {at} ns: {failure}");
        }
    }

    /// End the case: no quiescence timeout among the run's findings, and
    /// every actor the run added gone.
    fn finish(mut self) {
        drop(self.actor.take());
        let findings = self.system.findings();
        let stalled: Vec<&Finding> = findings
            .iter()
            .filter(|finding| matches!(finding, Finding::QuiescenceTimeout { .. }))
            .collect();
        assert!(
            stalled.is_empty(),
            "the engine stopped waiting for the case's thread: {stalled:?}"
        );
        self.system.shutdown();
        let start = Instant::now();
        while virtual_clock::registered_actors() > self.actors_before {
            assert!(
                start.elapsed() < THREAD_END_HANG,
                "an actor outlived its system: {:?}",
                virtual_clock::registered_actor_names()
            );
            std::thread::sleep(Duration::from_millis(1));
        }
    }
}

/// The host's end of the line: the PTY `host-serial` made, which the case
/// writes, and a thread of the case's own reads into `received`. That thread
/// is no actor: it reads what the PTY holds and touches no clock.
struct HostPort {
    port: std::fs::File,
    received: Arc<Mutex<Vec<u8>>>,
}

impl HostPort {
    fn open(path: &Path) -> Self {
        let port = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(path)
            .expect("the host's PTY opens");
        let mut reader = port.try_clone().expect("the PTY's handle clones");
        let received = Arc::<Mutex<Vec<u8>>>::default();
        let sink = Arc::clone(&received);
        // The read ends, with an error or the end of the file, once the
        // run's shutdown closes the PTY.
        std::thread::spawn(move || {
            let mut buf = [0u8; 512];
            while let Ok(n @ 1..) = reader.read(&mut buf) {
                sink.lock()
                    .expect("the host's buffer is never poisoned")
                    .extend_from_slice(&buf[..n]);
            }
        });
        Self { port, received }
    }

    fn received(&self) -> Vec<u8> {
        self.received
            .lock()
            .expect("the host's buffer is never poisoned")
            .clone()
    }

    fn send(&mut self, bytes: &[u8]) {
        self.port.write_all(bytes).expect("the host writes");
        self.port.flush().expect("the host flushes");
    }
}

/// Send `request` at `at` and step the board until what the host received
/// after it holds `answer`, for at most [`ANSWER_WAIT_NS`]. The instant it
/// was found.
fn exchange(rig: &mut Rig, host: &mut HostPort, request: &[u8], answer: &[u8], at: u64) -> u64 {
    let from = host.received().len();
    host.send(request);
    let mut now = at;
    loop {
        rig.step(&mut now);
        let received = host.received();
        if received[from..]
            .windows(answer.len())
            .any(|window| window == answer)
        {
            return now;
        }
        assert!(
            now - at < ANSWER_WAIT_NS,
            "no {:?} in {} ns of board time after {:?}: the host received {:?}; {:?}",
            String::from_utf8_lossy(answer),
            now - at,
            String::from_utf8_lossy(request),
            String::from_utf8_lossy(&received[from..]),
            rig.summary("EC32.U100"),
        );
    }
}

/// What the chip has written on `P62` since its last line end, as the core's
/// summary says it (`P62 ".B", its line not ended`), if anything.
fn unended_console(rig: &mut Rig) -> Option<String> {
    rig.summary("EC32.U100").iter().find_map(|line| {
        let quoted = line
            .strip_suffix(", its line not ended")?
            .strip_prefix("P62 ")?;
        Some(quoted.trim_matches('"').to_string())
    })
}

/// Send `request` at `at` and step the board until the chip has written the
/// ROM's status character on `P62`, for at most [`ANSWER_WAIT_NS`]: the
/// instant, and what it wrote.
///
/// Read from the core's report, not the host's line: the ROM writes the
/// character, waits until the transmit pin reads idle, and clears the pin
/// (`rom_booter_v33k.spin2`, `transmit` and `reset_pins`), and the
/// simulator's transmit pin never reads busy, so the character is cut short
/// on the wire (MaD #295).
fn status(rig: &mut Rig, host: &mut HostPort, request: &[u8], at: u64) -> (u64, String) {
    host.send(request);
    let mut now = at;
    loop {
        rig.step(&mut now);
        if let Some(text) = unended_console(rig).filter(|text| !text.is_empty()) {
            return (now, text);
        }
        assert!(
            now - at < ANSWER_WAIT_NS,
            "the chip wrote no status in {} ns of board time after {:?}; {:?}",
            now - at,
            String::from_utf8_lossy(request),
            rig.summary("EC32.U100"),
        );
    }
}

#[test]
fn the_boot_rom_takes_the_flashers_ram_load_on_the_debug_header() {
    behaviour!(Test {
        id: "mad-project.serial-boot-ram-load",
        covers: Some("SIL/mad-serial-boot.toml"),
        given: "the machine's project file set for the ROM's serial boot with the module's \
                flash erased, and a serial-port host on the carrier's debug header doing what the \
                app's flasher does at 2 000 000 baud: the boot ROM's check-device probe, then a \
                twelve-byte program as hex with its checksum",
    });
    expect!(
        "version-reply",
        "the host receives the boot ROM's reply naming the chip's version, G, within 10 ms \
         of board time of the probe",
        "with P59 pulled up the ROM waits for a serial boot on P63, measures the host's rate \
         on the probe's leading '>' and answers on P62; the debug header carries both pins \
         straight to the chip"
    );
    expect!(
        "checksum-accepted",
        "within 10 ms of board time of the checksum the chip writes '.', its acceptance, on \
         its transmit pin",
        "the ROM accepts only when the program's longs and the host's complement sum to \
         \"Prop\": every byte, and the separators the flasher puts between lines, reached \
         its receiver intact"
    );
    let dir = scratch("ram-load");
    let pty = dir.join("host.pty");
    let mut project = Project::load(sil().join("mad-serial-boot.toml"))
        .expect("SIL/mad-serial-boot.toml loads")
        .relative_to(&dir);
    project
        .set_component_option("HOST", "path", pty.to_str().expect("UTF-8"))
        .expect("the file has a HOST");
    let mut rig = Rig::start(project);
    let mut host = HostPort::open(&pty);

    let replied_at = exchange(&mut rig, &mut host, PROBE, VERSION_REPLY, SETTLE_NS);
    let (accepted_at, written) = status(&mut rig, &mut host, &hex_load(&PROGRAM), replied_at);
    let core = rig.summary("EC32.U100");
    assert!(
        written.starts_with('.'),
        "the chip wrote {written:?} after the checksum, not '.': {core:#?}"
    );
    eprintln!(
        "the version reply by {replied_at} ns, the checksum accepted by {accepted_at} ns; the \
         host received {:?}; the core's summary: {core:#?}",
        String::from_utf8_lossy(&host.received()),
    );
    rig.finish();
}
