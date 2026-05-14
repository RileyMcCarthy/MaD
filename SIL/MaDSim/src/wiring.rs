//! Machine wiring — connects MaD tensile tester peripherals to models.
//!
//! This module is the ONLY place that knows both peripheral channels and
//! model components. It configures peripheral channel counts, registers
//! callbacks, and routes all peripheral events to/from physical models.
//!
//! All model-specific constants (steps/mm, thresholds, ADC calibration)
//! live here, passed to models via their Config structs at init time.
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
//!   serial ch1 (MAIN)        ───fd──> PTY (set in main.rs)
//! ```

use std::sync::atomic::{AtomicI32, Ordering};
use std::sync::Arc;

use embsim_memory_inspect::FirmwareInfo;
use embsim_peripherals::{encoder, gpio, pulse_out, serial};
use embsim_models::{ads122u04, gantry, strain_gauge};
use embsim_models::sample::{Config as SampleConfig, MaterialProperties, Sample};
use embsim_trace::{self, Signal, SignalGroup};
use tracing::info;

// ============================================================
// Machine-specific constants
// ============================================================

/// Steps per mm (must match firmware: 4 microsteps × 2048 steps/rev)
const STEPS_PER_MM: f64 = (4 * 2048) as f64;

// ============================================================
// Initialization
// ============================================================

/// Wire up all peripheral callbacks and set initial states.
/// Call this once at startup before firmware begins.
///
/// All GPIO channel assignments and peripheral channel indices
/// are resolved from the firmware's DWARF debug info at runtime.
pub fn init(fw: &FirmwareInfo) {
    info!("Wiring machine: MaD tensile tester");

    // ── Resolve all channel indices from firmware enums ──

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
    let gpio_count = fw.channel_count("HAL_GPIO_channel_E");

    let servo_encoder = fw.enum_channel("HAL_ENCODER_CHANNEL_SERVO");
    let servo_pulse_out = fw.enum_channel("HAL_PULSE_OUT_CHANNEL_SERVO");
    let serial_force_gauge = fw.enum_channel("HAL_SERIAL_CHANNEL_FORCE_GAUGE");

    // Build GPIO channel names from firmware enum variants
    let gpio_variants = fw.enum_variants("HAL_GPIO_channel_E");
    let channel_names: Vec<&'static str> = gpio_variants
        .iter()
        .filter(|(name, _)| !name.ends_with("_COUNT"))
        .map(|(name, _)| {
            // Strip "HAL_GPIO_" prefix for cleaner logging, then leak to 'static
            let short = name.strip_prefix("HAL_GPIO_").unwrap_or(name);
            &*Box::leak(short.to_string().into_boxed_str())
        })
        .collect();
    let channel_names: &'static [&'static str] = Box::leak(channel_names.into_boxed_slice());

    // ── Create model instances with machine-specific configuration ──

    let gantry_model = gantry::Gantry::new(gantry::Config {
        engagement_slack_mm: 15.0,
        tension_on_decreasing_position: false,
        upper_threshold_mm: -10.0,
        lower_threshold_mm: 300.0,
    });

    let strain_g = strain_gauge::StrainGauge::new(strain_gauge::Config {
        full_scale_force_n: 50.0,
        // Calibrated to match firmware: forceGaugeNPerStep = -658 ADC counts/N
        //   counts/N = (mV_per_N * gain * 2^23) / Vref
        //   -658 = (FULL_SCALE_MV / 50) * 8388608 / 2048
        //   FULL_SCALE_MV = -658 * 50 * 2048 / 8388608 = -8.0322265625
        // Negative because load cell differential output is inverted for tension.
        sensitivity_mv_per_v: -1.60644531250,
        excitation_v: 5.0,
    });

    let (adc, fg_fd) = ads122u04::Ads122u04::new(ads122u04::Config {
        vref_mv: 2048.0,
        gain: 1.0,
        zero_offset: 16119601,
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

    embsim_trace::register(Signal::with_unit("stepper.position_mm", SignalGroup::Model, "mm"));
    embsim_trace::register(Signal::with_unit("stepper.enabled", SignalGroup::Model, "bool"));
    embsim_trace::register(Signal::with_unit("stepper.direction_cw", SignalGroup::Model, "bool"));
    embsim_trace::register(Signal::with_unit("sample.extension_mm", SignalGroup::Model, "mm"));
    embsim_trace::register(Signal::with_unit("sample.force_n", SignalGroup::Model, "N"));
    embsim_trace::register(Signal::with_unit("strain_gauge.voltage_mv", SignalGroup::Model, "mV"));
    embsim_trace::register(Signal::with_unit("encoder.position", SignalGroup::Peripheral, "steps"));
    embsim_trace::register(Signal::with_unit("limit_switch.upper", SignalGroup::Model, "bool"));
    embsim_trace::register(Signal::with_unit("limit_switch.lower", SignalGroup::Model, "bool"));
    embsim_trace::register(Signal::with_unit("gpio.servo_ena", SignalGroup::Peripheral, "bool"));
    embsim_trace::register(Signal::with_unit("gpio.servo_dir", SignalGroup::Peripheral, "bool"));

    // ── Configure GPIO peripheral ──

    gpio::init(gpio_count, Some(channel_names));

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

    // pulse_out is the single integrator. on_start snapshots the baseline; on_progress
    // applies the running emitted count to the encoder and downstream physics so the
    // encoder always shows exactly what `HAL_pulseOut_run` reports to firmware.
    let enc_base = Arc::new(AtomicI32::new(0));
    let enc_dir = Arc::new(AtomicI32::new(1));
    {
        let enc_base = Arc::clone(&enc_base);
        let enc_dir = Arc::clone(&enc_dir);
        pulse_out::on_start(servo_pulse_out, move |_pulses, _freq| {
            enc_base.store(encoder::value(servo_encoder), Ordering::Relaxed);
            // Firmware convention: SERVO_DIR active=false → CW → increasing step count.
            let dir = if gpio::get_active(pin_servo_dir) { -1 } else { 1 };
            enc_dir.store(dir, Ordering::Relaxed);
        });
    }
    {
        let gantry = gantry_model.clone();
        let enc_base = Arc::clone(&enc_base);
        let enc_dir = Arc::clone(&enc_dir);
        pulse_out::on_progress(servo_pulse_out, move |emitted| {
            let base = enc_base.load(Ordering::Relaxed);
            let dir = enc_dir.load(Ordering::Relaxed);
            let pos_steps = base.wrapping_add(dir.wrapping_mul(emitted as i32));
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
