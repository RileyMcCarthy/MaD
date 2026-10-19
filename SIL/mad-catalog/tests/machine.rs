//! The machine kind, `mad-machine`, driven from its pins: a project naming
//! it, built with the catalogs embsim ships and MaD's own
//! (`embsim_cli::shipped()` and `mad_catalog::register`), as `mad-runner`
//! builds one, on a bench that stands in for the Edge carrier's side of
//! each wire: 0 V on the drive's and the encoder's returns, the drive
//! enabled, 5 V on each switch loop's supply side (the carrier's `5V_IO`)
//! and 3.3 V across the load cell's excitation (the add-on's `VDDA`).
//!
//! Stepped (embsim `TESTING.md` rule 9): one case at a time under a suite
//! lock, the clock re-anchored stepped, the system started with time held,
//! the case's thread a registered actor, every read after a virtual wait,
//! no `QuiescenceTimeout` at the end. Nothing here reads the wall clock.

use std::sync::{Arc, Mutex, MutexGuard};

use embsim_board::{
    AttachError, Component, ComponentNetIo, Drive, EndpointRef, Finding, Harness, Level, NetState,
    PeriodicSchedule, PinDecl, PinHandle, Project, Report, Reports, System, SystemHandle,
    TheveninDrive,
};
use embsim_boards::catalog::CatalogSet;
use embsim_core::virtual_clock::{self, Actor, ClockMode};
use embsim_models::machine::stepper_motor::{DEFAULT_OBSERVE_INTERVAL_US, DEFAULT_TAU_S};
use mad_catalog::machine::{
    GANTRY_SLACK_MM, GAUGE_FULL_SCALE_N, GAUGE_MV_PER_V, STEPS_PER_MM, TRAVEL_MM,
};
use rstest::rstest;
use vibes_behaviour::{behaviour, expect, Test};

/// The cases share the process's one virtual clock.
static SUITE_LOCK: Mutex<()> = Mutex::new(());

fn suite_lock() -> MutexGuard<'static, ()> {
    SUITE_LOCK.lock().unwrap_or_else(|poisoned| {
        SUITE_LOCK.clear_poison();
        poisoned.into_inner()
    })
}

fn ep(endpoint: &str) -> EndpointRef {
    EndpointRef::parse(endpoint).expect("endpoint parses")
}

/// The catalogs embsim ships, with MaD's added: the set `mad-runner` runs.
fn set() -> CatalogSet {
    let mut set = embsim_cli::shipped();
    mad_catalog::register(&mut set).expect("MaD's catalog joins the set");
    set
}

/// The loop supply the bench gives each contact's supply side: the Edge
/// carrier's `5V_IO`.
const LOOP_VOLTS: f64 = 5.0;

/// The load cell's excitation: the DS2 add-on's analog supply, `VDDA`.
const EXCITATION_VOLTS: f64 = 3.3;

/// The switch loops, each a contact's supply side and its far side.
const LOOPS: [&str; 6] = ["UPPER", "LOWER", "DOOR", "ESD_U", "ESD_L", "ESD_A"];

/// The machine, named `MACHINE` with `options` (TOML lines), on the bench
/// (module docs), followed by `rest`: the case's own entries.
fn project(options: &str, rest: &str) -> String {
    let mut text = format!(
        "[[component]]\nname = \"MACHINE\"\nkind = \"mad-machine\"\n[component.options]\n\
         {options}\n"
    );
    // A wire, a supply on `from` when it carries volts.
    let mut wire = |from: &str, to: &str, volts: Option<f64>| {
        text.push_str(&format!("\n[[wire]]\nfrom = \"{from}\"\nto = \"{to}\"\n"));
        if let Some(volts) = volts {
            text.push_str(&format!("volts = {volts:?}\n"));
        }
    };
    wire("BENCH.DRIVE_GND", "MACHINE.DRIVE_GND", Some(0.0));
    wire("BENCH.ENC_GND", "MACHINE.ENC_GND", Some(0.0));
    // The enable is active low.
    wire("BENCH.ENA", "MACHINE.ENA", Some(0.0));
    // One loop supply, every contact's supply side on it.
    for (index, contact) in LOOPS.iter().enumerate() {
        let volts = (index == 0).then_some(LOOP_VOLTS);
        wire("BENCH.5V_IO", &format!("MACHINE.{contact}_COM"), volts);
    }
    wire("BENCH.VDDA", "MACHINE.E+", Some(EXCITATION_VOLTS));
    wire("BENCH.AGND", "MACHINE.E-", Some(0.0));
    text.push_str(rest);
    text
}

