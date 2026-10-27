//! `mad-machine`: the tensile tester's mechanism as one bench component,
//! electrical pins outside and the mechanism inside (embsim `PROJECTS.md`
//! §10, "A plant: an `Assembly`" and "MaD's plant"; `MIGRATING-MAD.md` §3).
//!
//! The component is an [`Assembly`] of embsim's machine models and MaD's
//! own, the parts `mad-emulator` couples by callbacks today
//! (`BenchMachine::build` in `SIL/MaDSim/src/iss_description.rs`, the
//! gantry, sample and strain-gauge chain in `run_iss` in
//! `SIL/MaDSim/src/main.rs`, and the load cell in
//! `SIL/MaDSim/src/system_description.rs`):
//!
//! | Member | What it is | Its pins, as the machine's |
//! |---|---|---|
//! | `DRIVE` | embsim's `StepperMotor`: `drive_steps_per_mm` ([`STEPS_PER_MM`] by default), `DIR` low forward, enable active high (energized = enabled), no load loss | `STEP`, `DIR`, `ENA`, read against `DRIVE_GND` |
//! | `READY` | the drive's ready output, held at the level the firmware reads as not ready (below) | `SRDY`, against `DRIVE_GND` |
//! | `ENCODER` | embsim's `QuadratureEncoder`, `encoder_counts_per_mm` ([`STEPS_PER_MM`] by default), its output stage the `encoder_output` option | `ENC_A+`, `ENC_A-`, `ENC_B+`, `ENC_B-` (`rs422`) or `ENC_A+`, `ENC_B+` (`push-pull`, `npn-open-collector`), with `ENC_GND` their declared return (below) |
//! | `UPPER`, `LOWER` | embsim's `EndSwitch`, each a normally closed contact that opens past [`TRAVEL_MM`] and below 0 mm | `UPPER_COM`, `UPPER+`; `LOWER_COM`, `LOWER+` |
//! | `DOOR`, `ESD_U`, `ESD_L`, `ESD_A` | `EndSwitch` contacts no carriage moves: the door's closed, the emergency stops' open | `DOOR_COM`, `DOOR+`, … `ESD_A_COM`, `ESD_A+` |
//! | `LOAD_CELL` | MaD's load cell: the bridge's outputs behind 350 Ω, centred on the excitation it senses and scaled to it, released while either excitation pin reads nothing | `E+`, `E-` sensed, `S+`, `S-` driven |
//!
//! The gantry, the sample and the strain gauge (`SIL/models`) have no pins:
//! they are the link from the drive's shaft to the load cell, run inside the
//! drive's observation of its carriage, on the engine's thread at that
//! instant, as the shaft's links to the encoder and the switches are.
//!
//! # Options
//!
//! | Option | What it says |
//! |---|---|
//! | `encoder_output` | the encoder's output stage (`OutputStage::NAMES`): `rs422` by default, each channel a pair, what the Edge carrier's `J20` and its receiver `U25` are designed for; `npn-open-collector`, the machine's real encoder (a Taiss 600 P/R: A and B open collectors, no complements, no index), whose outputs sink while low and are released while high; or `push-pull` |
//! | `sample` | the sample in the grips, one this crate carries: `sil-linear-reference` (the default, `run_iss`'s `SIL-Linear-Reference`) |
//! | `drive_steps_per_mm` | the drive's steps a millimetre of carriage travel, above zero: [`STEPS_PER_MM`] by default. The firmware's machine profile must say the same (`servoStepsPerMM`) |
//! | `encoder_counts_per_mm` | the encoder's counts a millimetre, above zero: [`STEPS_PER_MM`] by default (`encoderStepsPerMM`). The two differ on a machine whose drive is geared or microstepped apart from its encoder, and the firmware pulses the drive by their ratio |
//!
//! On the Edge carrier as drawn, `J20`'s `+` legs have no pull-up and
//! `JP2`/`JP3` ground the `-` legs for a single-ended encoder, so an
//! `npn-open-collector` encoder leaves `P9` and `P10` high at every count
//! and the run reports `U25`'s pairs inside their band (`PairInBand`;
//! embsim `NODES.md` §20, `board/tests/edge_encoder_pairs.rs`): inferred
//! from the AM26LV32's datasheet and embsim's model, not yet checked on the
//! machine.
//!
//! # The switch loops
//!
//! Each contact is a loop the carrier reads through a current regulator and
//! an optocoupler (`IC9` and `U6` for the upper end switch): `+` is the
//! contact's far side, `COM` the side a project file wires to the loop's
//! supply, the carrier's `5V_IO` (`J5.1`–`J8.1`), and the loop returns to
//! `GND_IO` (`J5.3`–`J8.3`) on the carrier. Current in the loop lights the
//! opto and pulls its processor pin low (the 1 kΩ pull-ups `R2`, `R5`, …
//! to the module's bank supply; read: `netlists/mad_edge.net`). So each
//! contact rests in the state the firmware reads as inactive
//! (`IDLE_PULLS` in `iss_description.rs`, the `activeLow` flags in
//! `HAL_GPIO_config.c`): the end switches and the door, whose inactive
//! level is low, rest closed; the three emergency stops, whose inactive
//! level is high, rest open.
//!
//! # The drive's ready output
//!
//! `SRDY` is held at the firmware's inactive level for `SERVO_RDY` (`P5`,
//! low), as `mad-emulator` holds it (`IDLE_PULLS`). On the carrier `SC_SRDY`
//! (`J21.6`) has a 1 kΩ pull-up to `SC_5V` (`R25`) and reaches `P5` through
//! the non-inverting isolator `IC14`'s channel D, so an open output reads as
//! ready, and the inactive level is a sink (inferred from the netlist). The
//! sink is 0 V behind embsim's stated 25 Ω bench default
//! ([`DEFAULT_PUSH_PULL_IMPEDANCE`]): no drive datasheet names the output.
//! `IC14`'s secondary ground pins are on a net of their own on the carrier
//! as drawn (embsim `board/tests/edgeboard.rs`), so what `P5` reads there is
//! the board's question, not the machine's.
//!
//! # The encoder's return
//!
//! `ENC_GND` is the encoder's return as the migration plan names it, the
//! pin a project file wires to the carrier's `EN_GND` (`J20.5`). The
//! encoder's pins are declared against it, but each is an output, and a
//! drive's volts stay in the engine's frame (embsim `NODES.md` §16, the
//! assembly's `reference`), so nothing yet measures against `ENC_GND`,
//! the open collector's sink included: it is the wire the plan declares,
//! with no model behind it.
//!
//! # Not modelled
//!
//! - **The encoder's supply** (the Taiss's red wire): `J20` has no supply
//!   pin, and embsim's encoder declares none (its *Not modeled*), so the
//!   machine has none.
//! - **An index channel**: MaD's plant configures none, and the firmware
//!   reads only A and B (`HAL_encoder_config.c`).
//! - **Pressing an emergency stop, opening the door**: each holds its rest
//!   state.
//! - **A jammed carriage** (`mad-emulator`'s `Coupling`, jammed while its
//!   `--jam-file` exists): a lever a stepped kind cannot take from a file the
//!   wall clock polls; the carriage always follows the shaft.

