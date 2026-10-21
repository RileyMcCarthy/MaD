//! `SIL/mad.toml`, the machine as it runs, stepped: the Edge carrier, the
//! P2-EC32MB module in its socket with MaD's instruction-set simulator as
//! its processor booting the production firmware off the module's flash,
//! the module's card, the DS2 add-on on the force cable, the machine on the
//! carrier's connectors and a `host-serial` on the carrier's debug header
//! `J1`, where the machine's Prop Plug sits (embsim `MIGRATING-MAD.md` step
//! 9). The file is loaded with `Project::load` and built with the set
//! `mad-runner` runs (`embsim_cli::shipped()` and `mad_catalog::register`),
//! as embsim's `board/tests/edge_project_live.rs` builds its file; its paths
//! are made relative to a scratch directory holding the two images it
//! names, laid out as `make flash-image` and `make sd-image` lay them out.
//!
//! What the board as drawn does, held as the plan's checks are (`NODES.md`
//! §13, review item 1):
//!
//! - **The protocol over `J1`.** The production build's MAIN channel is
//!   `P63`/`P62` (`HW_pins.h`, `HAL_serial_config.c`), which `J1` carries
//!   straight to the module's fingers. Once the firmware has booted off the
//!   flash, the host's protocol requests cross `J1` to the chip's own `P63`,
//!   and the firmware's answers come back on `P62` to the host, framed as
//!   ProtoEmb frames them and decoded with MaD's generated codec.
//! - **The inputs at rest.** The end switches, the door and the emergency
//!   stops each present the level the firmware reads as inactive. The
//!   emergency stops' wires show in nothing at rest: a stop rests open, an
//!   open loop and an unwired one both leave its input on its pull-up, and
//!   the machine's kind cannot press a stop.
//! - **The drive.** `IC14`, the isolator between the processor and the
//!   drive, has its secondary ground pins on a net of their own (embsim
//!   `board/tests/edgeboard.rs`; the layout has the same pads on the same
//!   net, `Hardware/EdgeBoard/KiCad/MaD_Edge.kicad_pcb`), so nothing it
//!   drives reaches the drive's step, direction and enable inputs, and its
//!   output to `P5` gives its default high whatever the drive's ready
//!   output says. Whether the machine's carrier is bodged there is not
//!   known; the file keeps the board as drawn.
//! - **The encoder.** With the drive's inputs driven from the bench (the
//!   carrier's own path to them is `IC14`'s) and the chip held in reset
//!   from the debug header, the drive turns the encoder, whose pairs reach
//!   `P9` and `P10` through the line receiver `U25` and the isolator
//!   `IC16`, `A` on `P9` and `B` on `P10` in the encoder's own phase, each
//!   pair's `-` leg the opposite of its `+` leg; with the machine's real
//!   NPN open-collector encoder on the `+` legs and the ground jumpers
//!   closed, `P9` and `P10` stay high and the run names `U25`'s pairs
//!   (embsim `board/tests/edge_encoder_pairs.rs`).
//!   The bench, the probes and the open collector's three changes are the
//!   cases' own, added to the file as loaded; the file is unchanged.
//!
//! Stepped (`TESTING.md` rule 9): the clock stepped before the project
//! builds (the converter's protocol thread joins it as an actor), the
//! system started with time held, the case's thread a registered actor;
//! every assertion is on virtual time and the board's state. Each case
//! skips, saying why, when the production image is absent (`make
//! p2image-production`), as `tests/boot.rs` does for the debug image;
//! `MAD_REQUIRE_P2_IMAGE` turns the skip into a failure. The cases take one
//! lock: the clock is the process's.

use std::io::{Read as _, Write as _};
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use embsim_board::net::{DEFAULT_PUSH_PULL_IMPEDANCE, V_IH, V_IL};
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
use protoemb_framing::{FrameParser, ParsedFrame};
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