/// The machine on its bench, running.
struct Rig {
    system: SystemHandle,
    actor: Option<Actor>,
    /// What the machine reports.
    report: Box<dyn Report>,
    _lock: MutexGuard<'static, ()>,
}

impl Rig {
    /// Build `text`, hand the system to `add` for the case's own parts,
    /// start it with time held and release it with the case's thread an
    /// actor.
    fn start(text: &str, add: impl FnOnce(System) -> System) -> Self {
        let lock = suite_lock();
        virtual_clock::init_mode(ClockMode::Stepped, 1_000_000);
        let reports = Reports::new();
        let system = Project::parse(text)
            .expect("the project parses")
            .instantiate_with(&set(), &reports)
            .expect("the project instantiates with the shipped catalogs and MaD's");
        let system = add(system).hold_time().start().expect("the bench starts");
        let report = reports
            .take()
            .into_iter()
            .find(|report| report.subject() == "MACHINE")
            .expect("the machine reports");
        let actor = virtual_clock::register_actor("mad-machine-case");
        system.release_time();
        Self {
            system,
            actor: Some(actor),
            report,
            _lock: lock,
        }
    }

    /// The engine's report of the net the machine's pin `pin` is on.
    fn state(&self, pin: &str) -> NetState {
        let net = format!("MACHINE.{pin}");
        self.system
            .net_state(&net)
            .unwrap_or_else(|| panic!("{net} is a net"))
    }

    /// The level the machine's pin `pin` drives.
    fn level(&self, pin: &str) -> Level {
        match self.state(pin) {
            NetState::Driven(level) => level,
            other => panic!("MACHINE.{pin} must be driven, got {other:?}"),
        }
    }

    /// The voltage on the machine's pin `pin`.
    fn volts(&self, pin: &str) -> f64 {
        match self.state(pin) {
            NetState::Analog(volts) => volts,
            other => panic!("MACHINE.{pin} must read a voltage, got {other:?}"),
        }
    }

    /// The machine's summary line.
    fn summary(&self) -> String {
        self.report.summary().join("\n")
    }

    /// End the case; the findings the run made.
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
        findings
    }
}

/// The quadrature state `(A, B)` of an encoder count, A leading B: 0 (L, L),
/// 1 (H, L), 2 (H, H), 3 (L, H).
fn quadrature(count: i64) -> (Level, Level) {
    match count.rem_euclid(4) {
        0 => (Level::Low, Level::Low),
        1 => (Level::High, Level::Low),
        2 => (Level::High, Level::High),
        _ => (Level::Low, Level::High),
    }
}

fn not(level: Level) -> Level {
    match level {
        Level::High => Level::Low,
        Level::Low => Level::High,
    }
}

// ============================================================
// At rest
// ============================================================

