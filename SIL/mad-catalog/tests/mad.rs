//! `SIL/mad.toml`, the machine as it runs, stepped: the Edge carrier, the
//! P2-EC32MB module in its socket with MaD's instruction-set simulator as
//! its processor booting off the module's flash, the module's card, the
//! DS2 add-on on the force cable, the machine on the carrier's connectors
//! and a `host-serial` on the Raspberry Pi's connector `J4` (embsim
//! `MIGRATING-MAD.md` step 9). The file is loaded with `Project::load` and
//! built with the set `mad-runner` runs (`embsim_cli::shipped()` and
//! `mad_catalog::register`), as embsim's `board/tests/edge_project_live.rs`
//! builds its file; its paths are made relative to a scratch directory
//! holding the two images it names, laid out as `make flash-image` and
//! `make sd-image` lay them out.
//!
//! What the board as drawn does, held as the plan's checks are (`NODES.md`
//! §13, review item 1):
//!
//! - **The host's line.** A byte from the host crosses the isolator `IC2` to
//!   the carrier's `P53`, and stops there: the P2-EC32MB has no finger for
//!   `P40`–`P57`, which it keeps for its PSRAMs (embsim
//!   `boards/netlists/p2_ec32mb.net`), so the chip's own `P53` and `P55` are
//!   the PSRAM's pins. The `propeller2_debug` firmware's MAIN channel is
//!   `P53`/`P55` (`HW_pins.h`): it transmits on `P55` at 2 Mbaud, and the
//!   host on `J4` receives nothing.
//! - **The inputs at rest.** The end switches, the door and the emergency
//!   stops each present the level the firmware reads as inactive.
//! - **The drive.** `IC14`, the isolator between the processor and the
//!   drive, has its secondary ground pins on a net of their own (embsim
//!   `board/tests/edgeboard.rs`; the layout has the same pads on the same
//!   net, `Hardware/EdgeBoard/KiCad/MaD_Edge.kicad_pcb`), so nothing it
//!   drives reaches the drive's step, direction and enable inputs, and its
//!   output to `P5` gives its default high whatever the drive's ready
//!   output says.
//! - **The encoder.** With the drive's inputs driven from the bench (the
//!   carrier's own path to them is `IC14`'s) and the chip held in reset
//!   from the debug header, the drive turns the encoder, whose pairs reach
//!   `P9` and `P10` through the line receiver `U25` and the isolator
//!   `IC16`; with the machine's real NPN open-collector encoder on the `+`
//!   legs and the ground jumpers closed, `P9` and `P10` stay high and the
//!   run names `U25`'s pairs (embsim `board/tests/edge_encoder_pairs.rs`).
//!   The bench, the probes and the open collector's three changes are the
//!   cases' own, added to the file as loaded; the file is unchanged.
//!
//! Stepped (`TESTING.md` rule 9): the clock stepped before the project
//! builds (the converter's protocol thread joins it as an actor), the
//! system started with time held, the case's thread a registered actor;
//! every assertion is on virtual time and the board's state. Each case
//! skips, saying why, when the `propeller2_debug` image is absent (`make
//! p2image`), as `tests/boot.rs` does; `MAD_REQUIRE_P2_IMAGE` turns the
//! skip into a failure. The cases take one lock: the clock is the
//! process's.

use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use embsim_board::net::DEFAULT_PUSH_PULL_IMPEDANCE;
use embsim_board::{
    jesd8c01_lvcmos_thresholds, AttachError, Component, ComponentNetIo, DeadBand, EndpointRef,
    Finding, Harness, Level, NetState, PinDecl, Project, Report, Reports, ScriptedSource, Step,
    SystemHandle,
};
use embsim_boards::catalog::CatalogSet;
use embsim_boards::p2::P2_RESTART_DELAY_NS;
use embsim_core::virtual_clock::{self, ClockMode};
use embsim_models::ads122u04_component::PUMP_POLL_VIRTUAL_US;
use embsim_models::oscillator::TG2520SMN_START_UP_NS;
use embsim_models::rail::AP62301_SOFT_START_NS;
use vibes_behaviour::{behaviour, expect, Test};

// ============================================================
// The set, the file and its images
// ============================================================

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

