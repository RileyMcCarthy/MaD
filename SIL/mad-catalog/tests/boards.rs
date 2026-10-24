//! MaD's two board kinds, each surveyed and built with the catalogs embsim
//! ships and MaD's own (`embsim_cli::shipped()` and
//! `mad_catalog::register`), as `mad-runner` builds a project naming them.
//!
//! The builds are the bench projects beside this crate
//! (`projects/ds2-bench.toml`, `projects/edge-bench.toml`), the files
//! `embsim check` checks. Building attaches the ADS122U04's model, whose
//! protocol thread joins the virtual clock, so every build here holds the
//! stepped clock the way `embsim check` does (`embsim_cli`'s `check`): the
//! clock started at zero, time held across the build, and released once the
//! build has dropped its parts. Nothing here advances time, and the builds
//! share the process's one clock, so they run one at a time.

use std::path::PathBuf;
use std::sync::{Mutex, MutexGuard};

use embsim_board::{BoardSurvey, BuiltSystem, Finding, Level, NetState, PinRef, Project};
use embsim_boards::catalog::CatalogSet;
use embsim_core::virtual_clock::{self, ClockMode};
use rstest::rstest;
use vibes_behaviour::{behaviour, expect, Test};

/// The builds share the process's one virtual clock.
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

/// A bench project beside this crate.
fn project_file(name: &str) -> PathBuf {
    [env!("CARGO_MANIFEST_DIR"), "projects", name]
        .iter()
        .collect()
}

/// A project of the one board `kind`, named `name`.
fn board_project(name: &str, kind: &str) -> Project {
    Project::parse(&format!(
        "[[board]]\nname = \"{name}\"\nkind = \"{kind}\"\n"
    ))
    .expect("the project parses")
}

/// Build the project `file` with time held, as `embsim check` does, and
/// hand the built system to `read` before its parts are dropped.
fn build<T>(file: &str, read: impl FnOnce(&BuiltSystem) -> T) -> T {
    let _clock = clock();
    virtual_clock::init_mode(ClockMode::Stepped, 1_000_000);
    let hold = virtual_clock::take_time_authority();
    let built = Project::load(project_file(file))
        .expect("the project loads")
        .instantiate(&set())
        .expect("the project instantiates with the shipped catalogs and MaD's")
        .build()
        .expect("the system builds");
    let seen = read(&built);
    drop(built);
    drop(hold);
    seen
}

/// The net `board`'s pin `part.pin` is on, as the board's netlist names it.
fn net_at(built: &BuiltSystem, board: &str, part: &str, pin: &str) -> String {
    let prefix = format!("{board}.");
    let at = PinRef::new(part, pin);
    built
        .nets()
        .iter()
        .find(|net| net.name.starts_with(&prefix) && net.nodes.contains(&at))
        .map(|net| net.name.clone())
        .unwrap_or_else(|| panic!("{board}.{part}.{pin} is on no net of {board}"))
}

/// The net on the far side of `board`'s two-pin part `part`, from its pin on
/// `net` (or on a net `net` is merged with).
fn beyond(built: &BuiltSystem, board: &str, part: &str, net: &str) -> String {
    let ends = ["1", "2"].map(|pin| net_at(built, board, part, pin));
    match ends.iter().position(|end| built.names_are_merged(end, net)) {
        Some(near) => ends[1 - near].clone(),
        None => panic!("{board}.{part} has no pin on {net}"),
    }
}

/// The pin of `reference` that the board's schematic names `function`.
fn pin_named(survey: &BoardSurvey, reference: &str, function: &str) -> String {
    survey
        .pins_of(reference)
        .unwrap_or_else(|| panic!("the board has a {reference}"))
        .iter()
        .find(|site| site.pinfunction.as_deref() == Some(function))
        .map(|site| site.pin.clone())
        .unwrap_or_else(|| panic!("{reference} has no pin named {function}"))
}

/// The key and the model the survey gave `reference`.
fn placed(survey: &BoardSurvey, reference: &str) -> (Option<String>, Option<String>) {
    let part = survey
        .parts()
        .find(|part| part.reference == reference)
        .unwrap_or_else(|| panic!("the board has a {reference}"));
    (part.key.clone(), part.model.clone())
}