#[rstest]
fn the_machine_at_rest_holds_each_output_at_its_resting_level() {
    behaviour!(Test {
        id: "machine.at-rest",
        covers: Some("SIL/mad-catalog/src/machine.rs#assemble"),
        given: "the machine at rest on a bench with its default options, 5 volts on each \
                switch loop's supply side and 3.3 volts across the load cell",
    });
    expect!(
        "drive-not-ready",
        "the drive's ready output sinks its line to 0 volts, the level the firmware reads as \
         not ready",
        "on the Edge carrier an open ready line is pulled up and reads as ready, so a drive \
         that is not ready sinks it"
    );
    expect!(
        "limit-loops-closed",
        "the upper and lower end-switch loops carry the loop's 5 volts",
        "the end switches are normally closed, and the carriage starts between them"
    );
    expect!(
        "door-loop-closed",
        "the door loop carries the loop's 5 volts",
        "current in a loop lights the carrier's opto for it, which the firmware reads as the \
         switch at rest"
    );
    expect!(
        "stop-loops-open",
        "each of the three emergency-stop loops is open: nothing drives its far side",
        "the firmware reads an emergency stop's dark opto as the stop at rest"
    );
    expect!(
        "bridge-balanced",
        "both bridge outputs sit at the excitation's midpoint, 1.65 volts",
        "the unloaded sample puts no force on the load cell"
    );
    expect!(
        "encoder-at-zero",
        "the encoder's A and B both read low and their complements high: count zero's \
         quadrature state"
    );
    let rig = Rig::start(
        &project(
            "",
            "\n[[wire]]\nfrom = \"BENCH.STEP\"\nto = \"MACHINE.STEP\"\nvolts = 0.0\n\
             \n[[wire]]\nfrom = \"BENCH.DIR\"\nto = \"MACHINE.DIR\"\nvolts = 0.0\n",
        ),
        |system| system,
    );
    // Off the drive's observations: a quarter of one.
    virtual_clock::wait_virtual_ns(DEFAULT_OBSERVE_INTERVAL_US * 250);

    assert_eq!(rig.level("SRDY"), Level::Low);
    for contact in ["UPPER", "LOWER", "DOOR"] {
        assert_eq!(rig.level(&format!("{contact}+")), Level::High, "{contact}");
    }
    for contact in ["ESD_U", "ESD_L", "ESD_A"] {
        assert_eq!(
            rig.state(&format!("{contact}+")),
            NetState::Floating,
            "{contact}"
        );
    }
    let middle = EXCITATION_VOLTS / 2.0;
    for terminal in ["S+", "S-"] {
        let volts = rig.volts(terminal);
        assert!((volts - middle).abs() < 1e-9, "{terminal} reads {volts}");
    }
    assert_eq!(
        (rig.level("ENC_A+"), rig.level("ENC_B+")),
        (Level::Low, Level::Low)
    );
    assert_eq!(
        (rig.level("ENC_A-"), rig.level("ENC_B-")),
        (Level::High, Level::High)
    );
    rig.finish();
}

// ============================================================
// Steps as edges
// ============================================================

/// Four rising `STEP` edges 2 ms apart from 10 ms with `DIR` low (forward),
/// then `DIR` high at 250 ms and four more from 260 ms: 500 steps a second,
/// half a step an observation of the drive, so the encoder moves one count
/// at a time, each at an observation of its own. Each group ends long
/// before the next: 230 ms is more than eleven of the drive's time
/// constants.
const STEPS_AS_EDGES: &str = r#"
[[component]]
name = "STEPS"
kind = "scripted-source"
[component.options]
ohms = 25.0
steps = [
  ["0ms", 0.0],
  ["10ms", 3.3], ["11ms", 0.0], ["12ms", 3.3], ["13ms", 0.0],
  ["14ms", 3.3], ["15ms", 0.0], ["16ms", 3.3], ["17ms", 0.0],
  ["260ms", 3.3], ["261ms", 0.0], ["262ms", 3.3], ["263ms", 0.0],
  ["264ms", 3.3], ["265ms", 0.0], ["266ms", 3.3], ["267ms", 0.0],
]

[[component]]
name = "DIRECTION"
kind = "scripted-source"
[component.options]
ohms = 25.0
steps = [["0ms", 0.0], ["250ms", 3.3]]

[[wire]]
from = "STEPS.OUT"
to = "MACHINE.STEP"

[[wire]]
from = "DIRECTION.OUT"
to = "MACHINE.DIR"
"#;

/// Where the scripted steps leave the carriage: four forward, then four
/// back. Read just before each group's next change.
const FORWARD_REST_NS: u64 = 249_500_000;
const BACK_REST_NS: u64 = 499_500_000;
const _: () = assert!(
    FORWARD_REST_NS - 20_000_000 > (11.0 * DEFAULT_TAU_S * 1e9) as u64,
    "the forward group comes to rest before DIR changes"
);

/// The counts the encoder walks through: up four, back four.
const WALK: [i64; 9] = [0, 1, 2, 3, 4, 3, 2, 1, 0];

/// What a read of the encoder's outputs saw: its `(A, B)` levels, and its
/// complements' when the stage has them.
type Read = ((Level, Level), Option<(Level, Level)>);