use std::fmt;
use std::sync::atomic::{AtomicI64, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use embsim_board::net::DEFAULT_PUSH_PULL_IMPEDANCE;
use embsim_board::{
    Assembly, AttachError, Component, ComponentNetIo, ComponentRequest, Drive, KindInfo, Level,
    PinDecl, PinHandle, ProjectError, Report, TheveninDrive, Volts,
};
use embsim_models::machine::end_switch::{self, ActuationSense, EndSwitch};
use embsim_models::machine::quadrature_encoder::{self, EncoderInput, OutputStage};
use embsim_models::machine::stepper_motor::{self, MotorShaft};
use embsim_models::machine::{QuadratureEncoder, StepperMotor};
use models::gantry::{self, Gantry};
use models::sample::{self, MaterialProperties, Sample};
use models::strain_gauge::{self, StrainGauge};

/// The machine's bench component kind.
pub const MACHINE: &str = "mad-machine";

// ============================================================
// The machine's figures, each MaD's current plant's
// ============================================================

/// Drive steps, and encoder counts, per millimetre of carriage travel when
/// the project says nothing else: 4 × 2048 microsteps, the firmware's
/// failsafe profile (`dev_nvram_config.c`: `encoderStepsPerMM` and
/// `servoStepsPerMM` alike). The `drive_steps_per_mm` and
/// `encoder_counts_per_mm` options set each on its own.
pub const STEPS_PER_MM: f64 = (4 * 2048) as f64;

/// The drive's and the encoder's scales, each per millimetre of travel.
#[derive(Debug, Clone, Copy)]
struct Scales {
    drive_steps_per_mm: f64,
    encoder_counts_per_mm: f64,
}

/// Where the upper end switch opens: 100 mm, the firmware's failsafe
/// `maxPosition` (`Firmware/MaDCore/src/DEV/Config/dev_nvram_config.c`),
/// `TRAVEL_MM` in `iss_description.rs`.
pub const TRAVEL_MM: f64 = 100.0;

/// Where the lower end switch opens: the carriage's start, 0 mm (the lower
/// switch of `BenchMachine::build`).
pub const LOWER_MM: f64 = 0.0;

/// Grip slack before the sample takes load, in millimetres: `run_iss`'s
/// gantry (`engagement_slack_mm: 15.0`, `SIL/MaDSim/src/main.rs`).
pub const GANTRY_SLACK_MM: f64 = 15.0;

/// The gantry's own limit comparators, parked outside the working range as
/// `run_iss` parks them (`upper_threshold_mm: -10.0`, `lower_threshold_mm:
/// 300.0`): the end switches are embsim's contacts, so the gantry's are
/// unused.
const GANTRY_UPPER_PARKED_MM: f64 = -10.0;
const GANTRY_LOWER_PARKED_MM: f64 = 300.0;

/// The load cell's full scale, in newtons: `run_iss`'s strain gauge
/// (`full_scale_force_n: 100.0`).
pub const GAUGE_FULL_SCALE_N: f64 = 100.0;

/// The load cell's sensitivity at full scale, mV/V: `run_iss`'s strain gauge
/// (`sensitivity_mv_per_v: -4.868009`).
pub const GAUGE_MV_PER_V: f64 = -4.868009;

/// The excitation the strain gauge's model is configured at, volts:
/// `run_iss`'s strain gauge (`excitation_v: 3.3`). The bridge rescales the
/// gauge's millivolts by the excitation it senses on `E±` against this one:
/// a bridge's output is ratiometric (`SIL/models/src/strain_gauge.rs`'s
/// governing equation).
pub const GAUGE_EXCITATION_V: f64 = 3.3;

/// Each bridge output's source impedance: the Wishiot 10 kg cell's 350 Ω
/// full bridge, `BRIDGE_SOURCE_OHMS` in
/// `SIL/MaDSim/src/system_description.rs`.
pub const BRIDGE_SOURCE_OHMS: f64 = 350.0;

/// The ready output's sink: 0 V behind embsim's stated bench default
/// impedance (module docs, "The drive's ready output").
const READY_SINK: TheveninDrive = TheveninDrive {
    volts: 0.0,
    impedance: DEFAULT_PUSH_PULL_IMPEDANCE,
};

/// The encoder's pins as the machine's: each channel, then each channel's
/// complement, which only the line driver has.
const ENCODER_PINS: [(&str, &str); 4] = [
    ("A", "ENC_A+"),
    ("B", "ENC_B+"),
    ("A-", "ENC_A-"),
    ("B-", "ENC_B-"),
];

/// The actuator of a contact no carriage moves: the door's is put at its
/// operate point once, so it closes; the emergency stops' never reach it.
const HELD_AT_OPERATE_MM: f64 = 0.0;

// ============================================================
// The sample
// ============================================================

/// A sample this crate carries, named by the `sample` option.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum SamplePreset {
    /// `run_iss`'s `SIL-Linear-Reference` (`SIL/MaDSim/src/main.rs`): 5 N
    /// over the 85 mm of travel past the grip slack, a linear bar of 20 mm²
    /// on a 20 mm gauge length.
    #[default]
    SilLinearReference,
}

