//! Model: Strain Gauge — converts force (Newtons) to voltage (mV).
//!
//! Simulates a strain gauge load cell. Receives force updates via
//! `set_force()` callback, converts to a voltage, and fires `on_change`
//! so downstream models (e.g., ADC) can read the voltage.
//!
//! # Provenance (physics model — no datasheet)
//!
//! Governing equation: the standard ratiometric Wheatstone-bridge transfer
//! function for a load cell,
//!
//! ```text
//! V_out[mV] = (F / F_fullscale) · S[mV/V] · V_excitation[V]
//! ```
//!
//! i.e. the differential output is the rated sensitivity (mV per volt of
//! excitation) scaled linearly with applied force. Linear-to-full-scale is
//! the cell's own spec model; creep, temperature drift, and off-axis loading
//! are not modeled.
//!
//! Parameter sources (MaD bench rig): Wishiot 10 kg miniature parallel-beam
//! load cell (Amazon B0C3QJ8J59) — rated output 1.0 mV/V nominal, ±0.15 mV/V
//! tolerance per the product listing (no formal datasheet exists; the
//! per-cell span calibration in the machine profile supersedes the nominal).
//! The default wiring parameters mirror the machine profile's intrinsic
//! load-cell constants — see `docs/dev/sil-board-simulation-design.md` and
//! `MaDSim/src/wiring.rs`.
//!
//! All sensitivity parameters are configurable via `Config`.
//! Has no knowledge of MCU peripherals.

use embsim_core::event::Observers;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::Arc;
use tracing::{info, trace};

// ============================================================
// Configuration
// ============================================================

/// Strain gauge configuration.
#[derive(Debug, Clone)]
pub struct Config {
    /// Full-scale force in Newtons.
    pub full_scale_force_n: f64,
    /// Sensitivity in mV/V at full scale.
    pub sensitivity_mv_per_v: f64,
    /// Excitation voltage in volts.
    pub excitation_v: f64,
}

impl Config {
    /// Full-scale output voltage in mV.
    fn full_scale_mv(&self) -> f64 {
        self.sensitivity_mv_per_v * self.excitation_v
    }
}

// ============================================================
// Strain gauge instance
// ============================================================

pub struct StrainGauge {
    config: Config,
    /// Force in micro-Newtons (i64 for atomicity, divide by 1e6 for N).
    force_un: AtomicI64,
    /// Voltage change observers — fired when force (and thus voltage) changes.
    on_change: Observers<f64>,
}

impl StrainGauge {
    /// Create a new strain gauge model instance.
    pub fn new(config: Config) -> Arc<Self> {
        info!(
            "strain_gauge: init full_scale={:.1}N sensitivity={:.6}mV/V excitation={:.1}V → full_scale_mv={:.4}",
            config.full_scale_force_n, config.sensitivity_mv_per_v, config.excitation_v, config.full_scale_mv()
        );
        Arc::new(Self {
            config,
            force_un: AtomicI64::new(0),
            on_change: Observers::new(),
        })
    }

    /// Subscribe to output-voltage updates (millivolts). Multiple subscribers allowed.
    pub fn on_change(&self, cb: impl Fn(f64) + Send + 'static) {
        self.on_change.subscribe(cb);
    }

    /// Set the current force in Newtons. Converts to voltage and fires on_change.
    pub fn set_force(&self, force_n: f64) {
        let force_un = (force_n * 1_000_000.0) as i64;
        self.force_un.store(force_un, Ordering::Relaxed);

        let voltage_mv = self.force_to_voltage(force_n);
        trace!("strain_gauge: force={:.3}N voltage={:.4}mV", force_n, voltage_mv);

        self.on_change.emit(voltage_mv);
    }

    /// Convert force in Newtons to output voltage in millivolts.
    fn force_to_voltage(&self, force_n: f64) -> f64 {
        (force_n / self.config.full_scale_force_n) * self.config.full_scale_mv()
    }
}