/// Poll the encoder's outputs once a millisecond, a half observation off
/// the drive's, until `BACK_REST_NS`, reading each `+` output through
/// `level` and the complements when `complements`. Returns every distinct
/// read in order, and the count's state at the forward rest.
fn walk(rig: &Rig, level: impl Fn(&Rig, &str) -> Level, complements: bool) -> (Vec<Read>, Read) {
    let observe_ns = DEFAULT_OBSERVE_INTERVAL_US * 1_000;
    let mut reads: Vec<Read> = Vec::new();
    let mut forward = None;
    let mut at_ns = observe_ns / 2;
    virtual_clock::wait_virtual_ns(at_ns);
    loop {
        let legs = (level(rig, "ENC_A+"), level(rig, "ENC_B+"));
        let complement = complements.then(|| (rig.level("ENC_A-"), rig.level("ENC_B-")));
        let read = (legs, complement);
        if reads.last() != Some(&read) {
            reads.push(read);
        }
        if at_ns == FORWARD_REST_NS {
            forward = Some(read);
        }
        if at_ns >= BACK_REST_NS {
            break;
        }
        virtual_clock::wait_virtual_ns(observe_ns);
        at_ns += observe_ns;
    }
    (reads, forward.expect("the walk passed the forward rest"))
}

#[rstest]
fn steps_as_edges_walk_the_line_drivers_pairs_one_count_a_step() {
    behaviour!(Test {
        id: "machine.steps-as-edges-rs422",
        covers: Some("SIL/mad-catalog/src/machine.rs#assemble"),
        given: "the machine with its encoder's default line-driver outputs, stepped by four \
                edges with its direction input low and then four with it high",
    });
    expect!(
        "up-then-down",
        "the encoder stands at count four's quadrature state after the first four steps, \
         and back at count zero's after the next four",
        "the drive moves forward with its direction input low, one encoder count a step"
    );
    expect!(
        "one-count-at-a-time",
        "the outputs pass through every quadrature state between, in order, one channel \
         changing at each count"
    );
    expect!(
        "complements-inverse",
        "at every read each complementary output is the inverse of its channel",
        "the Edge carrier's line receiver reads each channel as the difference of its pair"
    );
    let rig = Rig::start(&project("", STEPS_AS_EDGES), |system| system);
    let (reads, forward) = walk(&rig, Rig::level, true);
    let summary = rig.summary();
    rig.finish();

    let at = |count| {
        let (a, b) = quadrature(count);
        ((a, b), Some((not(a), not(b))))
    };
    assert_eq!(forward, at(4), "after the first four steps");
    assert_eq!(*reads.last().expect("a read"), at(0), "after the next four");
    let expected: Vec<Read> = WALK.iter().map(|&count| at(count)).collect();
    assert_eq!(reads, expected, "{summary}");
    for read in &reads {
        let ((a, b), complement) = *read;
        assert_eq!(complement, Some((not(a), not(b))), "{read:?}");
    }
    assert!(summary.contains("encoder at 0 counts"), "{summary}");
}

#[rstest]
fn steps_as_edges_sink_and_release_the_open_collectors() {
    behaviour!(Test {
        id: "machine.steps-as-edges-open-collector",
        covers: Some("SIL/mad-catalog/src/machine.rs#assemble"),
        given: "the machine with its encoder's outputs NPN open collectors and nothing else on \
                them, stepped by four edges with its direction input low and then four with it \
                high",
    });
    expect!(
        "sink-and-release",
        "each output is driven to 0 volts while its channel is low and released, driven by \
         nothing, while it is high",
        "an open collector has no pull-up of its own; the carrier or the bench supplies the \
         high"
    );
    expect!(
        "same-walk",
        "read as released for high, the outputs walk up four counts and back four, one \
         channel changing at each count"
    );
    expect!(
        "a-and-b-alone",
        "the encoder's outputs are A and B alone",
        "the machine's real encoder, a Taiss 600 pulses-a-revolution optical encoder, has \
         those two outputs"
    );
    let rig = Rig::start(
        &project("encoder_output = \"npn-open-collector\"", STEPS_AS_EDGES),
        |system| system,
    );
    let sinks_or_releases = |rig: &Rig, pin: &str| match rig.state(pin) {
        NetState::Driven(Level::Low) => Level::Low,
        NetState::Floating => Level::High,
        other => panic!("MACHINE.{pin}: an open collector sinks or releases, got {other:?}"),
    };
    let (reads, forward) = walk(&rig, sinks_or_releases, false);
    let no_complements =
        ["ENC_A-", "ENC_B-"].map(|pin| rig.system.net_state(&format!("MACHINE.{pin}")).is_none());
    rig.finish();

    let at = |count| (quadrature(count), None);
    assert_eq!(forward, at(4), "after the first four steps");
    let expected: Vec<Read> = WALK.iter().map(|&count| at(count)).collect();
    assert_eq!(reads, expected);
    assert_eq!(no_complements, [true, true]);
}