impl SamplePreset {
    /// Every preset, in the order [`Self::NAMES`] names them.
    pub const ALL: [Self; 1] = [Self::SilLinearReference];

    /// The presets' names, as the `sample` option takes them.
    pub const NAMES: [&'static str; 1] = ["sil-linear-reference"];

    /// The preset's name ([`Self::NAMES`]).
    pub const fn name(self) -> &'static str {
        match self {
            Self::SilLinearReference => Self::NAMES[0],
        }
    }

    /// The preset a name names, or `None`.
    pub fn from_name(name: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|preset| preset.name() == name)
    }

    /// The sample model's configuration, as `run_iss` sets it.
    fn config(self) -> sample::Config {
        match self {
            Self::SilLinearReference => {
                let modulus = 5.0 / (TRAVEL_MM - GANTRY_SLACK_MM);
                sample::Config {
                    stiffness_n_per_mm: modulus,
                    tension_on_decreasing_position: false,
                    material: Some(MaterialProperties {
                        name: "SIL-Linear-Reference",
                        youngs_modulus_mpa: modulus,
                        area_mm2: 20.0,
                        gauge_length_mm: 20.0,
                    }),
                }
            }
        }
    }
}

// ============================================================
// The kind
// ============================================================

/// The kind as someone choosing one reads it. It requires no option.
pub(crate) fn kind_info() -> KindInfo {
    KindInfo::new(
        MACHINE,
        "the tensile tester's mechanism as one component: the servo drive's inputs STEP, DIR \
         and ENA and its ready output SRDY against DRIVE_GND, the encoder with its return \
         ENC_GND (options.encoder_output: rs422, the default, npn-open-collector or \
         push-pull), the end switch, door and emergency-stop loops as contacts (each NAME_COM \
         and NAME+), and the load cell's bridge (E+, E- sensed; S+, S- driven); \
         options.sample: sil-linear-reference; options.drive_steps_per_mm and \
         options.encoder_counts_per_mm: each 8192 by default",
    )
}

