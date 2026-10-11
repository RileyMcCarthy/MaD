//! A P2 step pin's train, as the motor drive on its net counts it.
//!
//! The ISS publishes the step clock as a square wave whose schedule counts in
//! nanoseconds of virtual time ([`p2iss::pulse`]). These drive the pin's
//! [`PulseDriver`] the way the guest's `WYPIN` and `_pinclear` do, at fixed
//! virtual instants, and read back what embsim's stepper drive on the far end
//! of the net was handed and counted. A schedule anchored or read in the wrong
//! unit is off by a factor of a thousand here, not by a pulse.

use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, Instant};

use embsim_board::{
    digital_drive, AttachError, Component, ComponentNetIo, Harness, Level, PeriodicSchedule,
    PinDecl, System,
};
use embsim_core::virtual_clock::{self, ClockMode};
use embsim_models::machine::{stepper_motor, StepperMotor};
use p2iss::pulse::PulseDriver;
use vibes_behaviour::{behaviour, expect, Test};

/// A millisecond of virtual time, in the engine's nanoseconds.
const MS: u64 = 1_000_000;

/// The clock the firmware runs at, `clkfreq` as `HUBSET` sets it.
const CLKFREQ: u32 = 160_000_000;

/// The NCO word for a 50 kHz wave at [`CLKFREQ`]: `Y × clkfreq / 2³²`.
const NCO_50_KHZ: u32 = 1_342_177;

static CLOCK_LOCK: Mutex<()> = Mutex::new(());

fn lock_clock() -> MutexGuard<'static, ()> {
    CLOCK_LOCK.lock().unwrap_or_else(|poisoned| {
        CLOCK_LOCK.clear_poison();
        poisoned.into_inner()
    })
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

/// What the guest asks of the step pin at one virtual instant.
#[derive(Debug, Clone, Copy)]
enum Command {
    /// `P_TRANSITION`: this many transitions, a half-period in clocks apart.
    Transitions { transitions: u64, half_clocks: u32 },
    /// `P_NCO_FREQ` with this word.
    Nco(u32),
    /// `_pinclear`.
    Stop,
}

/// The step pin, driven through the ISS's own [`PulseDriver`] at fixed
/// virtual instants.
struct StepPin {
    pins: [PinDecl; 1],
    script: Vec<(u64, Command)>,
}

impl Component for StepPin {
    fn pins(&self) -> &[PinDecl] {
        &self.pins
    }

    fn attach(&mut self, io: ComponentNetIo) -> Result<(), AttachError> {
        let driver = PulseDriver::new(8, io.pin("STEP")?);
        driver.idle();
        let script = self.script.clone();
        io.on_wake_ns(move |now| {
            for (_, command) in script.iter().filter(|(at, _)| *at == now) {
                match *command {
                    Command::Transitions {
                        transitions,
                        half_clocks,
                    } => driver.start_transitions(now, transitions, half_clocks, CLKFREQ),
                    Command::Nco(word) => driver.set_nco(now, word, CLKFREQ),
                    Command::Stop => driver.stop(now),
                }
            }
        });
        for (at, _) in &self.script {
            io.schedule_at_ns(*at);
        }
        Ok(())
    }
}

/// A pin held at one level: the drive's enable and direction inputs.
struct Held {
    pins: [PinDecl; 1],
}

impl Held {
    fn at(level: Level) -> Self {
        Self {
            pins: [PinDecl::digital_out("Q").with_idle(Some(digital_drive(level)))],
        }
    }
}

impl Component for Held {
    fn pins(&self) -> &[PinDecl] {
        &self.pins
    }

    fn attach(&mut self, _io: ComponentNetIo) -> Result<(), AttachError> {
        Ok(())
    }
}

/// Run `script` on the step pin with a stepper drive on its net, enabled and
/// pointing forward, and return the schedule the drive holds once it holds
/// `last`, and the steps it counted.
fn run(script: Vec<(u64, Command)>, last: PeriodicSchedule) -> (Option<PeriodicSchedule>, i64) {
    let _g = lock_clock();
    virtual_clock::init_mode(ClockMode::Stepped, CLKFREQ);
    let motor = StepperMotor::new(stepper_motor::Config::new(100.0)).expect("a valid drive");
    let shaft = motor.shaft();
    let ep = |s: &str| embsim_board::EndpointRef::parse(s).expect("endpoint parses");
    let system = System::new()
        .component(
            "P2",
            Box::new(StepPin {
                pins: [PinDecl::digital_out("STEP")],
                script,
            }),
        )
        // The drive's default conventions: enable active high, DIR high
        // forward.
        .component("ENA", Box::new(Held::at(Level::High)))
        .component("DIR", Box::new(Held::at(Level::High)))
        .component("MOTOR", Box::new(motor))
        .harness(
            Harness::new()
                .connect(ep("P2.STEP"), ep("MOTOR.STEP"))
                .connect(ep("ENA.Q"), ep("MOTOR.ENA"))
                .connect(ep("DIR.Q"), ep("MOTOR.DIR")),
        )
        .start()
        .expect("the bench starts");
    wait_for(|| shaft.train() == Some(last), Duration::from_secs(10));
    let held = (shaft.train(), shaft.commanded_steps());
    drop(system);
    held
}