/// The `propeller2_debug` program: `MAD_P2_IMAGE` names a copy kept out of
/// `.pio` (the ledger job's), else the build's own.
fn image_path() -> PathBuf {
    let p = std::env::var_os("MAD_P2_IMAGE").map_or_else(
        || sil().join("../Firmware/MaDCore/.pio/build/propeller2_debug/program"),
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

/// The card's size: what `make sd-image` writes.
const CARD_BYTES: usize = 32 * 1024 * 1024;

/// A directory of the case's own under Cargo's scratch directory for
/// integration tests, holding the two images `mad.toml` names at the paths
/// it names them by (`build/flash.bin`, `build/sd.img`): the flash laid out
/// from the `propeller2_debug` program by `embsim flash-image`, the command
/// `make flash-image` runs, here in process; the card `make sd-image`
/// writes, `SIL/sd` mirrored onto it when it is there. `None`, having said
/// why, without the program.
fn images(case: &str) -> Option<(PathBuf, u64)> {
    let image = image_path();
    let Ok(program) = std::fs::metadata(&image) else {
        eprintln!(
            "\n*** SKIPPED: {}::{case} needs the P2 image at\n***   {}\n*** Build it with `make \
             p2image`.\n*** This test asserted NOTHING.\n",
            module_path!(),
            image.display()
        );
        return None;
    };
    let dir = Path::new(env!("CARGO_TARGET_TMPDIR"))
        .join("mad-catalog-mad")
        .join(case);
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
    Some((dir, program.len()))
}

/// `mad.toml`'s text.
fn mad_toml() -> String {
    std::fs::read_to_string(sil().join("mad.toml")).expect("SIL/mad.toml reads")
}

/// `text` with `old` replaced by `new`, `old` there exactly once.
fn replaced(text: &str, old: &str, new: &str) -> String {
    assert_eq!(text.matches(old).count(), 1, "mad.toml has {old:?} once");
    text.replacen(old, new, 1)
}

// ============================================================
// The run
// ============================================================

/// The runs share the process's one virtual clock.
static CLOCK: Mutex<()> = Mutex::new(());

fn clock() -> MutexGuard<'static, ()> {
    CLOCK.lock().unwrap_or_else(|poisoned| {
        CLOCK.clear_poison();
        poisoned.into_inner()
    })
}

/// The virtual time the run is handed before it reads: 10.1 ms, past the
/// longest chain the boards arm from their supplies (the module's bucks'
/// 2.5 ms soft-start, the P2's 3 ms restart, the TCXO's 1 ms start-up), and
/// off the converter pump's 250 µs polls, as `edge_project_live.rs` settles
/// it. The core starts at 5.5 ms and runs its ROM from then on.
const SETTLE_NS: u64 = 10_100_000;
const _: () =
    assert!(SETTLE_NS > AP62301_SOFT_START_NS + P2_RESTART_DELAY_NS + TG2520SMN_START_UP_NS);
const _: () = assert!(!SETTLE_NS.is_multiple_of(PUMP_POLL_VIRTUAL_US * 1_000));

/// How long, in wall time, a case waits for the converter's protocol
/// thread to end after the system shuts down: sized for a hang.
const THREAD_END_HANG: Duration = Duration::from_secs(20);

/// What a probe saw on its net: each state the engine reported, in order.
type Seen = Arc<Mutex<Vec<NetState>>>;

/// A bench probe: one digital input that records every state the engine
/// reports for its net (`ComponentNetIo::on_net_report`, the instrument's
/// subscription). It drives nothing. A probe names no threshold of its own,
/// so it reads through JESD8C.01's 3.3 V LVCMOS pair, the P2's own bank
/// voltage; a digital input keeps the net's report the engine's digital
/// projection, as the P2's released pad there would.
struct Probe {
    seen: Seen,
}

const PROBE_PINS: [PinDecl; 1] = [PinDecl::digital_in(
    "IN",
    jesd8c01_lvcmos_thresholds(DeadBand::Unknown),
)];

impl Component for Probe {
    fn pins(&self) -> &[PinDecl] {
        &PROBE_PINS
    }

    fn attach(&mut self, io: ComponentNetIo) -> Result<(), AttachError> {
        let seen = Arc::clone(&self.seen);
        io.on_net_report("IN", move |state| {
            seen.lock()
                .expect("the probe's log is never poisoned")
                .push(state);
        })
    }
}

fn ep(endpoint: &str) -> EndpointRef {
    EndpointRef::parse(endpoint).expect("endpoint parses")
}

/// A running `mad.toml`.
struct Rig {
    system: SystemHandle,
    reports: Vec<Box<dyn Report>>,
    probes: Vec<(String, Seen)>,
    actor: Option<virtual_clock::Actor>,
    actors_before: usize,
    _clock: MutexGuard<'static, ()>,
}

/// A bench component a case adds, its one pin wired to an endpoint.
struct BenchPart {
    name: String,
    part: Box<dyn Component>,
    /// The part's pin, as `NAME.PIN`, and the endpoint it is wired to.
    wire: (String, String),
}

/// What a case adds to the file's system: bench components, and probes on
/// connector pins, each `(name, connector pin)`.
#[derive(Default)]
struct Bench {
    components: Vec<BenchPart>,
    probes: Vec<(String, String)>,
}

impl Bench {
    /// A probe named `name` on the connector pin `at`.
    fn probe(mut self, name: &str, at: &str) -> Self {
        self.probes.push((name.to_string(), at.to_string()));
        self
    }

    /// A bench component `name`, its pin `pin` wired to `to`.
    fn component(mut self, name: &str, part: Box<dyn Component>, pin: &str, to: &str) -> Self {
        self.components.push(BenchPart {
            name: name.to_string(),
            part,
            wire: (format!("{name}.{pin}"), to.to_string()),
        });
        self
    }
}

impl Rig {
    /// Build `project` with the set and `bench`, start it with time held,
    /// release it and settle to [`SETTLE_NS`].
    fn start(project: Project, bench: Bench) -> Self {
        let lock = clock();
        let actors_before = virtual_clock::registered_actors();
        virtual_clock::init_mode(ClockMode::Stepped, 1_000_000);
        // Held from zero across the build, as `embsim run` holds it: the
        // converter's protocol thread joins the clock as an actor when it is
        // built, and with nothing else holding time its waits would run the
        // clock on before the system starts.
        let hold = virtual_clock::take_time_authority();
        let reports = Reports::new();
        let mut system = project
            .instantiate_with(&set(), &reports)
            .expect("mad.toml builds with embsim's catalogs and MaD's");
        let mut harness = Harness::new();
        let mut probes = Vec::new();
        for (name, at) in bench.probes {
            let seen = Seen::default();
            system = system.component(
                &name,
                Box::new(Probe {
                    seen: Arc::clone(&seen),
                }),
            );
            harness = harness.connect(ep(&format!("{name}.IN")), ep(&at));
            probes.push((name, seen));
        }
        for BenchPart { name, part, wire } in bench.components {
            system = system.component(&name, part);
            harness = harness.connect(ep(&wire.0), ep(&wire.1));
        }
        let system = system
            .harness(harness)
            .hold_time()
            .start()
            .expect("the machine starts");
        // The live engine holds its own authority from here.
        drop(hold);
        let reports = reports.take();
        let actor = virtual_clock::register_actor("mad-project-case");
        system.release_time();
        virtual_clock::wait_virtual_ns(SETTLE_NS);
        Self {
            system,
            reports,
            probes,
            actor: Some(actor),
            actors_before,
            _clock: lock,
        }
    }

    /// The level a net reads, driven or pulled; `None` for anything else.
    fn level(&self, net: &str) -> Option<Level> {
        match self.system.net_state(net) {
            Some(NetState::Driven(level) | NetState::Pulled(level, _)) => Some(level),
            _ => None,
        }
    }

    fn state(&self, net: &str) -> Option<NetState> {
        self.system.net_state(net)
    }

    /// The reports whose subject is `subject`: a part can have several (the
    /// P2's package and its core both report under the part).
    fn reports(&mut self, subject: &str) -> impl Iterator<Item = &mut Box<dyn Report>> {
        let subject = subject.to_string();
        self.reports
            .iter_mut()
            .filter(move |report| report.subject() == subject)
    }

    /// What every report on `subject` says at a look at `now_ns`.
    fn look(&mut self, subject: &str, now_ns: u64) -> Vec<String> {
        self.reports(subject)
            .flat_map(|report| report.look(now_ns))
            .collect()
    }

    /// Why a report on `subject` says its subject failed, if one does.
    fn failure(&mut self, subject: &str) -> Option<String> {
        self.reports(subject).find_map(|report| report.failure())
    }

    /// The summary line of `subject`'s that holds `holds`.
    fn summary_line(&mut self, subject: &str, holds: &str) -> String {
        let lines: Vec<String> = self
            .reports(subject)
            .flat_map(|report| report.summary())
            .collect();
        lines
            .iter()
            .find(|line| line.contains(holds))
            .cloned()
            .unwrap_or_else(|| panic!("{subject}'s summary has a line {holds:?}: {lines:?}"))
    }

    /// The first line of `subject`'s summary.
    fn summary(&mut self, subject: &str) -> String {
        self.reports(subject)
            .flat_map(|report| report.summary())
            .next()
            .unwrap_or_default()
    }

    /// What the probe `name` saw.
    fn seen(&self, name: &str) -> Vec<NetState> {
        let (_, seen) = self
            .probes
            .iter()
            .find(|(probe, _)| probe == name)
            .unwrap_or_else(|| panic!("the case has a probe {name}"));
        seen.lock()
            .expect("the probe's log is never poisoned")
            .clone()
    }

    /// The number the host's summary gives before `what`: `N bytes from the
    /// host`, `N to it`.
    fn host_count(&mut self, what: &str) -> u64 {
        let summary = self.summary("HOST");
        summary
            .split(", ")
            .flat_map(|part| part.rsplit(": ").next())
            .find_map(|part| part.strip_suffix(what))
            .and_then(|count| count.trim().parse().ok())
            .unwrap_or_else(|| panic!("the host's summary gives {what:?}: {summary}"))
    }

    /// The encoder's count, from the machine's summary.
    fn encoder_count(&mut self) -> i64 {
        let summary = self.summary("MACHINE");
        summary
            .strip_prefix("encoder at ")
            .and_then(|rest| rest.split_once(" counts"))
            .and_then(|(count, _)| count.parse().ok())
            .unwrap_or_else(|| panic!("the machine's summary gives the count: {summary}"))
    }

    /// End the case: the findings the run made, with no quiescence timeout
    /// among them, and every actor the run added gone.
    fn finish(mut self) -> Vec<Finding> {
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
        findings
    }
}

/// `mad.toml`, its paths relative to `dir`.
fn load(dir: &Path) -> Project {
    Project::load(sil().join("mad.toml"))
        .expect("SIL/mad.toml loads")
        .relative_to(dir)
}

/// The number of times the states `seen` go from a high to a low.
fn falls(seen: &[NetState]) -> usize {
    let level = |state: &NetState| match state {
        NetState::Driven(level) | NetState::Pulled(level, _) => Some(*level),
        _ => None,
    };
    seen.windows(2)
        .filter(|pair| level(&pair[0]) == Some(Level::High) && level(&pair[1]) == Some(Level::Low))
        .count()
}

// ============================================================
// At rest: the host's line and the inputs
// ============================================================

/// What the host sends: sixteen zero bytes, each a start bit and eight data
/// bits low, so each crosses as one fall.
const HOST_BYTES: [u8; 16] = [0; 16];

/// The step the case hands the engine while the host's bytes cross, and the
/// most board time it waits for them: they take 80 µs on the wire at 2
/// Mbaud, from whenever the host's port hands them over.
const BYTE_WAIT_STEP_NS: u64 = 10_000;
const BYTE_WAIT_NS: u64 = 20_000_000;

/// How long, in wall time, the case waits for the host's port to take the
/// bytes it wrote: sized for a hang.
const HOST_HANG: Duration = Duration::from_secs(120);

#[test]
fn the_host_line_and_the_inputs_at_rest() {
    behaviour!(Test {
        id: "mad-project.at-rest",
        covers: Some("SIL/mad.toml"),
        given: "the machine's project file, its host a serial port on the carrier's Raspberry \
                Pi connector, run 10 ms past every supply's start-up, then the host sending \
                sixteen zero bytes",
    });
    expect!(
        "host-reaches-p53",
        "the carrier's P53 falls once for each of the host's bytes and rests high once they \
         have crossed",
        "the isolator IC2 passes the host's lows as valid lows; its Pi side runs from the Pi's \
         5 volts, so the host's 3.3 volt high is no valid level there, and IC2 gives its \
         default high for it"
    );
    expect!(
        "chip-unreached",
        "the chip's own P53 pin reads no source after the bytes have crossed",
        "the P2-EC32MB module has no finger for P40 to P57, which it keeps for its memory \
         chips, so the carrier's P53 ends at the module's socket"
    );
    expect!(
        "switches-inactive",
        "P19 to P21, the end switches' and the door's inputs, read low, the level the firmware \
         reads as inactive",
        "the end switches and the door rest closed, and current in a loop pulls its input low \
         through the loop's optocoupler"
    );
    expect!(
        "stops-inactive",
        "P16 to P18, the emergency stops' inputs, read high, the level the firmware reads as \
         inactive",
        "the emergency stops rest open, so no current lights their optocouplers"
    );
    expect!(
        "enable-unreached",
        "the drive's enable input reads no source",
        "the servo isolator IC14's secondary ground pins are on a net of their own, so its \
         outputs toward the drive have no return and stay released"
    );
    expect!(
        "ready-unread",
        "P5, the firmware's drive-ready input, reads high while the drive holds its ready line \
         low",
        "IC14's secondary side, where the ready line enters, has no ground, so it gives its \
         default high on P5"
    );
    expect!(
        "receiver-over-range",
        "the run reports the line receiver U25's supply once, at 5 volts, above its \
         recommended 3.6 volts"
    );
    expect!(
        "isolator-ground-unsourced",
        "the run reports the net of IC14's secondary ground pins as a power net no source \
         reaches"
    );
    let Some((dir, _)) = images("at-rest") else {
        return;
    };
    let pty = dir.join("host.pty");
    let mut project = load(&dir);
    project
        .set_component_option("HOST", "path", pty.to_str().expect("UTF-8"))
        .expect("the file has a HOST");
    let mut rig = Rig::start(project, Bench::default().probe("PROBE_P53", "EDGE.J3.61"));

    for net in ["EDGE.P19", "EDGE.P20", "EDGE.P21"] {
        assert_eq!(
            rig.level(net),
            Some(Level::Low),
            "{net}: {:?}",
            rig.state(net)
        );
    }
    for net in ["EDGE.P16", "EDGE.P17", "EDGE.P18"] {
        assert_eq!(
            rig.level(net),
            Some(Level::High),
            "{net}: {:?}",
            rig.state(net)
        );
    }
    assert_eq!(
        rig.state("EDGE./MaD_Edge_Sheet3/SC_ENA"),
        Some(NetState::Floating)
    );
    assert_eq!(
        rig.state("EDGE./MaD_Edge_Sheet3/SC_SRDY"),
        Some(NetState::Driven(Level::Low))
    );
    assert_eq!(
        rig.level("EDGE.P5"),
        Some(Level::High),
        "{:?}",
        rig.state("EDGE.P5")
    );
    assert_eq!(
        rig.level("EDGE.P53"),
        Some(Level::High),
        "the line idles high: {:?}",
        rig.state("EDGE.P53")
    );
    // From the probe's last report before the bytes: the line idling high.
    let before = rig.seen("PROBE_P53").len() - 1;

    let mut host = std::fs::OpenOptions::new()
        .write(true)
        .open(&pty)
        .expect("the host's PTY opens");
    host.write_all(&HOST_BYTES).expect("the host writes");
    host.flush().expect("the host flushes");
    let wall = Instant::now();
    let mut waited = 0;
    loop {
        let taken = rig.host_count(" bytes from the host");
        let crossed = falls(&rig.seen("PROBE_P53")[before..]);
        if taken == HOST_BYTES.len() as u64 && crossed == HOST_BYTES.len() {
            break;
        }
        assert!(
            waited < BYTE_WAIT_NS && wall.elapsed() < HOST_HANG,
            "the host's port took {taken} bytes and P53 fell {crossed} times in {waited} ns \
             of board time: {}",
            rig.summary("HOST")
        );
        virtual_clock::wait_virtual_ns(BYTE_WAIT_STEP_NS);
        waited += BYTE_WAIT_STEP_NS;
    }
    // The last byte's stop bit, and the line idle after it.
    virtual_clock::wait_virtual_ns(BYTE_WAIT_STEP_NS);
    assert_eq!(falls(&rig.seen("PROBE_P53")[before..]), HOST_BYTES.len());
    assert_eq!(
        rig.level("EDGE.P53"),
        Some(Level::High),
        "the line idles high again"
    );
    assert_eq!(rig.state("EC32.P2_IO53"), Some(NetState::Floating));
    assert_eq!(rig.host_count(" framing errors"), 0);

    let findings = rig.finish();
    let u25 = findings.iter().filter(|finding| {
        matches!(finding, Finding::PinAboveRecommended { part, pin, volts, max, .. }
            if part == "EDGE.U25" && pin == "16" && (*volts - 5.0).abs() < 1e-9
                && (*max - 3.6).abs() < 1e-9)
    });
    assert_eq!(u25.count(), 1, "{findings:?}");
    assert!(
        findings.contains(&Finding::PowerNetUnsourced {
            net: "EDGE.Net-(IC14-GND2_1)".to_string(),
        }),
        "{findings:?}"
    );
}

// ============================================================
// The firmware booted: its main channel
// ============================================================

/// The START instant: the module's reset releases at 2.5 ms (the AP62301
/// bucks' soft-start) and the chip starts 3 ms after.
const START_NS: u64 = AP62301_SOFT_START_NS + P2_RESTART_DELAY_NS;

/// Board time stage-1 takes a byte of the program, with room: it streams
/// the flash at about 3.84 µs a byte (`tests/boot.rs`, measured).
const STAGE1_NS_PER_BYTE: u64 = 4_000;

/// Board time from the program's first instruction to its serial cores
/// running and its force gauge started, with room: on this file the first
/// console line ended at 1261.5 ms, the serial core started at 1290.0 ms
/// and the force gauge at 1394.4 ms, with a 326 704-byte program
/// (measured).
const FIRMWARE_UP_NS: u64 = 150_000_000;

/// The board time between two looks at the core while it boots.
const BOOT_LOOK_NS: u64 = 50_000_000;

/// The firmware's MAIN channel rate (`HAL_serial_config.c`).
const MAIN_BAUD: f64 = 2_000_000.0;

#[test]
fn the_firmware_boots_and_its_main_channel_never_reaches_the_pi() {
    behaviour!(Test {
        id: "mad-project.firmware-main-channel",
        covers: Some("SIL/mad.toml"),
        given: "the machine's project file, a serial port on the carrier's Raspberry Pi \
                connector, run until the firmware has booted off the module's flash and \
                started its serial and force-gauge cores",
    });
    expect!(
        "first-line",
        "the core's report gives the firmware's first console line, Starting MaD Board"
    );
    expect!(
        "gauge-started",
        "the firmware reports that it has started the force gauge's converter",
        "the firmware starts the converter only once every register it wrote reads back as \
         written, over the force cable and the carrier's isolator"
    );
    expect!(
        "main-transmits",
        "the firmware transmits on the chip's P55, at 2 000 000 baud within 0.1 percent"
    );
    expect!(
        "pi-hears-nothing",
        "the Pi's receive line stays high and the host receives no byte",
        "the chip's P55 is the module's memory chip's pin; the carrier's P55, the isolator's \
         input for the Pi's receive line, ends at the module's socket"
    );
    expect!(
        "carrier-p55-unsourced",
        "the carrier's P55 reads no source from power-up on, while the chip's P55 is driven"
    );
    let Some((dir, program)) = images("firmware") else {
        return;
    };
    let mut project = load(&dir);
    project
        .set_component_option(
            "HOST",
            "path",
            dir.join("host.pty").to_str().expect("UTF-8"),
        )
        .expect("the file has a HOST");
    let mut rig = Rig::start(
        project,
        Bench::default()
            .probe("RPI_TX", "EDGE.J4.2")
            .probe("P55", "EDGE.J3.59"),
    );

    let run_ns = START_NS + program * STAGE1_NS_PER_BYTE + FIRMWARE_UP_NS;
    let mut at = SETTLE_NS;
    let mut console = Vec::new();
    while at < run_ns {
        let step = BOOT_LOOK_NS.min(run_ns - at);
        virtual_clock::wait_virtual_ns(step);
        at += step;
        console.extend(rig.look("EC32.U100", at));
        if let Some(failure) = rig.failure("EC32.U100") {
            panic!("the core failed at {at} ns: {failure}\n{console:#?}");
        }
    }
    let _ = writeln!(std::io::stderr(), "EC32.U100 said:\n{console:#?}");

    assert_eq!(
        console
            .iter()
            .find(|line| line.starts_with("P62 "))
            .map(String::as_str),
        Some("P62 \"Starting MaD Board\""),
        "{console:#?}"
    );
    assert!(
        console
            .iter()
            .any(|line| line.contains("ADS122U04 Started")),
        "the firmware started its force gauge within {run_ns} ns: {console:#?}"
    );

    let core = rig.summary_line("EC32.U100", " cogs running; ");
    let baud: f64 = core
        .split_once("P55 at ")
        .and_then(|(_, rest)| rest.split_once(" baud"))
        .and_then(|(baud, _)| baud.parse().ok())
        .unwrap_or_else(|| panic!("the core transmitted on P55: {core}"));
    assert!(
        (baud - MAIN_BAUD).abs() / MAIN_BAUD < 0.001,
        "P55 at {baud} baud: {core}"
    );
    assert!(
        matches!(rig.state("EC32.P2_IO55"), Some(NetState::Driven(_))),
        "the chip drives its P55: {:?}",
        rig.state("EC32.P2_IO55")
    );

    let rpi_tx = rig.seen("RPI_TX");
    assert!(
        !rpi_tx.is_empty(),
        "the probe on the Pi's receive line reported"
    );
    assert!(
        rpi_tx
            .iter()
            .all(|state| *state == NetState::Driven(Level::High)),
        "the Pi's receive line: {rpi_tx:?}"
    );
    assert_eq!(rig.host_count(" to it"), 0, "{}", rig.summary("HOST"));
    let p55 = rig.seen("P55");
    assert!(!p55.is_empty(), "the probe on the carrier's P55 reported");
    assert!(
        p55.iter().all(|state| *state == NetState::Floating),
        "the carrier's P55: {p55:?}"
    );
    rig.finish();
}

// ============================================================
// The encoder, turned by the drive
// ============================================================

/// The bench's drive on the drive's inputs: each a source behind embsim's
/// stated push-pull default, at the 5 V the line driver `U24` swings from
/// `SC_5V`. The test's own rig: the carrier's path to these inputs is
/// `IC14`'s, which as drawn drives nothing.
const BENCH_HIGH_V: f64 = 5.0;

/// The steps: the first rise 12.107 ms after the start, then one every
/// 2 ms, each 100 µs high, every instant off the converter pump's 250 µs
/// polls.
const FIRST_STEP_NS: u64 = 12_107_000;
const STEP_PERIOD_NS: u64 = 2_000_000;
const STEP_HIGH_NS: u64 = 100_000;
const STEPS: u64 = 8;
const _: () = assert!(FIRST_STEP_NS > SETTLE_NS);

/// The encoder is read every millisecond, half a millisecond off each step,
/// from before the first step until 150 ms after it. The drive folds its
/// steps into the carriage at a 1 ms observation, through a 20 ms velocity
/// lag (embsim's `StepperMotor`), so the carriage comes to rest well inside
/// the window, and at the drive's 500 steps a second it moves less than a
/// count between two reads.
const FIRST_READ_NS: u64 = FIRST_STEP_NS + 500_000;
const READ_EVERY_NS: u64 = 1_000_000;
const READS: u64 = 150;
const _: () = assert!(!FIRST_READ_NS.is_multiple_of(PUMP_POLL_VIRTUAL_US * 1_000));

fn source(steps: Vec<Step>) -> Box<dyn Component> {
    Box::new(ScriptedSource::new(DEFAULT_PUSH_PULL_IMPEDANCE, steps).expect("a valid source"))
}

/// A source at 0 V from the start.
fn held_low() -> Box<dyn Component> {
    source(vec![Step {
        at_ns: 0,
        volts: 0.0,
    }])
}

/// The drive's inputs from the bench: enabled (its enable is active low)
/// and forward (direction low) from the start, and [`STEPS`] steps; and the
/// chip held in reset from the debug header's `RESn` (`J1.3`), so the
/// processor runs nothing while the bench turns the drive: its pads,
/// `P9` and `P10` among them, rest released, as they do while its ROM
/// runs.
fn bench_drive(bench: Bench) -> Bench {
    let mut steps = vec![Step {
        at_ns: 0,
        volts: 0.0,
    }];
    for k in 0..STEPS {
        let rise = FIRST_STEP_NS + k * STEP_PERIOD_NS;
        steps.push(Step {
            at_ns: rise,
            volts: BENCH_HIGH_V,
        });
        steps.push(Step {
            at_ns: rise + STEP_HIGH_NS,
            volts: 0.0,
        });
    }
    bench
        .component("BENCH_RESET", held_low(), "OUT", "EDGE.J1.3")
        .component("BENCH_ENA", held_low(), "OUT", "MACHINE.ENA")
        .component("BENCH_DIR", held_low(), "OUT", "MACHINE.DIR")
        .component("BENCH_STEP", source(steps), "OUT", "MACHINE.STEP")
}

/// One read of the encoder: its count, then what `P9` and `P10` read.
type Read = (i64, Option<Level>, Option<Level>);

/// Read the encoder every millisecond through the bench's steps and the
/// carriage coming to rest: the first read, then each read whose count
/// differs from the one before it.
fn walk(rig: &mut Rig) -> Vec<Read> {
    let read = |rig: &mut Rig| {
        (
            rig.encoder_count(),
            rig.level("EDGE.P9"),
            rig.level("EDGE.P10"),
        )
    };
    let mut seen = vec![read(rig)];
    let mut at = SETTLE_NS;
    for k in 0..READS {
        let deadline = FIRST_READ_NS + k * READ_EVERY_NS;
        virtual_clock::wait_virtual_ns(deadline - at);
        at = deadline;
        let now = read(rig);
        if now.0 != seen.last().expect("one read at least").0 {
            seen.push(now);
        }
    }
    seen
}

/// The chip stayed in reset the whole walk: the package's summary says the
/// core is held, never started.
fn assert_held_in_reset(rig: &mut Rig) {
    let package = rig.summary_line("EC32.U100", "core \"mad-p2iss\": ");
    assert!(package.contains(": held in reset"), "{package}");
}

/// The drive's steps commanded, from the machine's summary.
fn steps_commanded(rig: &mut Rig) -> i64 {
    let summary = rig.summary("MACHINE");
    summary
        .split_once(" steps commanded")
        .and_then(|(head, _)| head.rsplit(", ").next())
        .and_then(|steps| steps.parse().ok())
        .unwrap_or_else(|| panic!("the machine's summary gives its steps: {summary}"))
}

/// `U25`'s pairs the run reported as read inside their band, as `(pin,
/// inverting)`, each with the fail-safe high it took.
fn u25_pairs_reported(findings: &[Finding]) -> Vec<(String, String)> {
    findings
        .iter()
        .filter_map(|finding| match finding {
            Finding::PairInBand {
                part,
                pin,
                inverting,
                output,
                ..
            } => {
                assert_eq!(part, "EDGE.U25", "{finding}");
                assert_eq!(*output, Level::High, "{finding}");
                Some((pin.clone(), inverting.clone()))
            }
            _ => None,
        })
        .collect()
}

#[test]
fn the_encoders_pairs_reach_p9_and_p10() {
    behaviour!(Test {
        id: "mad-project.encoder-pairs",
        covers: Some("SIL/mad.toml"),
        given: "the machine's project file, a bench source holding the chip's reset low on the \
                carrier's debug header, and bench sources on the drive's inputs giving it eight \
                forward steps 2 ms apart",
    });
    expect!(
        "one-count-a-step",
        "the encoder passes through every count and comes to rest one count a step on, as \
         many as the drive was given",
        "the drive follows its steps through a 20 ms velocity lag, so the carriage comes to \
         rest after the last step"
    );
    expect!(
        "quadrature-on-p9-p10",
        "each count changes exactly one of P9 and P10, and every four counts they return to \
         the levels they started at",
        "the carrier's line receiver reads each of the encoder's pairs as a valid level and \
         the isolator after it passes the level to the module"
    );
    expect!(
        "pairs-silent",
        "no pair of the line receiver is reported inside its band"
    );
    let Some((dir, _)) = images("encoder-pairs") else {
        return;
    };
    let mut project = load(&dir);
    project
        .set_component_option(
            "HOST",
            "path",
            dir.join("host.pty").to_str().expect("UTF-8"),
        )
        .expect("the file has a HOST");
    let mut rig = Rig::start(project, bench_drive(Bench::default()));
    let read = walk(&mut rig);
    let counts: Vec<i64> = read.iter().map(|(count, _, _)| *count).collect();
    assert_eq!(counts, (0..=8).collect::<Vec<i64>>(), "{read:?}");
    assert_eq!(steps_commanded(&mut rig), 8, "{}", rig.summary("MACHINE"));
    assert_held_in_reset(&mut rig);
    for (k, pair) in read.windows(2).enumerate() {
        let ((_, a0, b0), (_, a1, b1)) = (pair[0], pair[1]);
        for level in [a0, b0, a1, b1] {
            assert!(
                level.is_some(),
                "P9 and P10 read a level at count {k}: {read:?}"
            );
        }
        let changed = u8::from(a0 != a1) + u8::from(b0 != b1);
        assert_eq!(changed, 1, "count {k} to {}: {read:?}", k + 1);
    }
    for (k, (now, later)) in read.iter().zip(&read[4..]).enumerate() {
        assert_eq!(
            (now.1, now.2),
            (later.1, later.2),
            "count {k} and count {}: {read:?}",
            k + 4
        );
    }
    let findings = rig.finish();
    assert!(u25_pairs_reported(&findings).is_empty(), "{findings:?}");
}

#[test]
fn the_machines_open_collector_encoder_sticks_p9_and_p10_high() {
    behaviour!(Test {
        id: "mad-project.open-collector-encoder",
        covers: Some("SIL/mad.toml"),
        given: "the machine's project file with the machine's real encoder, an NPN open \
                collector, on the + legs of the carrier's encoder connector, its ground jumpers \
                closed, and the bench holding the chip's reset low and giving the drive eight \
                forward steps",
    });
    expect!(
        "one-count-a-step",
        "the encoder passes through every count and comes to rest one count a step on, as \
         many as the drive was given"
    );
    expect!(
        "stuck-high",
        "P9 and P10 read high at every count",
        "the carrier has no pull-up on the + legs: a released output rests at the line \
         receiver's own input bias, a valid high against the grounded - leg, and a sinking \
         one leaves the pair no difference, which the AM26LV32 reads as its fail-safe high"
    );
    expect!(
        "pairs-reported",
        "the run reports the line receiver's A and B pairs, its pins 2 and 1 and its pins 6 \
         and 7, once each inside their band, their outputs high",
        "the AM26LV32's datasheet guarantees no level for a pair within 0.2 volts with a \
         common-mode voltage applied"
    );
    let Some((dir, _)) = images("open-collector") else {
        return;
    };
    // mad.toml's three changes for the open collector: the output stage,
    // no wire on the - legs (the stage has none), and JP2 and JP3 closed.
    let mut text = replaced(
        &mad_toml(),
        "\nencoder_output = \"rs422\"\n",
        "\nencoder_output = \"npn-open-collector\"\n",
    );
    for leg in [
        "MACHINE.ENC_A-\"\nto = \"EDGE.J20.2",
        "MACHINE.ENC_B-\"\nto = \"EDGE.J20.4",
    ] {
        text = replaced(&text, &format!("[[wire]]\nfrom = \"{leg}\"\n"), "");
    }
    text.push_str(
        "\n[[jumper]]\npart = \"EDGE.JP2\"\nstate = \"closed\"\n\n\
         [[jumper]]\npart = \"EDGE.JP3\"\nstate = \"closed\"\n",
    );
    let mut project = Project::parse(&text)
        .expect("the open-collector file is a project")
        .relative_to(&dir);
    project
        .set_component_option(
            "HOST",
            "path",
            dir.join("host.pty").to_str().expect("UTF-8"),
        )
        .expect("the file has a HOST");
    let mut rig = Rig::start(project, bench_drive(Bench::default()));
    let read = walk(&mut rig);
    let counts: Vec<i64> = read.iter().map(|(count, _, _)| *count).collect();
    assert_eq!(counts, (0..=8).collect::<Vec<i64>>(), "{read:?}");
    assert_eq!(steps_commanded(&mut rig), 8, "{}", rig.summary("MACHINE"));
    assert_held_in_reset(&mut rig);
    for (count, a, b) in &read {
        assert_eq!(
            (*a, *b),
            (Some(Level::High), Some(Level::High)),
            "at count {count}: {read:?}"
        );
    }
    let findings = rig.finish();
    let pair = |pin: &str, inverting: &str| (pin.to_string(), inverting.to_string());
    assert_eq!(
        u25_pairs_reported(&findings),
        [pair("2", "1"), pair("6", "7")],
        "{findings:?}"
    );
}
