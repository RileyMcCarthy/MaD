//! The MaD board, described for the ISS.
//!
//! `system_description.rs` describes the same machine for the *native*
//! backend, and the two cannot share a description because they speak
//! different languages: the native one is keyed by HAL channel number and
//! DWARF symbol, because it substitutes the HAL; this one is keyed by **pin**,
//! because the ISS executes the firmware's real `WRPIN`/`DIR`/`OUT` and a pin
//! is all it has.
//!
//! That difference is the point. Under the native backend a wrong `activeLow`
//! in `HAL_GPIO_config.c` is invisible — the substituted HAL applies the
//! inversion on both sides. Here the firmware applies it and the bench does
//! not, so the polarity has to be right on the wire or the machine reads its
//! own ESD lines as tripped.

use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::Arc;

use embsim_board::netlist;
use embsim_board::{
    AttachError, Board, Component, ComponentNetIo, EndpointRef, Harness, JumperState, Level,
    PartRegistry, PinDecl, PinKind, Scenario, System, TheveninDrive,
};
use embsim_models::ads122u04;
use embsim_models::ads122u04_component::Ads122u04Component;
use embsim_models::machine::end_switch::{self, ActuationSense, EndSwitch};
use embsim_models::machine::quadrature_encoder::{self, QuadratureEncoder};
use embsim_models::machine::stepper_motor::{self, StepperMotor};
use p2iss::sdnode::SdCardNode;

use crate::system_description::{BridgeDrive, LoadCellBridge, BRIDGE_EXCITATION_V, DS2_NETLIST};

/// Pin roles, from `Firmware/MaDCore/src/HAL/Include/HW_pins.h`.
///
/// Deliberately the whole map, not only the pins wired so far: the gap between
/// this list and [`LEVEL_PINS`] is the remaining work, and it is easier to see
/// as a gap than to rediscover.
#[allow(dead_code)]
pub mod pins {
    pub const FORCE_GAUGE_RX: u8 = 0;
    pub const FORCE_GAUGE_TX: u8 = 2;
    pub const SERVO_RDY: u8 = 5;
    pub const SERVO_ENA: u8 = 6;
    pub const SERVO_DIR: u8 = 7;
    pub const SERVO_PUL: u8 = 8;
    pub const ENCODER_A: u8 = 9;
    pub const ENCODER_B: u8 = 10;
    pub const ENCODER_Z: u8 = 11;
    pub const ESD_UPPER: u8 = 16;
    pub const ESD_LOWER: u8 = 17;
    pub const ESD_SWITCH: u8 = 18;
    pub const ENDSTOP_UPPER: u8 = 19;
    pub const ENDSTOP_LOWER: u8 = 20;
    pub const ENDSTOP_DOOR: u8 = 21;
    pub const ESD_POWER: u8 = 22;
    pub const CHARGE_PUMP: u8 = 28;
    pub const RPI_RX: u8 = 53;
    pub const RPI_TX: u8 = 55;
}

/// Every pin the ISS carries on a net as a plain level.
///
/// Not the serial pins: those are [`p2iss::SerialLink`]s, which are the same
/// levels with a framer on top. Not `SERVO_PUL` either — the step train is a
/// rate, and belongs on a periodic drive rather than 8192 level edges per
/// millimetre.
pub const LEVEL_PINS: &[u8] = &[
    pins::SERVO_ENA,
    pins::SERVO_DIR,
    pins::ESD_POWER,
    pins::CHARGE_PUMP,
];

/// Pins the firmware only ever **reads**.
///
/// Split out from [`LEVEL_PINS`] because a pin that never drives must not own
/// a drive slot: the encoder's channels are driven by the encoder, the
/// endstops by their contacts, and a P2 that also claimed them would contend.
pub const INPUT_PINS: &[u8] = &[
    pins::SERVO_RDY,
    pins::ENCODER_A,
    pins::ENCODER_B,
    pins::ENCODER_Z,
    pins::ESD_UPPER,
    pins::ESD_LOWER,
    pins::ESD_SWITCH,
    pins::ENDSTOP_UPPER,
    pins::ENDSTOP_LOWER,
    pins::ENDSTOP_DOOR,
];