/// Build the machine a `[[component]]` names, and add its report.
pub(crate) fn component(request: ComponentRequest<'_>) -> Result<Box<dyn Component>, ProjectError> {
    let context = request.context();
    let ComponentRequest {
        spec,
        mut options,
        reports,
        ..
    } = request;
    let output = options
        .choice("encoder_output", &OutputStage::NAMES)?
        .and_then(OutputStage::from_name)
        .unwrap_or(OutputStage::Rs422);
    let sample = options
        .choice("sample", &SamplePreset::NAMES)?
        .and_then(SamplePreset::from_name)
        .unwrap_or_default();
    let mut scale = |name: &'static str| -> Result<f64, ProjectError> {
        match options.number(name)? {
            None => Ok(STEPS_PER_MM),
            Some(value) if value > 0.0 && value.is_finite() => Ok(value),
            Some(value) => Err(ProjectError::message(format!(
                "{context}: options.{name} is a scale a millimetre, above zero; {value} is not"
            ))),
        }
    };
    let scales = Scales {
        drive_steps_per_mm: scale("drive_steps_per_mm")?,
        encoder_counts_per_mm: scale("encoder_counts_per_mm")?,
    };
    options.finish()?;
    let (machine, report) = assemble(output, sample, scales)
        .map_err(|err| ProjectError::message(format!("{context}: {err}")))?;
    reports.add(MachineReport {
        subject: spec.name.clone(),
        said: None,
        ..report
    });
    Ok(Box::new(machine))
}

