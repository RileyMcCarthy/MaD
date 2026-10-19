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
use std::process::ExitCode;
use std::sync::{Mutex, MutexGuard};

use embsim_board::{BuiltSystem, Finding, Level, NetState, PinRef, Project};
use embsim_boards::catalog::CatalogSet;
use embsim_cli::CatalogCrate;
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

/// The key and the model the survey gave `reference`.
fn placed(survey: &embsim_board::BoardSurvey, reference: &str) -> (Option<String>, Option<String>) {
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
        "the cable crosses transmit and receive between the carrier's J9 and the add-on's J1"
    );
    expect!(
        "receiver-over-range",
        "the encoder's line receiver U25 is reported once, for its supply at 5 volts above its \
         recommended 3.6 volts",
        "the carrier runs its AM26LV32 from 5 volts, inside its 6 volt absolute maximum"
    );
    let (fingers, cable, over_range) = build("edge-bench.toml", |built| {
        let rail = net_at(built, "EDGE", "J3", "41");
        let fingers = ["41", "42"]
            .map(|finger| built.names_are_merged(&net_at(built, "EC32", "J203", finger), &rail));
        let rail_named_5v = rail == "EDGE.+5V";
        let crossed = |edge: &str, addon: &str| {
            built.names_are_merged(
                &net_at(built, "EDGE", "J9", edge),
                &net_at(built, "DS2", "J1", addon),
            )
        };
        let over_range: Vec<(String, String)> = built
            .diagnostics()
            .findings()
            .iter()
            .filter_map(|finding| match finding {
                Finding::PinAboveRecommended { part, pin, .. } => Some((part.clone(), pin.clone())),
                _ => None,
            })
            .collect();
        (
            (rail_named_5v, fingers),
            (crossed("4", "3"), crossed("2", "4")),
            over_range,
        )
    });
    assert_eq!(fingers, (true, [true, true]));
    assert_eq!(cable, (true, true));
    assert_eq!(
        over_range,
        [("EDGE.U25".to_string(), "16".to_string())],
        "{over_range:?}"
    );
}

#[rstest]
fn the_bench_projects_check_through_mads_runner() {
    behaviour!(Test {
        id: "catalog.bench-projects-check",
        covers: Some("SIL/mad-runner/src/main.rs#main"),
        given: "the add-on's and the carrier's bench project files, each checked as MaD's \
                runner checks a project",
    });
    expect!(
        "ds2-checks",
        "the add-on's project builds, its catalogs those embsim ships and MaD's"
    );
    expect!(
        "edge-checks",
        "the carrier's project builds, its catalogs those embsim ships and MaD's"
    );
    let crates = [CatalogCrate::new(
        mad_catalog::NAME,
        env!("CARGO_MANIFEST_DIR"),
        mad_catalog::register,
    )];
    for file in ["ds2-bench.toml", "edge-bench.toml"] {
        let path = project_file(file);
        let (mut out, mut err) = (Vec::new(), Vec::new());
        let code = {
            let _clock = clock();
            embsim_cli::run_with_crates(
                &crates,
                [
                    "embsim".into(),
                    "check".into(),
                    path.clone().into_os_string(),
                ],
                &mut out,
                &mut err,
            )
        };
        let (out, err) = (String::from_utf8_lossy(&out), String::from_utf8_lossy(&err));
        assert_eq!(code, ExitCode::SUCCESS, "{file}: {err}\n{out}");
        assert!(
            out.contains("catalogs: embsim-boards, embsim-p2-qemu, embsim-cdp, mad-catalog"),
            "{file}: {out}"
        );
        assert!(
            out.contains(&format!("ok: {} builds", path.display())),
            "{file}: {out}"
        );
    }
}