/// The level each input idles at when nothing else drives it.
///
/// Read straight off `HAL_GPIO_config.c`: a channel marked `activeLow` idles
/// **high**, because the firmware inverts it before deciding. Getting this
/// backwards boots the machine with all three ESD lines asserted, which the
/// native backend cannot reproduce and hardware would show immediately.
pub const IDLE_PULLS: &[(u8, Level)] = &[
    // The drive's enable. The firmware declares the line
    // (`HAL_GPIO_SERVO_ENA`) and never writes it, on purpose: the enable is
    // an open collector biased to its active level on the drive, so a P2 that
    // leaves it alone leaves the drive enabled. Without this pull the net
    // floats, the model reads "no level" as *not enabled*, and every step
    // edge is discarded — the step pin pulses, the carriage never moves, and
    // a closed-loop move runs forever chasing it.
    (pins::SERVO_ENA, Level::Low),
    // activeLow = false: inactive is low.
    (pins::SERVO_RDY, Level::Low),
    (pins::ENDSTOP_UPPER, Level::Low),
    (pins::ENDSTOP_LOWER, Level::Low),
    (pins::ENDSTOP_DOOR, Level::Low),
    (pins::ESD_POWER, Level::Low),
    // activeLow = true: inactive is high.
    (pins::ESD_UPPER, Level::High),
    (pins::ESD_LOWER, Level::High),
    (pins::ESD_SWITCH, Level::High),
];

/// A weak pull, in ohms. High enough that any real driver on the same net
/// wins the cluster solve, low enough to define a floating line — the same
/// 15 kΩ the P2's own internal pulls present.
const PULL_OHMS: f64 = 15_000.0;

/// The bench pull network: one weak resistor per input, to its idle rail.
///
/// Without it every unconnected input floats, `level_of` returns `None`, and
/// the adapter holds whatever it last saw — which at boot is low, i.e. all
/// three active-low ESD lines reading *asserted*.
pub struct BenchPulls {
    pins: Vec<PinDecl>,
    pulls: Vec<(u8, Level)>,
}

impl BenchPulls {
    pub fn new(pulls: &[(u8, Level)]) -> Self {
        Self {
            pins: pulls
                .iter()
                .map(|(pin, _)| PinDecl {
                    number: p2iss::pin_name(*pin),
                    name: None,
                    kind: PinKind::Analog,
                    stream: None,
                    drive_impedance: None,
                })
                .collect(),
            pulls: pulls.to_vec(),
        }
    }

    /// `("P2.P19", "PULLS.P19")` for each pull, ready for the harness.
    pub fn wires(&self) -> Vec<(String, String)> {
        self.pulls
            .iter()
            .map(|(pin, _)| {
                let name = p2iss::pin_name(*pin);
                (format!("P2.{name}"), format!("PULLS.{name}"))
            })
            .collect()
    }
}

impl Component for BenchPulls {
    fn pins(&self) -> &[PinDecl] {
        &self.pins
    }

    fn attach(&mut self, io: ComponentNetIo) -> Result<(), AttachError> {
        for (pin, level) in &self.pulls {
            let handle = io.pin(p2iss::pin_name(*pin))?;
            handle.set_drive(Some(TheveninDrive {
                volts: match level {
                    Level::High => 3.3,
                    Level::Low => 0.0,
                },
                impedance: PULL_OHMS,
            }));
        }
        Ok(())
    }
}

/// The force gauge link, from `HAL_serial_config.c`: the ADS122U04 on the DS2
/// Addon, 115'200 baud, P2 transmits on P2 and receives on P0.
pub const FORCE_GAUGE: p2iss::SerialLink = p2iss::SerialLink {
    tx_pin: pins::FORCE_GAUGE_TX,
    rx_pin: pins::FORCE_GAUGE_RX,
    nominal_baud: 115_200,
};

/// Everything on the bench except the MCU, and the wires that reach it.
///
/// The DS2 Addon board, the load cell, the two supply domains and the bench's
/// known-good fixes are identical whichever MCU is in the socket — that is the
/// point of describing a board rather than a program. Only the endpoints
/// differ, so they are parameters: the ISS names its pins `P2.P2` / `P2.P0`
/// where the native description names them `P2EVAL.P2` / `P2EVAL.P0`.
pub struct BenchForcePath {
    pub ds2: Board,
    pub load_cell: LoadCellBridge,
    pub bridge: BridgeDrive,
    pub scenario: Scenario,
}

