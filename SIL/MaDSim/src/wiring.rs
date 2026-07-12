//! MaD machine — the [`embsim_runtime::Machine`] for the MaD tensile tester.
//!
//! This is the project-specific seam: it declares the firmware's peripheral
//! channel counts, names the host serial channel, and wires every peripheral
//! event to/from the physical models. All MaD-specific constants (steps/mm,
//! thresholds, ADC calibration) live here in the model `Config` structs.
//!
//! Callback chain:
//! ```text
//!   pulse_out (single integrator: emitted = freq × elapsed_virtual_time;
//!              what firmware reads via HAL_pulseOut_run)
//!     ├── on_start ─────> snapshot encoder base + direction (from SERVO_DIR GPIO)
//!     └── on_progress ──> encoder::set(base + dir * emitted)   ← matches firmware exactly
//!                          ├── gantry::on_position(pos_mm)
//!                          │     ├── extension_mm ──> sample::on_extension(extension_mm)
//!                          │     └── upper/lower ──> endstop GPIO
//!                          └── strain_gauge::set_force(force_n)
//!                                         └── ads122u04::set_voltage(voltage_mv)
//!                                                (ads122u04 thread sends ADC data
//!                                                 over serial at 100Hz)
//!
//!   gpio SERVO_ENA ──on_change──> trace only (informational)
//!   gpio SERVO_DIR ──on_change──> trace only; direction is sampled at on_start
//!
//!   gantry::on_upper_change ──> gpio::set_state(ENDSTOP_UPPER)
//!   gantry::on_lower_change ──> gpio::set_state(ENDSTOP_LOWER)
//!
//!   serial ch0 (FORCE_GAUGE) ───fd──> ads122u04 (socketpair)
//!   serial ch1 (MAIN)        ───fd──> PTY (wired by the runtime)
//! ```

use std::sync::Arc;

use models::sample::{Config as SampleConfig, MaterialProperties, Sample};
use models::{gantry, strain_gauge};
use embsim_memory_inspect::FirmwareInfo;
use embsim_models::ads122u04;
use embsim_peripherals::{encoder, gpio, pulse_out, serial};
use embsim_runtime::{Machine, PeripheralCounts};
use embsim_trace::{self, groups, Signal};
use tracing::info;

/// Steps per mm (must match firmware: 4 microsteps × 2048 steps/rev).
const STEPS_PER_MM: f64 = (4 * 2048) as f64;

/// The MaD tensile tester machine.
pub struct MadMachine;

/// Firmware enum variants/types this machine looks up. Listed so the runtime
/// can report all missing ones at once when porting to changed firmware.
const REQUIRED_SYMBOLS: &[&str] = &[
    // GPIO channel variants
    "HAL_GPIO_SERVO_ENA",
    "HAL_GPIO_SERVO_DIR",
    "HAL_GPIO_SERVO_RDY",
    "HAL_GPIO_ESD_UPPER",
    "HAL_GPIO_ESD_LOWER",
    "HAL_GPIO_ESD_SWITCH",
    "HAL_GPIO_ENDSTOP_UPPER",
    "HAL_GPIO_ENDSTOP_LOWER",
    "HAL_GPIO_ENDSTOP_DOOR",
    "HAL_GPIO_ESD_POWER",
    "HAL_GPIO_CHARGE_PUMP",
    // Other peripheral channel variants
    "HAL_ENCODER_CHANNEL_SERVO",
    "HAL_PULSE_OUT_CHANNEL_SERVO",
    "HAL_SERIAL_CHANNEL_FORCE_GAUGE",
    "HAL_SERIAL_CHANNEL_MAIN",
    // Enum types used for channel counts
    "HAL_GPIO_channel_E",
    "HAL_serial_channel_E",
    "HAL_encoder_channel_E",
    "HAL_pulseOut_channel_E",
];