/// A directory of the case's own under Cargo's scratch directory for
/// integration tests, holding the two images `mad.toml` names at the paths
/// it names them by (`build/flash.bin`, `build/sd.img`): the flash laid out
/// from the production program by `embsim flash-image`, the command `make
/// flash-image` runs, here in process; the card `make sd-image` writes,
/// `SIL/sd` mirrored onto it when it is there. With them, the program's
/// bytes. `None`, having said why, without the program.
fn images(case: &str) -> Option<(PathBuf, Vec<u8>)> {
    let image = image_path();
    let Ok(program) = std::fs::read(&image) else {
        eprintln!(
            "\n*** SKIPPED: {}::{case} needs the production P2 image at\n***   {}\n*** Build it \
             with `make p2image-production`.\n*** This test asserted NOTHING.\n",
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
    Some((dir, program))
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
// At rest: the inputs
// ============================================================

#[test]
fn the_inputs_at_rest() {
    behaviour!(Test {
        id: "mad-project.at-rest",
        covers: Some("SIL/mad.toml"),
        given: "the machine's project file, its host a serial port on the carrier's debug header, \
                run 10.1 ms from power-on, past every supply's start-up",
    });
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
        "the emergency stops rest open, and an open loop lights no optocoupler, so each input \
         reads high with its stop wired or with none"
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
    let mut project = load(&dir);
    project
        .set_component_option(
            "HOST",
            "path",
            dir.join("host.pty").to_str().expect("UTF-8"),
        )
        .expect("the file has a HOST");
    let rig = Rig::start(project, Bench::default());

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
// The firmware booted: the protocol over the debug header
// ============================================================

/// The START instant: the module's reset releases at 2.5 ms (the AP62301
/// bucks' soft-start) and the chip starts 3 ms after.
const START_NS: u64 = AP62301_SOFT_START_NS + P2_RESTART_DELAY_NS;

/// Board time stage-1 takes a byte of the program, with room: it streams
/// the flash at about 3.84 µs a byte (`tests/boot.rs`, measured).
const STAGE1_NS_PER_BYTE: u64 = 4_000;

/// The board time between two of the host's requests while the firmware
/// has not answered, as the app's own runtime asks again after a timeout.
/// The host starts asking once stage-1 has streamed the program, before the
/// firmware's serial core takes the line; a request that lands before then,
/// or on a receiver still at the console's rate, would go unanswered
/// (inferred). On this file the first request, at 1.226 s, was answered at
/// 1.235 s (measured).
const RETRY_NS: u64 = 20_000_000;

/// The most board time the host asks for, from its first request: past
/// the firmware's start-up with room.
const ANSWER_WAIT_NS: u64 = 600_000_000;

/// The step the case hands the engine while it waits for an answer.
const ANSWER_STEP_NS: u64 = 1_000_000;

/// The firmware's MAIN channel rate (`HAL_serial_config.c`).
const MAIN_BAUD: f64 = 2_000_000.0;

/// The host's end of the line: the PTY `host-serial` made, which the case
/// writes, and a thread of the case's own reads into `received`. That thread
/// is no actor: it reads what the PTY holds and touches no clock.
struct HostPort {
    port: std::fs::File,
    received: Arc<Mutex<Vec<u8>>>,
    /// Where `received` ended at each request the case sent, and the
    /// request.
    sent: Vec<(usize, Vec<u8>)>,
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
        Self {
            port,
            received,
            sent: Vec::new(),
        }
    }

    fn received(&self) -> Vec<u8> {
        self.received
            .lock()
            .expect("the host's buffer is never poisoned")
            .clone()
    }

    /// Send a READ request for `command`, as the app's runtime frames it.
    fn read(&mut self, command: u8) {
        let request = protoemb_framing::build_read_frame(command);
        let at = self.received().len();
        self.port.write_all(&request).expect("the host writes");
        self.port.flush().expect("the host flushes");
        self.sent.push((at, request));
    }

    /// The payload of the first data frame answering `command` in what the
    /// host received after one of its requests, parsed from each request's
    /// instant on: the bytes before a request (the firmware's boot line, at
    /// its console rate) are no frames, and a parser that took them for a
    /// header could swallow the answer as a payload.
    fn answer(&self, command: u8) -> Option<Vec<u8>> {
        let received = self.received();
        self.sent.iter().find_map(|(at, _)| {
            FrameParser::new()
                .feed_bytes(&received[*at..])
                .into_iter()
                .find_map(|frame| match frame {
                    ParsedFrame::Data {
                        command: answered,
                        payload,
                    } if answered == command => Some(payload),
                    _ => None,
                })
        })
    }
}

/// The falls `bytes` make on an idle-high line, each framed 8N1: the start
/// bit low, the data least significant bit first, the stop bit high.
fn frame_falls(bytes: &[u8]) -> usize {
    let mut level = true;
    let mut falls = 0;
    for byte in bytes {
        let bits = std::iter::once(false)
            .chain((0..8).map(|bit| (byte >> bit) & 1 == 1))
            .chain(std::iter::once(true));
        for bit in bits {
            if level && !bit {
                falls += 1;
            }
            level = bit;
        }
    }
    falls
}

/// Read `command` until the firmware answers: a request, then another every
/// [`RETRY_NS`], stepping the board [`ANSWER_STEP_NS`] at a time, for at most
/// [`ANSWER_WAIT_NS`] from `rig`'s instant `at`. The answer's payload, and
/// the instant it was found.
fn ask(rig: &mut Rig, host: &mut HostPort, command: u8, mut at: u64) -> (Vec<u8>, u64) {
    let first = at;
    let mut next_request = at;
    loop {
        if at >= next_request {
            host.read(command);
            next_request = at + RETRY_NS;
        }
        virtual_clock::wait_virtual_ns(ANSWER_STEP_NS);
        at += ANSWER_STEP_NS;
        if let Some(payload) = host.answer(command) {
            return (payload, at);
        }
        if let Some(failure) = rig.failure("EC32.U100") {
            panic!("the core failed at {at} ns: {failure}");
        }
        assert!(
            at - first < ANSWER_WAIT_NS,
            "no answer to command {command} after {} requests in {} ns of board time: the \
             host received {:02X?}; {}; {}",
            host.sent.len(),
            at - first,
            host.received(),
            rig.summary("HOST"),
            rig.summary_line("EC32.U100", " cogs running; ")
        );
    }
}

/// Whether `program` holds `text` as a C string: its bytes, then a NUL.
fn holds_c_string(program: &[u8], text: &str) -> bool {
    let mut needle = text.as_bytes().to_vec();
    needle.push(0);
    program.windows(needle.len()).any(|window| window == needle)
}

#[test]
fn the_firmware_answers_the_host_on_the_debug_header() {
    behaviour!(Test {
        id: "mad-project.protocol-on-j1",
        covers: Some("SIL/mad.toml"),
        given: "the machine's project file, the production firmware in the module's flash and a \
                serial-port host on the carrier's debug header, run until stage-1 has streamed \
                the program, then the host reading the firmware's version, again every 20 ms \
                until it is answered, and then reading the machine's state",
    });
    expect!(
        "version-answered",
        "the host receives a data frame answering the version read, its check byte intact",
        "the production build's protocol channel receives on P63 and transmits on P62, which \
         the debug header carries straight to the module's fingers"
    );
    expect!(
        "version-decodes",
        "the answer reads, by MaD's protocol, as a firmware version that the program carries \
         as text"
    );
    expect!(
        "requests-reach-p63",
        "the chip's own P63 falls once for every fall of every request the host sent"
    );
    expect!(
        "state-answered",
        "the host's read of the machine's state is answered with a data frame that reads as a \
         machine with motion disabled and no test running",
        "the firmware starts with motion off, and only the operator turns it on"
    );
    expect!(
        "main-at-2m",
        "the core's summary gives the rate the firmware programmed on P62, within 0.1 percent \
         of 2 000 000 baud"
    );
    let Some((dir, program)) = images("protocol") else {
        return;
    };
    let pty = dir.join("host.pty");
    let mut project = load(&dir);
    project
        .set_component_option("HOST", "path", pty.to_str().expect("UTF-8"))
        .expect("the file has a HOST");
    let mut rig = Rig::start(project, Bench::default().probe("P63", "EC32.J203.49"));
    let mut host = HostPort::open(&pty);

    // Stage-1 streams the program; the host starts asking after it.
    let streamed = START_NS + program.len() as u64 * STAGE1_NS_PER_BYTE;
    virtual_clock::wait_virtual_ns(streamed - SETTLE_NS);
    let (version, answered_at) = ask(
        &mut rig,
        &mut host,
        protocol::MSG_READ_FIRMWARE_VERSION,
        streamed,
    );
    let tries = host.sent.len();
    let version = protocol::FirmwareVersion::decode(&version)
        .unwrap_or_else(|| panic!("the version's payload decodes: {version:02X?}"))
        .version;
    assert!(
        !version.is_empty() && holds_c_string(&program, &version),
        "the firmware version {version:?} is a string the program holds"
    );

    let (state, state_at) = ask(&mut rig, &mut host, protocol::MSG_READ_STATE, answered_at);
    let state = protocol::MachineState::decode(&state)
        .unwrap_or_else(|| panic!("the state's payload decodes: {state:02X?}"));
    assert!(
        !state.motion_enabled && !state.test_running,
        "a machine just booted: {state:?}"
    );
    let core: Vec<String> = rig
        .reports("EC32.U100")
        .flat_map(|report| report.summary())
        .collect();
    let _ = writeln!(
        std::io::stderr(),
        "version {version:?} answered at {answered_at} ns after {tries} requests; state \
         {state:?} at {state_at} ns; {}; the core's summary: {core:#?}",
        rig.summary("HOST"),
    );

    // Every request's last stop bit has crossed.
    virtual_clock::wait_virtual_ns(ANSWER_STEP_NS);
    let falls_sent: usize = host
        .sent
        .iter()
        .map(|(_, request)| frame_falls(request))
        .sum();
    assert_eq!(
        falls(&rig.seen("P63")),
        falls_sent,
        "the chip's P63 fell once for each fall of the host's {} requests",
        host.sent.len()
    );

    let core = rig.summary_line("EC32.U100", " cogs running; ");
    let baud: f64 = core
        .split_once("P62 at ")
        .and_then(|(_, rest)| rest.split_once(" baud"))
        .and_then(|(baud, _)| baud.parse().ok())
        .unwrap_or_else(|| panic!("the core transmitted on P62: {core}"));
    assert!(
        (baud - MAIN_BAUD).abs() / MAIN_BAUD < 0.001,
        "P62 at {baud} baud: {core}"
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

/// The encoder connector's four legs, as `J20` carries them to `U25`:
/// `A+` (`J20.1`, `1A`), `A-` (`J20.2`, `1B`), `B+` (`J20.3`, `2A`) and
/// `B-` (`J20.4`, `2B`) (read: `netlists/mad_edge.net`).
const LEGS: [&str; 4] = [
    "EDGE./MaD_Edge_Sheet3/A+",
    "EDGE./MaD_Edge_Sheet3/A-",
    "EDGE./MaD_Edge_Sheet3/B+",
    "EDGE./MaD_Edge_Sheet3/B-",
];

/// One read of the encoder: its count, what `P9` and `P10` read, and what
/// its four legs on `J20` read, in [`LEGS`]' order.
#[derive(Debug, Clone, Copy)]
struct Read {
    count: i64,
    p9: Option<Level>,
    p10: Option<Level>,
    legs: [Option<NetState>; 4],
}

/// Read the encoder every millisecond through the bench's steps and the
/// carriage coming to rest: the first read, then each read whose count
/// differs from the one before it.
fn walk(rig: &mut Rig) -> Vec<Read> {
    let read = |rig: &mut Rig| Read {
        count: rig.encoder_count(),
        p9: rig.level("EDGE.P9"),
        p10: rig.level("EDGE.P10"),
        legs: LEGS.map(|net| rig.state(net)),
    };
    let mut seen = vec![read(rig)];
    let mut at = SETTLE_NS;
    for k in 0..READS {
        let deadline = FIRST_READ_NS + k * READ_EVERY_NS;
        virtual_clock::wait_virtual_ns(deadline - at);
        at = deadline;
        let now = read(rig);
        if now.count != seen.last().expect("one read at least").count {
            seen.push(now);
        }
    }
    seen
}

/// The encoder's channels `(A, B)` at a count: the Gray sequence with `A`
/// leading `B` as the count rises, the order embsim's `QuadratureEncoder`
/// takes by default (`models/src/machine/quadrature_encoder.rs`, its
/// `phase`) and `mad-machine` keeps. The firmware reads `A` on `P9` and `B`
/// on `P10` (`HW_PIN_SERVO_ENCODER_A`/`_B`, `HW_pins.h`).
fn channels(count: i64) -> (Level, Level) {
    match count.rem_euclid(4) {
        0 => (Level::Low, Level::Low),
        1 => (Level::High, Level::Low),
        2 => (Level::High, Level::High),
        _ => (Level::Low, Level::High),
    }
}

fn opposite(level: Level) -> Level {
    match level {
        Level::Low => Level::High,
        Level::High => Level::Low,
    }
}

/// The level a leg reads: driven or pulled, or a solved voltage read
/// through the engine's own net-level pair, JESD8C.01's 3.3 V LVCMOS
/// `V_IL`/`V_IH`, as the probes read; `None` for anything else. The
/// encoder's legs solve to voltages: each leg's drive into the receiver's
/// inputs.
fn level_of(state: Option<NetState>) -> Option<Level> {
    match state {
        Some(NetState::Driven(level) | NetState::Pulled(level, _)) => Some(level),
        Some(NetState::Analog(volts)) if volts <= V_IL => Some(Level::Low),
        Some(NetState::Analog(volts)) if volts >= V_IH => Some(Level::High),
        _ => None,
    }
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
        "at every count P9 carries the encoder's A channel and P10 its B channel, so P9 leads \
         P10 while the drive steps forward",
        "the carrier's line receiver reads each of the encoder's pairs as a valid level and \
         the isolator after it passes the level to the module, neither inverting it"
    );
    expect!(
        "pairs-wired",
        "at every count each pair's plus leg on the carrier's encoder connector carries its \
         channel's level and its minus leg the opposite level",
        "the encoder drives both legs of each pair, and the jumpers that would ground the minus \
         legs are open"
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
    let counts: Vec<i64> = read.iter().map(|at| at.count).collect();
    assert_eq!(counts, (0..=8).collect::<Vec<i64>>(), "{read:?}");
    assert_eq!(steps_commanded(&mut rig), 8, "{}", rig.summary("MACHINE"));
    assert_held_in_reset(&mut rig);
    for at in &read {
        let (a, b) = channels(at.count);
        assert_eq!(
            (at.p9, at.p10),
            (Some(a), Some(b)),
            "P9 and P10 at count {}: {read:?}",
            at.count
        );
        assert_eq!(
            at.legs.map(level_of),
            [Some(a), Some(opposite(a)), Some(b), Some(opposite(b))],
            "J20's legs at count {}: {:?}",
            at.count,
            at.legs
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
    let counts: Vec<i64> = read.iter().map(|at| at.count).collect();
    assert_eq!(counts, (0..=8).collect::<Vec<i64>>(), "{read:?}");
    assert_eq!(steps_commanded(&mut rig), 8, "{}", rig.summary("MACHINE"));
    assert_held_in_reset(&mut rig);
    for at in &read {
        assert_eq!(
            (at.p9, at.p10),
            (Some(Level::High), Some(Level::High)),
            "at count {}: {read:?}",
            at.count
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