#[rstest]
fn the_edge_carrier_kind_places_every_part() {
    behaviour!(Test {
        id: "catalog.mad-edge-surveyed",
        covers: Some("SIL/mad-catalog/src/boards.rs#MadCatalog::board"),
        given: "the Edge carrier named by its board kind in a project, surveyed with the \
                catalogs embsim ships and MaD's own",
    });
    expect!(
        "every-part-placed",
        "each of the carrier's 168 parts takes a model, and the survey refuses none"
    );
    expect!(
        "socket-a-connector",
        "the module socket J3 is one of the carrier's 24 connectors, where the P2 module's \
         mate lands",
        "its symbol comes from the carrier's own library, so the board kind says what it is"
    );
    expect!(
        "receiver-by-part-number",
        "the encoder's line receiver U25 takes the AM26LV32 receiver's model, chosen by its \
         manufacturer part number AM26LV32IDR",
        "the schematic names the part U25 was bought as"
    );
    let survey = board_project("EDGE", mad_catalog::boards::EDGE)
        .survey(&set(), "EDGE")
        .expect("the carrier surveys");
    assert_eq!(survey.part_count, 168);
    assert!(survey.compliant(), "{survey}");
    let connectors: Vec<&str> = survey
        .connectors
        .iter()
        .map(|connector| connector.reference.as_str())
        .collect();
    assert_eq!(connectors.len(), 24, "{connectors:?}");
    assert!(connectors.contains(&"J3"), "{connectors:?}");
    assert_eq!(
        placed(&survey, "U25"),
        (
            Some("AM26LV32IDR".to_string()),
            Some("am26lv32, pins = \"numbered\"".to_string())
        )
    );
}

#[rstest]
fn the_add_on_kind_places_every_part() {
    behaviour!(Test {
        id: "catalog.mad-ds2-surveyed",
        covers: Some("SIL/mad-catalog/src/boards.rs#MadCatalog::board"),
        given: "the DS2 force-gauge add-on named by its board kind in a project, surveyed with \
                the catalogs embsim ships and MaD's own",
    });
    expect!(
        "every-part-placed",
        "each of the add-on's 32 parts takes a model, and the survey refuses none"
    );
    expect!(
        "converter-by-part-name",
        "the converter U1 takes the ADS122U04's model, chosen by its symbol's part name",
        "the add-on's schematic gives the converter no manufacturer part number"
    );
    let survey = board_project("DS2", mad_catalog::boards::DS2)
        .survey(&set(), "DS2")
        .expect("the add-on surveys");
    assert_eq!(survey.part_count, 32);
    assert!(survey.compliant(), "{survey}");
    assert_eq!(
        placed(&survey, "U1"),
        (
            Some("ADS122U04".to_string()),
            Some("ads122u04, pins = \"tssop16\"".to_string())
        )
    );
}

#[rstest]
fn the_add_on_builds_on_its_bench_supplies() {
    behaviour!(Test {
        id: "catalog.mad-ds2-bench",
        covers: Some("SIL/mad-catalog/projects/ds2-bench.toml"),
        given: "the DS2 add-on's bench project: 3.3 volts on its digital side and strapped onto \
                its analog side, both input jumpers closed, and nothing on the converter's reset",
    });
    expect!(
        "reset-pulled-high",
        "the converter's reset input reads high through the add-on's 10 kilohm pull-up R10",
        "the converter answers nothing while its reset input floats"
    );
    expect!(
        "inputs-joined",
        "the bridge terminals A0 and A1 on J2 are the converter's analog inputs AIN0 and AIN1",
        "the series resistors R6 and R7 are not fitted, so the jumpers carry the bridge"
    );
    let (reset, a0, a1) = build("ds2-bench.toml", |built| {
        let reset = net_at(built, "DS2", "U1", "3");
        let state = built
            .nets()
            .iter()
            .find(|net| net.name == reset)
            .map(|net| net.state);
        let joined = |terminal: &str, input: &str| {
            built.names_are_merged(
                &net_at(built, "DS2", "J2", terminal),
                &net_at(built, "DS2", "U1", input),
            )
        };
        (state, joined("3", "11"), joined("4", "10"))
    });
    assert!(
        matches!(reset, Some(NetState::Pulled(Level::High, ohms)) if (ohms - 10_000.0).abs() < 1.0),
        "the reset net reads {reset:?}"
    );
    assert!(a0, "A0 (J2.3) and AIN0 (U1.11) are apart");
    assert!(a1, "A1 (J2.4) and AIN1 (U1.10) are apart");
}