/// The machine's members, linked, as one assembly, and what its report
/// reads.
fn assemble(
    output: OutputStage,
    sample: SamplePreset,
    scales: Scales,
) -> Result<(Assembly, MachineReport), Box<dyn std::error::Error>> {
    // The drive's own conventions: DIR high is reverse, the enable is
    // energized = enabled, so ENA high enables (the machine's owner,
    // 2026-10-25: the firmware drives it high to enable, through IC14's OUTC
    // on JP1's default pads 1-2), and no load loss.
    let drive = StepperMotor::new(stepper_motor::Config {
        dir_forward_level: Level::Low,
        enable_active_low: false,
        load_loss: 0.0,
        ..stepper_motor::Config::new(scales.drive_steps_per_mm)
    })?;
    let encoder = QuadratureEncoder::new(
        quadrature_encoder::Config::new(scales.encoder_counts_per_mm).with_output(output),
    )?;
    // Normally closed: each closes on the carriage's side of its point and
    // opens past it.
    let upper = EndSwitch::new(end_switch::Config::new(
        TRAVEL_MM,
        ActuationSense::Decreasing,
    ))?;
    let lower = EndSwitch::new(end_switch::Config::new(
        LOWER_MM,
        ActuationSense::Increasing,
    ))?;
    let held = || {
        EndSwitch::new(end_switch::Config::new(
            HELD_AT_OPERATE_MM,
            ActuationSense::Increasing,
        ))
    };
    let (door, esd_upper, esd_lower, esd_switch) = (held()?, held()?, held()?, held()?);
    door.actuator().set_position_mm(HELD_AT_OPERATE_MM);

    let gantry = Gantry::new(gantry::Config {
        engagement_slack_mm: GANTRY_SLACK_MM,
        tension_on_decreasing_position: false,
        upper_threshold_mm: GANTRY_UPPER_PARKED_MM,
        lower_threshold_mm: GANTRY_LOWER_PARKED_MM,
    });
    let specimen = Sample::new(sample.config());
    let gauge = StrainGauge::new(strain_gauge::Config {
        full_scale_force_n: GAUGE_FULL_SCALE_N,
        sensitivity_mv_per_v: GAUGE_MV_PER_V,
        excitation_v: GAUGE_EXCITATION_V,
    });
    let load_cell = LoadCell::new();

    // The chain from the carriage to the bridge: extension past the slack,
    // the sample's force, the gauge's millivolts.
    let force = Arc::new(AtomicU64::new(0.0_f64.to_bits()));
    {
        let specimen = Arc::clone(&specimen);
        gantry.on_extension_change(move |mm| specimen.on_extension(mm));
    }
    {
        let (gauge, force) = (Arc::clone(&gauge), Arc::clone(&force));
        specimen.on_change(move |newtons| {
            force.store(newtons.to_bits(), Ordering::Relaxed);
            gauge.set_force(newtons);
        });
    }
    {
        let bridge = load_cell.input();
        gauge.on_change(move |millivolts| bridge.set_output_mv(millivolts));
    }

    // The shaft: the carriage turns the encoder, reaches the end switches and
    // strains the sample. Each runs inside the drive's observation.
    let travel = Arc::new(CarriageTravel::new());
    let (count, up, down) = (encoder.input(), upper.actuator(), lower.actuator());
    let feed = {
        let (gantry, travel) = (Arc::clone(&gantry), Arc::clone(&travel));
        move |mm: f64| {
            count.set_position_mm(mm);
            up.set_position_mm(mm);
            down.set_position_mm(mm);
            gantry.on_position(mm);
            travel.record(mm);
        }
    };
    // The carriage starts at 0 mm and the drive publishes only a change, so
    // every follower is handed the start once: the switches close, the
    // sample's zero-force baseline is the start.
    feed(0.0);
    let shaft = drive.shaft();
    shaft.on_position_change(feed);

    let encoder_input = encoder.input();
    // Only the line driver has the `-` legs.
    let encoder_pins = if output.has_complements() {
        &ENCODER_PINS[..]
    } else {
        &ENCODER_PINS[..2]
    };
    let encoder_measured: Vec<&'static str> = encoder_pins.iter().map(|&(_, pin)| pin).collect();
    let contact = |com: &'static str, plus: &'static str| [("COM", com), ("NO", plus)];
    let machine = Assembly::new()
        .member(
            "DRIVE",
            Box::new(drive),
            &[("STEP", "STEP"), ("DIR", "DIR"), ("ENA", "ENA")],
        )?
        .member("READY", Box::new(ReadyOutput), &[("SRDY", "SRDY")])?
        .member("ENCODER", Box::new(encoder), encoder_pins)?
        .member("UPPER", Box::new(upper), &contact("UPPER_COM", "UPPER+"))?
        .member("LOWER", Box::new(lower), &contact("LOWER_COM", "LOWER+"))?
        .member("DOOR", Box::new(door), &contact("DOOR_COM", "DOOR+"))?
        .member(
            "ESD_U",
            Box::new(esd_upper),
            &contact("ESD_U_COM", "ESD_U+"),
        )?
        .member(
            "ESD_L",
            Box::new(esd_lower),
            &contact("ESD_L_COM", "ESD_L+"),
        )?
        .member(
            "ESD_A",
            Box::new(esd_switch),
            &contact("ESD_A_COM", "ESD_A+"),
        )?
        .member(
            "LOAD_CELL",
            Box::new(load_cell),
            &[("E+", "E+"), ("E-", "E-"), ("S+", "S+"), ("S-", "S-")],
        )?
        .reference("DRIVE_GND", &["STEP", "DIR", "ENA", "SRDY"])?
        .reference("ENC_GND", &encoder_measured)?;
    let report = MachineReport {
        subject: String::new(),
        shaft,
        encoder: encoder_input,
        travel,
        force,
        encoder_counts_per_mm: scales.encoder_counts_per_mm,
        said: None,
    };
    Ok((machine, report))
}