impl BenchForcePath {
    pub fn build() -> Self {
        let mut registry = PartRegistry::new();
        registry.register("ADS122U04", |_decl| {
            // Ratiometric, matching the firmware's own config: VREF = AVDD =
            // the bridge excitation, PGA gain 128, so the excitation cancels.
            Box::new(Ads122u04Component::new(ads122u04::Config {
                vref_mv: 1_000.0 * BRIDGE_EXCITATION_V,
                gain: 128.0,
                zero_offset: 0,
            }))
        });
        let ds2 = Board::from_netlist(
            netlist::parse(DS2_NETLIST).expect("committed DS2 Addon netlist parses"),
            &registry,
        )
        .expect("DS2 Addon board builds");

        let bridge = BridgeDrive::default();
        let load_cell = LoadCellBridge {
            drive: bridge.clone(),
        };

        // The two bench fixes without which the real boards are silent: the
        // A0/A1 jumpers (R6/R7 are DNP, so the signal path is open as fabbed)
        // and the ~RESET strap (the stock PCB leaves U1.3 on a one-pin net).
        let scenario = Scenario::default()
            .jumper("DS2Addon.JP1", JumperState::Closed)
            .jumper("DS2Addon.JP2", JumperState::Closed)
            .pin_short("DS2Addon.U1.3", "DS2Addon.U1.13");

        Self {
            ds2,
            load_cell,
            bridge,
            scenario,
        }
    }

    /// Add the DS2's supply straps, serial cross-wires and bridge terminals,
    /// given the MCU's own endpoint names for the force-gauge pins.
    pub fn wire(&self, harness: Harness, fg_tx: &str, fg_rx: &str) -> Harness {
        let ep = |s: &str| EndpointRef::parse(s).expect("harness endpoint parses");
        harness
            // J1 digital straps. The ISS models no supply pins, so the rail is
            // a bench endpoint rather than the MCU's — electrically the same
            // 3V3 the P2-EVAL regulator provides.
            .power(ep("BENCH.3V3"), ep("DS2Addon.J1.1"), BRIDGE_EXCITATION_V)
            .power(ep("BENCH.GND"), ep("DS2Addon.J1.2"), 0.0)
            // Serial cross-wires, netlist truth: J1.3 → R3 → U1.16 (RX) takes
            // the P2's TX; U1.15 (TX) → R4 → J1.4 feeds the P2's RX.
            .connect(ep(fg_tx), ep("DS2Addon.J1.3"))
            .connect(ep("DS2Addon.J1.4"), ep(fg_rx))
            // J2 analog straps. POR needs BOTH supplies: the analog domain is
            // fully isolated on the PCB, so without these AVDD is unsourced
            // and the chip is silent.
            .power(ep("BENCH.3V3A"), ep("DS2Addon.J2.1"), BRIDGE_EXCITATION_V)
            .power(ep("BENCH.GNDA"), ep("DS2Addon.J2.2"), 0.0)
            // The load cell's live Thevenin drives land on A0/A1.
            .connect(ep("LoadCell.S+"), ep("DS2Addon.J2.3"))
            .connect(ep("LoadCell.S-"), ep("DS2Addon.J2.4"))
    }

    /// Mount the board and the load cell on `system`.
    /// The load cell's live drive, for applying a force to the bench.
    pub fn drive(&self) -> BridgeDrive {
        self.bridge.clone()
    }

    pub fn mount(self, system: System) -> System {
        system
            .board("DS2Addon", self.ds2)
            .component("LoadCell", Box::new(self.load_cell))
            .scenario(self.scenario)
    }
}

// ============================================================
// The machine: servo, encoder, end stops
// ============================================================

/// Steps per millimetre, matching the native wiring's `STEPS_PER_MM`
/// (4 × 2048 microsteps).
const STEPS_PER_MM: f64 = (4 * 2048) as f64;

/// Travel between the end stops, in millimetres.
///
/// 100 mm, from the firmware's own failsafe profile (`dev_nvram_config.c`
/// `maxPosition`) rather than a number chosen here — so a homing move that
/// runs to the stop stops where the firmware believes the machine ends.
const TRAVEL_MM: f64 = 100.0;

/// Pins that carry a **pulse train** rather than a static level.
///
/// Only the step clock. Everything else the firmware drives is a level that
/// changes when it decides, not a rate.
pub const PULSE_PINS: &[u8] = &[pins::SERVO_PUL];

/// The moving parts, and the shaft that couples them.
pub struct BenchMachine {
    pub motor: StepperMotor,
    pub encoder: QuadratureEncoder,
    pub upper: EndSwitch,
    pub lower: EndSwitch,
    /// Where the carriage has actually been, in micrometres.
    ///
    /// The carriage position is the one quantity that explains a motion
    /// failure and the one nothing reported: it is not on a net (see the note
    /// on the shaft below), the firmware only logs commanded targets, and the
    /// app samples too slowly to show an envelope. A commanded waveform that
    /// silently runs into an endstop looks, from every other vantage point,
    /// exactly like a test that simply never finishes.
    travel: Arc<CarriageTravel>,
}