impl Machine for MadMachine {
    fn required_symbols(&self) -> &'static [&'static str] {
        REQUIRED_SYMBOLS
    }

    fn peripheral_counts(&self, fw: &FirmwareInfo) -> PeripheralCounts {
        // Build GPIO channel names from firmware enum variants (for readable logs).
        let gpio_variants = fw.enum_variants("HAL_GPIO_channel_E");
        let channel_names: Vec<&'static str> = gpio_variants
            .iter()
            .filter(|(name, _)| !name.ends_with("_COUNT"))
            .map(|(name, _)| {
                // Strip "HAL_GPIO_" prefix for cleaner logging, then leak to 'static.
                let short = name.strip_prefix("HAL_GPIO_").unwrap_or(name);
                &*Box::leak(short.to_string().into_boxed_str())
            })
            .collect();
        let channel_names: &'static [&'static str] = Box::leak(channel_names.into_boxed_slice());

        PeripheralCounts {
            gpio: fw.channel_count("HAL_GPIO_channel_E"),
            gpio_names: Some(channel_names),
            serial: fw.channel_count("HAL_serial_channel_E"),
            encoder: fw.channel_count("HAL_encoder_channel_E"),
            pulse_out: fw.channel_count("HAL_pulseOut_channel_E"),
        }
    }

    fn host_serial_channel(&self, fw: &FirmwareInfo) -> usize {
        fw.enum_channel("HAL_SERIAL_CHANNEL_MAIN")
    }

    fn wire(&self, fw: &FirmwareInfo) {
        info!("Wiring machine: MaD tensile tester");

        // ── Resolve channel indices from firmware enums ──

        let pin_servo_ena = fw.enum_channel("HAL_GPIO_SERVO_ENA");
        let pin_servo_dir = fw.enum_channel("HAL_GPIO_SERVO_DIR");
        let pin_servo_rdy = fw.enum_channel("HAL_GPIO_SERVO_RDY");
        let pin_esd_upper = fw.enum_channel("HAL_GPIO_ESD_UPPER");
        let pin_esd_lower = fw.enum_channel("HAL_GPIO_ESD_LOWER");
        let pin_esd_switch = fw.enum_channel("HAL_GPIO_ESD_SWITCH");
        let pin_endstop_upper = fw.enum_channel("HAL_GPIO_ENDSTOP_UPPER");
        let pin_endstop_lower = fw.enum_channel("HAL_GPIO_ENDSTOP_LOWER");
        let pin_endstop_door = fw.enum_channel("HAL_GPIO_ENDSTOP_DOOR");
        let pin_esd_power = fw.enum_channel("HAL_GPIO_ESD_POWER");
        let pin_charge_pump = fw.enum_channel("HAL_GPIO_CHARGE_PUMP");

        let servo_encoder = fw.enum_channel("HAL_ENCODER_CHANNEL_SERVO");
        let servo_pulse_out = fw.enum_channel("HAL_PULSE_OUT_CHANNEL_SERVO");
        let serial_force_gauge = fw.enum_channel("HAL_SERIAL_CHANNEL_FORCE_GAUGE");

        // ── Create model instances with machine-specific configuration ──

        let gantry_model = gantry::Gantry::new(gantry::Config {
            engagement_slack_mm: 15.0,
            tension_on_decreasing_position: false,
            upper_threshold_mm: -10.0,
            lower_threshold_mm: 300.0,
        });

        // Mirrors the default machine profile's intrinsic load-cell model:
        // capacity 100 N, sensitivity -4.868009 mV/V at capacity, zero balance 0.
        // Negative because load cell differential output is inverted for tension.
        let strain_g = strain_gauge::StrainGauge::new(strain_gauge::Config {
            full_scale_force_n: 100.0,
            sensitivity_mv_per_v: -4.868009,
            excitation_v: 3.3,
        });

        // Ratiometric like the firmware config: VREF = AVDD = bridge excitation,
        // PGA gain 128. Firmware recovers signal[nV/V] = counts * 1e9 / (128 * 2^23),
        // so the excitation cancels and force = signal * capacity / sensitivity.
        let (adc, fg_fd) = ads122u04::Ads122u04::new(ads122u04::Config {
            vref_mv: 3300.0,
            gain: 128.0,
            zero_offset: 0,
        });

        let sample = Sample::new(SampleConfig {
            // Fallback if material inputs are invalid.
            stiffness_n_per_mm: 5.0 / (100.0 - 15.0),
            tension_on_decreasing_position: false,
            // Material-based simulation: k = E*A/L0.
            // Chosen to preserve previous force profile target (~5N at 100mm with 15mm slack):
            //   k ~= 5 / (100 - 15) = 0.0588235 N/mm
            //   with A=20 mm² and L0=20 mm -> E ~= k*L0/A ~= 0.0588235 MPa
            material: Some(MaterialProperties {
                name: "SIL-Linear-Reference",
                youngs_modulus_mpa: 5.0 / (100.0 - 15.0),
                area_mm2: 20.0,
                gauge_length_mm: 20.0,
            }),
        });

        // ── Register trace signals ──

        embsim_trace::register(Signal::with_unit("stepper.position_mm", groups::MODEL, "mm"));
        embsim_trace::register(Signal::with_unit("stepper.enabled", groups::MODEL, "bool"));
        embsim_trace::register(Signal::with_unit("stepper.direction_cw", groups::MODEL, "bool"));
        embsim_trace::register(Signal::with_unit("sample.extension_mm", groups::MODEL, "mm"));
        embsim_trace::register(Signal::with_unit("sample.force_n", groups::MODEL, "N"));
        embsim_trace::register(Signal::with_unit("strain_gauge.voltage_mv", groups::MODEL, "mV"));
        embsim_trace::register(Signal::with_unit("encoder.position", groups::PERIPHERAL, "steps"));
        embsim_trace::register(Signal::with_unit("limit_switch.upper", groups::MODEL, "bool"));
        embsim_trace::register(Signal::with_unit("limit_switch.lower", groups::MODEL, "bool"));
        embsim_trace::register(Signal::with_unit("gpio.servo_ena", groups::PERIPHERAL, "bool"));
        embsim_trace::register(Signal::with_unit("gpio.servo_dir", groups::PERIPHERAL, "bool"));

        // ── Wire callbacks ──

        // GPIO traces (motor enable + direction are informational here; the actual
        // direction used to advance the encoder is read from this same GPIO inside
        // the pulse_out::on_start callback, so the two cannot diverge).
        gpio::on_change(pin_servo_ena, |v| {
            embsim_trace::record("gpio.servo_ena", if v { 1.0 } else { 0.0 });
            embsim_trace::record("stepper.enabled", if v { 1.0 } else { 0.0 });
        });
        gpio::on_change(pin_servo_dir, |v| {
            embsim_trace::record("gpio.servo_dir", if v { 1.0 } else { 0.0 });
            embsim_trace::record("stepper.direction_cw", if !v { 1.0 } else { 0.0 });
        });

        // Plant model: the encoder reflects ACTUAL (lagged) carriage motion, not
        // the raw emitted-pulse count. We integrate the *commanded* velocity
        // (pulse frequency × direction) through a first-order inertia lag and
        // accumulate position in floating point. Two payoffs over the old
        // `base + dir×emitted` coupling: (1) no sub-pulse-per-tick truncation at
        // low rates, so the loop settles exactly on target; (2) the encoder lags
        // the command, giving the closed loop real dynamics to tune against.
        struct ServoPlant {
            last_us: u64,
            vel: f64,        // counts/s, actual (lagged) carriage velocity
            pos: f64,        // counts, actual carriage position (the encoder truth)
            last_write: i32, // last encoder value the plant wrote (to detect external sets)
        }
        // Motor + carriage velocity time constant — the headline plant-fidelity
        // knob. Larger = more sluggish = the loop must work harder.
        const SERVO_TAU_S: f64 = 0.020;
        // Viscous load: a fractional speed loss proportional to velocity (sample
        // load / friction). The open-loop pulse rate over-delivers vs the true
        // motion, so the closed loop must push harder to hold rate — this is the
        // "slip under load" the encoder exists to catch. It vanishes at rest, so
        // the carriage still settles cleanly (no stiction deadzone).
        const SERVO_LOAD_LOSS: f64 = 0.15;
        let plant = Arc::new(std::sync::Mutex::new(ServoPlant {
            last_us: 0,
            vel: 0.0,
            pos: 0.0,
            last_write: 0,
        }));
        {
            // Re-anchor dt on every (re)start so the first tick after a stop or a
            // direction-reversal restart doesn't see a huge elapsed interval.
            let plant = Arc::clone(&plant);
            pulse_out::on_start(servo_pulse_out, move |_pulses, _freq| {
                plant.lock().unwrap().last_us = embsim_core::virtual_clock::virtual_us();
            });
        }
        {
            let gantry = gantry_model.clone();
            let plant = Arc::clone(&plant);
            pulse_out::on_progress(servo_pulse_out, move |_emitted| {
                let now = embsim_core::virtual_clock::virtual_us();
                // Firmware convention: SERVO_DIR active=false → CW → increasing count.
                let dir = if gpio::get_active(pin_servo_dir) { -1.0 } else { 1.0 };
                let cmd_vel = dir * pulse_out::frequency(servo_pulse_out) as f64;

                let pos_steps;
                {
                    let mut p = plant.lock().unwrap();
                    // The firmware can hard-set the encoder (homing setPosition,
                    // IO_positionFeedback). Detect that — the encoder no longer
                    // matches what we last wrote — and adopt it, so the plant
                    // doesn't clobber the freshly established coordinate frame.
                    let enc_now = encoder::value(servo_encoder);
                    if enc_now != p.last_write {
                        p.pos = enc_now as f64;
                        p.vel = 0.0;
                    }
                    let dt = now.saturating_sub(p.last_us) as f64 / 1_000_000.0;
                    p.last_us = now;
                    if dt > 0.0 {
                        let alpha = (dt / SERVO_TAU_S).min(1.0); // 1st-order velocity lag
                        p.vel += (cmd_vel - p.vel) * alpha;
                        let eff_vel = p.vel * (1.0 - SERVO_LOAD_LOSS); // viscous load
                        p.pos += eff_vel * dt;
                    }
                    pos_steps = p.pos.round() as i32;
                    p.last_write = pos_steps;
                }

                encoder::set(servo_encoder, pos_steps);
                let pos_mm = pos_steps as f64 / STEPS_PER_MM;
                gantry.on_position(pos_mm);
                embsim_trace::record("stepper.position_mm", pos_mm);
                embsim_trace::record("encoder.position", pos_steps as f64);
            });
        }

        // gantry extension -> sample strain
        {
            let smp = sample.clone();
            gantry_model.on_extension_change(move |extension_mm| {
                smp.on_extension(extension_mm);
                embsim_trace::record("sample.extension_mm", extension_mm);
            });
        }

        // sample force → strain gauge → ADC
        {
            let sg = strain_g.clone();
            sample.on_change(move |force_n| {
                sg.set_force(force_n);
                embsim_trace::record("sample.force_n", force_n);
            });
        }
        {
            let a = adc.clone();
            strain_g.on_change(move |voltage_mv| {
                a.set_voltage(voltage_mv);
                embsim_trace::record("strain_gauge.voltage_mv", voltage_mv);
            });
        }

        // gantry limit state changes → GPIO
        gantry_model.on_upper_change(move |triggered| {
            gpio::set_state(pin_endstop_upper, triggered);
            embsim_trace::record("limit_switch.upper", if triggered { 1.0 } else { 0.0 });
        });
        gantry_model.on_lower_change(move |triggered| {
            gpio::set_state(pin_endstop_lower, triggered);
            embsim_trace::record("limit_switch.lower", if triggered { 1.0 } else { 0.0 });
        });

        // Wire ADS122U04 serial channel
        serial::init_channel_fd(serial_force_gauge, fg_fd);

        // ── Set initial GPIO states (safe machine) ──

        info!("Setting initial GPIO states (safe machine)");

        // ESD safety circuits — all inactive (no fault, machine is safe)
        gpio::set_state(pin_esd_power, false);
        gpio::set_state(pin_esd_upper, false);
        gpio::set_state(pin_esd_lower, false);
        gpio::set_state(pin_esd_switch, false);

        // Endstops — not triggered
        gpio::set_state(pin_endstop_upper, false);
        gpio::set_state(pin_endstop_lower, false);
        gpio::set_state(pin_endstop_door, false);

        // Charge pump — inactive
        gpio::set_state(pin_charge_pump, false);

        // Servo ready — initially not ready
        gpio::set_state(pin_servo_rdy, false);

        // ── Record initial values for all trace signals ──
        // Model/Peripheral signals only record on-change callbacks, so we need
        // an initial sample so charts show data immediately when subscribed.
        embsim_trace::record("stepper.position_mm", 0.0);
        embsim_trace::record("stepper.enabled", 0.0);
        embsim_trace::record("stepper.direction_cw", 0.0);
        embsim_trace::record("sample.extension_mm", 0.0);
        embsim_trace::record("sample.force_n", 0.0);
        embsim_trace::record("strain_gauge.voltage_mv", 0.0);
        embsim_trace::record("encoder.position", 0.0);
        embsim_trace::record("limit_switch.upper", 0.0);
        embsim_trace::record("limit_switch.lower", 0.0);
        embsim_trace::record("gpio.servo_ena", 0.0);
        embsim_trace::record("gpio.servo_dir", 0.0);
    }
}