// ============================================================
// The drive's ready output
// ============================================================

/// The ready output's one pin: an open collector held sinking, a static
/// declaration the board stamps from build.
const READY_PINS: [PinDecl; 1] = [PinDecl::digital_out("SRDY")
    .sink_only()
    .with_idle(Some(READY_SINK))];

/// The drive's ready output, held at the level the firmware reads as not
/// ready (module docs).
struct ReadyOutput;

impl Component for ReadyOutput {
    fn pins(&self) -> &[PinDecl] {
        &READY_PINS
    }

    fn attach(&mut self, _io: ComponentNetIo) -> Result<(), AttachError> {
        Ok(())
    }
}

// ============================================================
// The load cell
// ============================================================

/// `S+` and `S-`.
type Outputs = (PinHandle, PinHandle);

/// What `S+` and `S-` drive, volts in the engine's frame.
type Levels = (Volts, Volts);

/// The bridge's terminals: the excitation it reads, the strain gauge's last
/// output, and the outputs it drives once attached.
#[derive(Default)]
struct Bridge {
    /// What `E+` and `E-` read, in the engine's frame.
    excitation: (Option<Volts>, Option<Volts>),
    /// The strain gauge's output at its configured excitation, millivolts.
    output_mv: f64,
    /// `S+` and `S-`, once attached.
    outputs: Option<Outputs>,
}