/// Min/max carriage travel since the last report, in micrometres.
#[derive(Debug)]
pub struct CarriageTravel {
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

    /// `(now_mm, min_mm, max_mm)` since the last call; the window then resets.
    pub fn take_window(&self) -> (f64, f64, f64) {
        let now = self.now_um.load(Ordering::Relaxed);
        let min = self.min_um.swap(now, Ordering::Relaxed).min(now);
        let max = self.max_um.swap(now, Ordering::Relaxed).max(now);
        (
            now as f64 / 1000.0,
            min as f64 / 1000.0,
            max as f64 / 1000.0,
        )
    }
}

impl BenchMachine {
    pub fn build() -> Result<Self, Box<dyn std::error::Error>> {
        // The drive's own conventions, not the model's defaults. This machine
        // states them on the driver: DIR high = reverse, and the enable is an
        // open collector, so ENA low = enabled (the same pair
        // `board/tests/carriage_seam.rs` declares for this firmware). With the
        // defaults (DIR high = forward, ENA high = enabled) the firmware's
        // asserted enable read as *disabled* and the model ignored every step
        // edge: the step pin pulsed millions of times, the shaft never moved,
        // the encoder never counted, and a closed-loop move ran forever
        // chasing a carriage that was not there.
        let motor = StepperMotor::new(stepper_motor::Config {
            dir_forward_level: Level::Low,
            enable_active_low: true,
            // No load loss. `Config::new`'s 0.15 is the model's placeholder
            // for a drive that loses a share of its commanded travel, not a
            // measured property of this machine — and here it is the whole
            // error: the carriage moves 0.85x what it is told, so a 15 mm out
            // and 15 mm back ends ~3.5 mm from where it started, which is
            // what the lifecycle scenario measures and rejects. The board
            // test that exercises this same firmware's drive
            // (`embsim/board/tests/carriage_seam.rs`) sets 0.0 for the same
            // reason: the bench is here to test the firmware's loop, not to
            // invent mechanical losses nobody has measured.
            load_loss: 0.0,
            ..stepper_motor::Config::new(STEPS_PER_MM)
        })?;
        // Encoder counts per millimetre equal steps per millimetre: this servo
        // is closed-loop on the encoder, so the two scales are the same one.
        let encoder = QuadratureEncoder::new(quadrature_encoder::Config::new(STEPS_PER_MM))?;
        let upper = EndSwitch::new(end_switch::Config::new(
            TRAVEL_MM,
            ActuationSense::Increasing,
        ))?;
        let lower = EndSwitch::new(end_switch::Config::new(0.0, ActuationSense::Decreasing))?;

        // The shaft. Deliberately **not** a net: a carriage position is
        // millimetres, and there is no honest voltage for a millimetre. The
        // net carries what the wires carry — step edges in, quadrature and
        // contact closures out — and the mechanism between them is mechanism.
        let encoder_in = encoder.input();
        let upper_actuator = upper.actuator();
        let lower_actuator = lower.actuator();
        let travel = Arc::new(CarriageTravel::new());
        let travel_in = Arc::clone(&travel);
        motor.shaft().on_position_change(move |mm| {
            encoder_in.set_position_mm(mm);
            upper_actuator.set_position_mm(mm);
            lower_actuator.set_position_mm(mm);
            travel_in.record(mm);
        });

        Ok(Self {
            motor,
            encoder,
            upper,
            lower,
            travel,
        })
    }

    /// Where the carriage has been, for the run's own telemetry.
    pub fn travel(&self) -> Arc<CarriageTravel> {
        Arc::clone(&self.travel)
    }

    /// Wire the drive inputs, the encoder channels and the contacts.
    pub fn wire(&self, harness: Harness) -> Harness {
        let ep = |s: &str| EndpointRef::parse(s).expect("harness endpoint parses");
        let p = |pin: u8| format!("P2.{}", p2iss::pin_name(pin));
        harness
            // Drive inputs: the step train and the two static levels.
            .connect(ep(&p(pins::SERVO_PUL)), ep("MOTOR.STEP"))
            .connect(ep(&p(pins::SERVO_DIR)), ep("MOTOR.DIR"))
            .connect(ep(&p(pins::SERVO_ENA)), ep("MOTOR.ENA"))
            // Encoder channels back to the quadrature smart pin.
            .connect(ep("ENCODER.A"), ep(&p(pins::ENCODER_A)))
            .connect(ep("ENCODER.B"), ep(&p(pins::ENCODER_B)))
            .connect(ep("ENCODER.Z"), ep(&p(pins::ENCODER_Z)))
            // Dry contacts: COM sees the rail, NO reproduces it when closed.
            // The weak pull-down in `IDLE_PULLS` defines the pin while the
            // contact is open, exactly as a real pull-down does.
            .power(ep("BENCH.SW3V3"), ep("SWUPPER.COM"), BRIDGE_EXCITATION_V)
            .power(ep("BENCH.SW3V3"), ep("SWLOWER.COM"), BRIDGE_EXCITATION_V)
            .connect(ep("SWUPPER.NO"), ep(&p(pins::ENDSTOP_UPPER)))
            .connect(ep("SWLOWER.NO"), ep(&p(pins::ENDSTOP_LOWER)))
    }