// ============================================================
// Travel as a rate
// ============================================================

/// The train's rate: 81 920 steps a second, 10 mm/s, the test's own. Carried
/// as a rate, the train costs the engine one publish however long it is.
const TRAIN_HZ: u32 = 81_920;

/// The steps from the start to the upper end switch: 819 200.
const TO_THE_LIMIT: u64 = (STEPS_PER_MM * TRAVEL_MM) as u64;

/// The virtual time a train of `steps` takes, then twenty of the drive's
/// time constants for the carriage to come to rest (less than a millionth
/// of a step left to travel from the 2 048-step lag at 10 mm/s), then a
/// quarter observation, so the read falls between two observations.
fn rest_ns(steps: u64) -> u64 {
    steps * 1_000_000_000 / u64::from(TRAIN_HZ)
        + (20.0 * DEFAULT_TAU_S * 1e9) as u64
        + DEFAULT_OBSERVE_INTERVAL_US * 250
}

/// The train's two ports: 3.3 V logic behind 25 Ω.
const HIGH: TheveninDrive = TheveninDrive {
    volts: 3.3,
    impedance: 25.0,
};
const LOW: TheveninDrive = TheveninDrive {
    volts: 0.0,
    impedance: 25.0,
};

/// The test's step source: `STEP` and `DIR` resting low, each a port the
/// case's thread drives through.
struct Train {
    pins: [PinDecl; 2],
    handles: Arc<Mutex<Vec<PinHandle>>>,
}

impl Component for Train {
    fn pins(&self) -> &[PinDecl] {
        &self.pins
    }

    fn attach(&mut self, io: ComponentNetIo) -> Result<(), AttachError> {
        let mut handles = self.handles.lock().expect("never poisoned");
        for pin in ["STEP", "DIR"] {
            handles.push(io.pin(pin)?);
        }
        Ok(())
    }
}

/// Drive `step` with a train of `steps` at [`TRAIN_HZ`] from now.
fn train(step: &PinHandle, steps: u64) {
    step.drive(Drive::Periodic {
        hi: HIGH,
        lo: LOW,
        segment: PeriodicSchedule {
            emitted: 0,
            freq_hz: TRAIN_HZ,
            total: Some(steps),
            since_ns: virtual_clock::virtual_ns(),
        },
    });
}