impl Bridge {
    /// What `S+` and `S-` present now: each behind the cell's 350 Ω, at the
    /// excitation's midpoint plus and minus half the output, the output
    /// rescaled to the excitation sensed; released while either excitation
    /// pin reads no voltage (a bridge with no excitation drives nothing).
    fn drives(&self) -> Option<(Outputs, Option<Levels>)> {
        let outputs = self.outputs.clone()?;
        let levels = match self.excitation {
            (Some(high), Some(low)) => {
                let half = self.output_mv / 1_000.0 * (high - low) / GAUGE_EXCITATION_V / 2.0;
                let middle = (high + low) / 2.0;
                Some((middle + half, middle - half))
            }
            _ => None,
        };
        Some((outputs, levels))
    }
}

/// Drive the bridge's outputs from its state, with no lock held.
fn publish(bridge: &Mutex<Bridge>) {
    let drives = bridge
        .lock()
        .expect("the bridge is never poisoned")
        .drives();
    let Some(((positive, negative), levels)) = drives else {
        return;
    };
    match levels {
        Some((high, low)) => {
            let port = |volts| {
                Drive::Thevenin(TheveninDrive {
                    volts,
                    impedance: BRIDGE_SOURCE_OHMS,
                })
            };
            positive.drive(port(high));
            negative.drive(port(low));
        }
        None => {
            positive.release();
            negative.release();
        }
    }
}

/// The strain gauge's side of the load cell: where the chain hands it its
/// output.
#[derive(Clone)]
struct LoadCellInput {
    bridge: Arc<Mutex<Bridge>>,
}

impl LoadCellInput {
    /// The gauge's output, millivolts at its configured excitation.
    fn set_output_mv(&self, millivolts: f64) {
        self.bridge
            .lock()
            .expect("the bridge is never poisoned")
            .output_mv = millivolts;
        publish(&self.bridge);
    }
}

/// MaD's load cell (`LoadCellBridge` and `BridgeDrive` in
/// `SIL/MaDSim/src/system_description.rs`): its excitation sensed on `E±`,
/// its outputs `S±` driven.
struct LoadCell {
    bridge: Arc<Mutex<Bridge>>,
}

/// `E±` read the solved voltage; `S±` are linear sources, released until
/// the bridge has an excitation to centre on.
const LOAD_CELL_PINS: [PinDecl; 4] = [
    PinDecl::analog("E+"),
    PinDecl::analog("E-"),
    PinDecl::analog_source("S+"),
    PinDecl::analog_source("S-"),
];

impl LoadCell {
    fn new() -> Self {
        Self {
            bridge: Arc::default(),
        }
    }

    fn input(&self) -> LoadCellInput {
        LoadCellInput {
            bridge: Arc::clone(&self.bridge),
        }
    }
}

impl Component for LoadCell {
    fn pins(&self) -> &[PinDecl] {
        &LOAD_CELL_PINS
    }

    fn attach(&mut self, io: ComponentNetIo) -> Result<(), AttachError> {
        self.bridge
            .lock()
            .expect("the bridge is never poisoned")
            .outputs = Some((io.pin("S+")?, io.pin("S-")?));
        for (pin, positive) in [("E+", true), ("E-", false)] {
            let bridge = Arc::clone(&self.bridge);
            io.on_sense(pin, move |sense| {
                {
                    let mut state = bridge.lock().expect("the bridge is never poisoned");
                    if positive {
                        state.excitation.0 = sense.volts;
                    } else {
                        state.excitation.1 = sense.volts;
                    }
                }
                publish(&bridge);
            })?;
        }
        Ok(())
    }
}

// ============================================================
// The report
// ============================================================

/// Where the carriage has been, in micrometres: the window since the last
/// look (`CarriageTravel` in `iss_description.rs`).
#[derive(Debug)]
struct CarriageTravel {
    now_um: AtomicI64,
    min_um: AtomicI64,
    max_um: AtomicI64,
}