#[rstest]
fn the_carrier_builds_with_the_module_seated_and_the_add_on_on_its_cable() {
    behaviour!(Test {
        id: "catalog.mad-edge-bench",
        covers: Some("SIL/mad-catalog/projects/edge-bench.toml"),
        given: "the Edge carrier with the P2 module seated in its socket and the DS2 add-on on \
                its force cable, on a bring-up rig's 12 volt and servo supplies",
    });
    expect!(
        "module-on-carrier-rail",
        "the module's two 5 volt fingers are on the carrier's 5 volt rail"
    );
    expect!(
        "cable-crossed",
        "the carrier's force-gauge transmit line reaches the add-on's receive pin, and the \
         add-on's transmit pin the carrier's receive line",
        "the cable crosses transmit and receive between the carrier's J9 and the add-on's J1, \
         and a series resistor on the add-on carries each line to the converter"
    );
    expect!(
        "receiver-over-range",
        "only the encoder's line receiver U25 is reported above its recommended range, once: \
         its supply at 5 volts, against a 3.6 volt maximum",
        "the carrier feeds its low-voltage AM26LV32 from the servo connector's 5 volt supply on \
         J21, the rail its 5 volt line driver U24 shares, inside the part's 6 volt absolute \
         maximum"
    );
    // The converter's serial pins, by the names the add-on's schematic gives
    // them.
    let converter = board_project("DS2", mad_catalog::boards::DS2)
        .survey(&set(), "DS2")
        .expect("the add-on surveys");
    let (converter_rx, converter_tx) = (
        pin_named(&converter, "U1", "RX"),
        pin_named(&converter, "U1", "TX"),
    );
    let (fingers, cable, over_range) = build("edge-bench.toml", |built| {
        let rail = net_at(built, "EDGE", "J3", "41");
        let fingers = ["41", "42"]
            .map(|finger| built.names_are_merged(&net_at(built, "EC32", "J203", finger), &rail));
        let rail_named_5v = rail == "EDGE.+5V";
        // The carrier's force-gauge lines on J9, each over the cable to the
        // add-on and through a series resistor to a converter pin.
        let carrier_tx = net_at(built, "EDGE", "J9", "4");
        let carrier_rx = net_at(built, "EDGE", "J9", "2");
        let reaches = |line: &str, resistor: &str, pin: &str| {
            beyond(built, "DS2", resistor, line) == net_at(built, "DS2", "U1", pin)
        };
        let tx_to_rx = reaches(&carrier_tx, "R3", &converter_rx);
        let tx_from_rx = reaches(&carrier_rx, "R4", &converter_tx);
        let over_range: Vec<(String, String, f64, f64, Option<f64>)> = built
            .diagnostics()
            .findings()
            .iter()
            .filter_map(|finding| match finding {
                Finding::PinAboveRecommended {
                    part,
                    pin,
                    volts,
                    max,
                    absolute_max,
                    ..
                } => Some((part.clone(), pin.clone(), *volts, *max, *absolute_max)),
                _ => None,
            })
            .collect();
        (
            (rail_named_5v, fingers),
            ((carrier_tx, carrier_rx), (tx_to_rx, tx_from_rx)),
            over_range,
        )
    });
    assert_eq!(fingers, (true, [true, true]));
    let ((carrier_tx, carrier_rx), (tx_to_rx, tx_from_rx)) = cable;
    assert_eq!(
        (carrier_tx.as_str(), carrier_rx.as_str()),
        (
            "EDGE./MaD_Edge_Sheet2/IFG_TX",
            "EDGE./MaD_Edge_Sheet2/IFG_RX"
        )
    );
    assert!(
        tx_to_rx,
        "the carrier's transmit line does not reach the converter's RX (U1.{converter_rx})"
    );
    assert!(
        tx_from_rx,
        "the converter's TX (U1.{converter_tx}) does not reach the carrier's receive line"
    );
    let [(part, pin, volts, max, absolute_max)] = over_range.as_slice() else {
        panic!("one pin above its recommended range, found {over_range:?}");
    };
    assert_eq!((part.as_str(), pin.as_str()), ("EDGE.U25", "16"));
    assert!((volts - 5.0).abs() < 1e-6, "U25's supply reads {volts} V");
    assert_eq!((*max, *absolute_max), (3.6, Some(6.0)));
}