#[test]
fn a_finite_train_stopped_partway_banks_the_pulses_it_ran() {
    behaviour!(Test {
        id: "p2iss.step-train-stopped-partway",
        covers: Some("SIL/p2iss/src/pulse.rs#PulseDriver::start_transitions"),
        given: "a step pin started at 1 ms on a train of 2000 transitions 800 processor clocks \
                apart at 160 MHz, and stopped at 6 ms, halfway through it",
    });
    expect!(
        "count-banked",
        "the stop hands the drive a held train carrying 500 pulses: one pulse for every two \
         transitions, at the train's rate, over the virtual time it ran"
    );
    expect!(
        "drive-steps",
        "the motor drive on the pin's net counts those 500 pulses as steps"
    );

    let stop = PeriodicSchedule {
        emitted: 500,
        freq_hz: 0,
        total: None,
        since_ns: 6 * MS,
    };
    let (held, steps) = run(
        vec![
            (
                MS,
                Command::Transitions {
                    transitions: 2000,
                    half_clocks: 800,
                },
            ),
            (6 * MS, Command::Stop),
        ],
        stop,
    );
    assert_eq!(held, Some(stop), "the drive holds the stop's banked count");
    assert_eq!(steps, 500, "and has counted every pulse of it");
}

#[test]
fn a_finite_train_ends_on_the_count_the_firmware_asked_for() {
    behaviour!(Test {
        id: "p2iss.step-train-runs-to-its-count",
        covers: Some("SIL/p2iss/src/pulse.rs#PulseDriver::start_transitions"),
        given: "a step pin started at 1 ms on a train of 2000 transitions 800 processor clocks \
                apart at 160 MHz, which ends at 11 ms, and stopped at 20 ms",
    });
    expect!(
        "count-capped",
        "the train ends on half its transition count, 1000 pulses, however long after it the \
         stop comes"
    );
    expect!(
        "drive-steps",
        "the motor drive on the pin's net counts exactly those 1000 pulses as steps"
    );

    let stop = PeriodicSchedule {
        emitted: 1000,
        freq_hz: 0,
        total: None,
        since_ns: 20 * MS,
    };
    let (held, steps) = run(
        vec![
            (
                MS,
                Command::Transitions {
                    transitions: 2000,
                    half_clocks: 800,
                },
            ),
            (20 * MS, Command::Stop),
        ],
        stop,
    );
    assert_eq!(held, Some(stop), "the drive holds the train's own ceiling");
    assert_eq!(steps, 1000, "and counted no pulse past it");
}

#[test]
fn a_retuned_wave_keeps_each_rate_for_its_own_span() {
    behaviour!(Test {
        id: "p2iss.step-wave-retuned",
        covers: Some("SIL/p2iss/src/pulse.rs#PulseDriver::set_nco"),
        given: "a step pin running a continuous wave from 1 ms at 50 kHz, retuned at 3 ms to \
                100 kHz, and stopped at 5 ms",
    });
    expect!(
        "count-per-span",
        "the stop banks each rate's pulses over its own span: 100 at 50 kHz and 200 at 100 kHz, \
         300 in all"
    );
    expect!(
        "drive-steps",
        "the motor drive on the pin's net counts those 300 pulses as steps"
    );

    let stop = PeriodicSchedule {
        emitted: 300,
        freq_hz: 0,
        total: None,
        since_ns: 5 * MS,
    };
    let (held, steps) = run(
        vec![
            (MS, Command::Nco(NCO_50_KHZ)),
            (3 * MS, Command::Nco(2 * NCO_50_KHZ)),
            (5 * MS, Command::Stop),
        ],
        stop,
    );
    assert_eq!(held, Some(stop), "the drive holds the banked count");
    assert_eq!(steps, 300, "and counted each span at its own rate");
}