    pub fn mount(self, system: System) -> System {
        system
            .component("MOTOR", Box::new(self.motor))
            .component("ENCODER", Box::new(self.encoder))
            .component("SWUPPER", Box::new(self.upper))
            .component("SWLOWER", Box::new(self.lower))
    }
}

// ============================================================
// The microSD card, on the wire
// ============================================================

/// The card as a bench component: four wires and a pull-up.
///
/// The pull-up is the one `sdmm.cc` itself asks for on the receive pin
/// (`P_HIGH_15K | P_LOW_15K`): a deselected card releases MISO, and
/// `disk_initialize` depends on an unanswered bus reading high.
/// The MaD SD wires, as FlexC's `_vfs_open_sdcard()` drives them:
/// `_vfs_open_sdcardx(pclk = 61, pss = 60, pdi = 59, pdo = 58)`. CLK and MOSI
/// are outputs the smart-pin hardware drives, CS is GPIO, MISO is an input.
/// The ISS reads which is clock / TX / RX from the mode words; these are only
/// for the harness wiring.
pub const SD_CLK: u8 = 61;
pub const SD_CS: u8 = 60;
pub const SD_MOSI: u8 = 59;
pub const SD_MISO: u8 = 58;

/// The pins the ISS carries on nets for the SD bus: three driven levels and
/// one input.
pub const SD_LEVEL_PINS: &[u8] = &[SD_MOSI, SD_CS, SD_CLK];
pub const SD_INPUT_PINS: &[u8] = &[SD_MISO];

pub struct BenchSd {
    pub node: SdCardNode,
}

impl BenchSd {
    pub fn build(image: Vec<u8>) -> Self {
        Self {
            node: SdCardNode::new({
                let mut c = p2core::SdCard::with_image(image);
                c.trace = Some(Vec::new());
                c
            }),
        }
    }

    pub fn wire(&self, harness: Harness) -> Harness {
        let ep = |s: &str| EndpointRef::parse(s).expect("harness endpoint parses");
        let p = |pin: u8| format!("P2.{}", p2iss::pin_name(pin));
        harness
            .connect(ep(&p(SD_CLK)), ep("SD.CLK"))
            .connect(ep(&p(SD_CS)), ep("SD.CS"))
            .connect(ep(&p(SD_MOSI)), ep("SD.MOSI"))
            .connect(ep(&p(SD_MISO)), ep("SD.MISO"))
            .connect(ep("SDPULL.A"), ep("SD.MISO"))
    }

    pub fn mount(self, system: System) -> System {
        // The pull-up must be a RESISTOR, not a power rail. Wired as `.power()`
        // it is a stiff 3.3 V source the card cannot pull low: every response
        // bit reads 1, `disk_initialize` times out, and the mount fails with
        // EIO — which is exactly how this wiring mistake was found.
        system
            .component("SD", Box::new(self.node))
            .component("SDPULL", Box::new(MisoPullUp::new()))
    }
}

/// The 15 kΩ pull-up `sdmm.cc` asks the receive pin for
/// (`P_HIGH_15K | P_LOW_15K`), as a bench part on the shared net.
pub struct MisoPullUp {
    pins: [PinDecl; 1],
}

impl MisoPullUp {
    pub fn new() -> Self {
        Self {
            pins: [PinDecl {
                number: "A",
                name: None,
                kind: PinKind::Analog,
                stream: None,
                drive_impedance: None,
            }],
        }
    }
}

impl Default for MisoPullUp {
    fn default() -> Self {
        Self::new()
    }
}

impl Component for MisoPullUp {
    fn pins(&self) -> &[PinDecl] {
        &self.pins
    }

    fn attach(&mut self, io: ComponentNetIo) -> Result<(), AttachError> {
        io.pin("A")?.set_drive(Some(TheveninDrive {
            volts: BRIDGE_EXCITATION_V,
            impedance: 15_000.0,
        }));
        Ok(())
    }
}
