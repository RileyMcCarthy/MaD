//! Behaviours of the gantry model, declared for the Vibes ledger.
//!
//! These are ordinary `#[test]` functions; `behaviour!` only records what the
//! test claims so a reviewer can read it without opening the code.

use std::sync::{Arc, Mutex};

use models::gantry::{Config, Gantry};
use vibes_behaviour::{behaviour, Behaviour};

fn gantry(slack_mm: f64, tension_on_decreasing: bool) -> (Arc<Gantry>, Arc<Mutex<Vec<f64>>>) {
    let g = Gantry::new(Config {
        engagement_slack_mm: slack_mm,
        tension_on_decreasing_position: tension_on_decreasing,
        upper_threshold_mm: -1000.0,
        lower_threshold_mm: 1000.0,
    });
    let seen = Arc::new(Mutex::new(Vec::new()));
    let sink = Arc::clone(&seen);
    g.on_extension_change(move |mm| sink.lock().unwrap().push(mm));
    (g, seen)
}

#[test]
fn first_position_becomes_the_baseline() {
    behaviour!(Behaviour {
        id: "gantry.first-position-is-baseline",
        covers: Some("SIL/models/src/gantry.rs#on_position"),
        given: "the very first position report, whatever its absolute value",
        then: "the first position report becomes the zero of extension, rather than being read as travel",
        why: Some("the machine does not home to 0, so absolute position is not extension"),
    });

    let (g, seen) = gantry(0.0, false);
    g.on_position(37.5);
    assert_eq!(seen.lock().unwrap().as_slice(), &[0.0]);
}

#[test]
fn engagement_slack_is_consumed_before_extension() {
    behaviour!(Behaviour {
        id: "gantry.slack-consumed-before-extension",
        covers: Some("SIL/models/src/gantry.rs#on_position"),
        given: "travel smaller than the configured engagement slack",
        then: "extension stays at zero until travel exceeds the engagement slack",
        why: Some("the sample is not yet loaded, so reporting strain would be wrong"),
    });

    let (g, seen) = gantry(2.0, false);
    g.on_position(0.0);
    g.on_position(1.0); // inside the slack
    g.on_position(5.0); // 5mm travel, 2mm slack -> 3mm extension
    assert_eq!(seen.lock().unwrap().as_slice(), &[0.0, 0.0, 3.0]);
}

#[test]
fn tension_direction_is_configurable() {
    behaviour!(Behaviour {
        id: "gantry.tension-direction",
        covers: Some("SIL/models/src/gantry.rs#on_position"),
        given: "a machine whose tensile travel decreases machine position",
        then: "on a machine whose tensile direction is decreasing position, moving to a smaller position produces positive extension",
        why: Some("the DS2 gantry and the EdgeBoard gantry pull in opposite senses"),
    });

    let (g, seen) = gantry(0.0, true);
    g.on_position(10.0);
    g.on_position(4.0); // decreasing == tensile
    assert_eq!(seen.lock().unwrap().as_slice(), &[0.0, 6.0]);
}
