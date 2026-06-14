//! Model: Limit Switch — virtual limit switch.
//!
//! Given a position in mm, determines whether limit switches are triggered.
//! Fires callbacks only on state transitions (edge-triggered).
//! Thresholds are configurable via `Config`.
//!
//! Has no knowledge of GPIO or any MCU peripheral.

use crate::edge::EdgeDetector;
use embsim_core::event::Observers;
use std::sync::Arc;

// ============================================================
// Configuration
// ============================================================

/// Limit switch configuration.
#[derive(Debug, Clone)]
pub struct Config {
    /// Upper limit switch threshold in mm (position below this triggers upper).
    pub upper_threshold_mm: f64,
    /// Lower limit switch threshold in mm (position above this triggers lower).
    pub lower_threshold_mm: f64,
}

// ============================================================
// Limit switch instance
// ============================================================

pub struct LimitSwitch {
    config: Config,
    upper: EdgeDetector,
    lower: EdgeDetector,
    on_upper_change: Observers<bool>,
    on_lower_change: Observers<bool>,
}

impl LimitSwitch {
    /// Create a new limit switch model instance.
    pub fn new(config: Config) -> Arc<Self> {
        tracing::info!(
            "limit_switch: init upper={:.1}mm lower={:.1}mm",
            config.upper_threshold_mm, config.lower_threshold_mm
        );
        Arc::new(Self {
            config,
            upper: EdgeDetector::new(false),
            lower: EdgeDetector::new(false),
            on_upper_change: Observers::new(),
            on_lower_change: Observers::new(),
        })
    }

    /// Subscribe to upper limit switch transitions. Multiple subscribers allowed.
    pub fn on_upper_change(&self, cb: impl Fn(bool) + Send + 'static) {
        self.on_upper_change.subscribe(cb);
    }

    /// Subscribe to lower limit switch transitions. Multiple subscribers allowed.
    pub fn on_lower_change(&self, cb: impl Fn(bool) + Send + 'static) {
        self.on_lower_change.subscribe(cb);
    }

    /// Update limit switch states for the given position in mm.
    /// Fires callbacks only on transitions.
    pub fn update(&self, position_mm: f64) {
        if let Some(upper) = self.upper.update(position_mm < self.config.upper_threshold_mm) {
            self.on_upper_change.emit(upper);
        }
        if let Some(lower) = self.lower.update(position_mm > self.config.lower_threshold_mm) {
            self.on_lower_change.emit(lower);
        }
    }
}