impl CarriageTravel {
    fn new() -> Self {
        Self {
            now_um: AtomicI64::new(0),
            min_um: AtomicI64::new(i64::MAX),
            max_um: AtomicI64::new(i64::MIN),
        }
    }

    fn record(&self, mm: f64) {
        let um = (mm * 1000.0) as i64;
        self.now_um.store(um, Ordering::Relaxed);
        self.min_um.fetch_min(um, Ordering::Relaxed);
        self.max_um.fetch_max(um, Ordering::Relaxed);
    }

    /// `(now, min, max)` in micrometres since the last call; the window then
    /// starts again from where the carriage is.
    fn take_window(&self) -> (i64, i64, i64) {
        let now = self.now_um.load(Ordering::Relaxed);
        let min = self.min_um.swap(now, Ordering::Relaxed).min(now);
        let max = self.max_um.swap(now, Ordering::Relaxed).max(now);
        (now, min, max)
    }
}

/// What the machine says: where the carriage went since the last look, and
/// at the end where it is, what the drive was commanded, the encoder's
/// count and the force on the sample.
struct MachineReport {
    subject: String,
    shaft: MotorShaft,
    encoder: EncoderInput,
    travel: Arc<CarriageTravel>,
    /// The sample's force, newtons, as `f64` bits.
    force: Arc<AtomicU64>,
    /// The encoder's scale, to say its count in millimetres.
    encoder_counts_per_mm: f64,
    /// The last window said, so a carriage at rest says nothing.
    said: Option<(i64, i64, i64)>,
}

impl fmt::Debug for MachineReport {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("MachineReport")
            .field("subject", &self.subject)
            .finish_non_exhaustive()
    }
}

/// Micrometres as millimetres, to the micrometre.
fn mm(um: i64) -> String {
    format!("{:.3}", um as f64 / 1000.0)
}

impl Report for MachineReport {
    fn subject(&self) -> String {
        self.subject.clone()
    }

    fn look(&mut self, _now_ns: u64) -> Vec<String> {
        let window = self.travel.take_window();
        let moved = window.1 != window.2 || self.said.is_none_or(|said| said.0 != window.0);
        if !moved {
            return Vec::new();
        }
        self.said = Some(window);
        let (now, min, max) = window;
        vec![format!(
            "carriage {} mm ({}..{} mm since the last look)",
            mm(now),
            mm(min),
            mm(max)
        )]
    }

    fn summary(&self) -> Vec<String> {
        let count = self.encoder.count();
        vec![format!(
            "encoder at {count} counts ({:.6} mm), {} steps commanded, {:.6} N on the sample",
            count as f64 / self.encoder_counts_per_mm,
            self.shaft.commanded_steps(),
            f64::from_bits(self.force.load(Ordering::Relaxed)),
        )]
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `run_iss`'s reference: 5 N over the 85 mm of travel past the slack,
    /// as its material's E·A/L (which the sample model uses when the
    /// material is valid) and as its plain stiffness alike.
    #[test]
    fn the_reference_sample_is_five_newtons_over_eighty_five_millimetres() {
        let config = SamplePreset::SilLinearReference.config();
        let material = config.material.expect("the reference names its material");
        let stiffness = material.youngs_modulus_mpa * material.area_mm2 / material.gauge_length_mm;
        assert!((stiffness - 5.0 / 85.0).abs() < 1e-15, "{stiffness}");
        assert!(
            (config.stiffness_n_per_mm - 5.0 / 85.0).abs() < 1e-15,
            "{}",
            config.stiffness_n_per_mm
        );
    }

    #[test]
    fn every_preset_is_named_by_its_name() {
        for preset in SamplePreset::ALL {
            assert_eq!(SamplePreset::from_name(preset.name()), Some(preset));
        }
        assert_eq!(SamplePreset::from_name("steel"), None);
    }
}