#[rstest]
fn travel_as_a_rate_opens_the_upper_loop_past_one_hundred_millimetres() {
    behaviour!(Test {
        id: "machine.travel-as-a-rate",
        covers: Some("SIL/mad-catalog/src/machine.rs#assemble"),
        given: "the machine driven forward by a step train carried as a rate, 819200 steps \
                at 10 millimetres a second, which bring the carriage to rest at 100 \
                millimetres, then by one step more",
    });
    expect!(
        "count-is-the-steps",
        "at rest the encoder's count is the 819200 steps the train carried",
        "the encoder counts as many counts a millimetre as the drive steps, 8192"
    );
    expect!(
        "closed-to-the-limit",
        "the upper end-switch loop carries the loop's 5 volts throughout the travel and with \
         the carriage at rest at 100 millimetres"
    );
    expect!(
        "open-past-the-limit",
        "one step past 100 millimetres the upper loop is open: nothing drives its far side",
        "the upper end switch opens where the firmware's travel ends, 100 millimetres"
    );
    expect!(
        "lower-closed",
        "the lower end-switch loop carries the loop's 5 volts throughout"
    );
    expect!(
        "sample-loaded",
        "at 100 millimetres the bridge reads the sample's 5 newtons through the load cell's \
         sensitivity and excitation: minus 0.803 millivolts at 3.3 volts",
        "the sample takes load past 15 millimetres of grip slack and reaches 5 newtons at \
         the end of travel"
    );
    let handles: Arc<Mutex<Vec<PinHandle>>> = Arc::default();
    let source = Train {
        pins: [
            PinDecl::digital_out("STEP").with_idle(Some(LOW)),
            PinDecl::digital_out("DIR").with_idle(Some(LOW)),
        ],
        handles: Arc::clone(&handles),
    };
    let rig = Rig::start(&project("", ""), |system| {
        system.component("TRAIN", Box::new(source)).harness(
            Harness::new()
                .connect(ep("TRAIN.STEP"), ep("MACHINE.STEP"))
                .connect(ep("TRAIN.DIR"), ep("MACHINE.DIR")),
        )
    });
    let step = handles.lock().expect("never poisoned")[0].clone();
    virtual_clock::wait_virtual_ns(DEFAULT_OBSERVE_INTERVAL_US * 250);

    // The travel, read every 100 ms on the way and at rest.
    train(&step, TO_THE_LIMIT);
    let total = rest_ns(TO_THE_LIMIT);
    let mut closed_on_the_way = Vec::new();
    let mut waited = 0;
    while waited < total {
        let wait = (total - waited).min(100_000_000);
        virtual_clock::wait_virtual_ns(wait);
        waited += wait;
        closed_on_the_way.push((rig.state("UPPER+"), rig.state("LOWER+")));
    }
    let at_the_limit = rig.summary();
    let (upper_at_limit, lower_at_limit) = (rig.state("UPPER+"), rig.state("LOWER+"));
    let bridge_mv = (rig.volts("S+") - rig.volts("S-")) * 1_000.0;

    train(&step, 1);
    virtual_clock::wait_virtual_ns(rest_ns(1));
    let past_the_limit = rig.summary();
    let (upper_past, lower_past) = (rig.state("UPPER+"), rig.state("LOWER+"));
    rig.finish();

    let driven = NetState::Driven(Level::High);
    assert!(
        at_the_limit.contains(&format!("encoder at {TO_THE_LIMIT} counts")),
        "{at_the_limit}"
    );
    assert!(
        at_the_limit.contains(&format!("{TO_THE_LIMIT} steps commanded")),
        "{at_the_limit}"
    );
    assert!(
        closed_on_the_way.iter().all(|(upper, _)| *upper == driven),
        "{closed_on_the_way:?}"
    );
    assert_eq!(upper_at_limit, driven);
    assert!(
        past_the_limit.contains(&format!("encoder at {} counts", TO_THE_LIMIT + 1)),
        "{past_the_limit}"
    );
    assert_eq!(upper_past, NetState::Floating);
    assert!(
        closed_on_the_way.iter().all(|(_, lower)| *lower == driven),
        "{closed_on_the_way:?}"
    );
    assert_eq!((lower_at_limit, lower_past), (driven, driven));
    let newtons = 5.0;
    let expected_mv = newtons / GAUGE_FULL_SCALE_N * GAUGE_MV_PER_V * EXCITATION_VOLTS;
    assert!(
        ((bridge_mv - expected_mv) / expected_mv).abs() < 1e-5,
        "the bridge reads {bridge_mv} mV, the sample's {newtons} N {expected_mv} mV \
         ({GANTRY_SLACK_MM} mm of slack)"
    );
}

// ============================================================
// The options
// ============================================================

#[rstest]
fn an_output_stage_the_kind_does_not_offer_is_refused() {
    behaviour!(Test {
        id: "machine.unknown-output-stage",
        covers: Some("SIL/mad-catalog/src/machine.rs#component"),
        given: "a project naming the machine with an encoder output stage called ttl",
    });
    expect!(
        "refused-naming-stages",
        "the project is refused, the error naming the three stages the machine offers: \
         push-pull, rs422 and npn-open-collector"
    );
    let _lock = suite_lock();
    let refused = Project::parse(&project("encoder_output = \"ttl\"", ""))
        .expect("the project parses")
        .instantiate(&set())
        .map(|_| ())
        .expect_err("the stage is refused");
    let message = refused.to_string();
    for stage in ["\"push-pull\"", "\"rs422\"", "\"npn-open-collector\""] {
        assert!(message.contains(stage), "{message}");
    }
    assert!(message.contains("MACHINE"), "{message}");
}
