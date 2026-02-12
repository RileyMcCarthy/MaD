//! Model: Limit Switch — virtual limit switch.
//!
//! Given a position in mm, determines whether limit switches are triggered.
//! Fires callbacks only on state transitions (edge-triggered).
//! Thresholds are configurable via `Config`.
//!
//! Has no knowledge of GPIO or any MCU peripheral.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

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
    upper_triggered: AtomicBool,
    lower_triggered: AtomicBool,
    on_upper_change: Mutex<Option<Box<dyn Fn(bool) + Send>>>,
    on_lower_change: Mutex<Option<Box<dyn Fn(bool) + Send>>>,
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
            upper_triggered: AtomicBool::new(false),
            lower_triggered: AtomicBool::new(false),
            on_upper_change: Mutex::new(None),
            on_lower_change: Mutex::new(None),
        })
    }

    /// Register callback for upper limit switch state changes.
    pub fn on_upper_change(&self, cb: impl Fn(bool) + Send + 'static) {
        *self.on_upper_change.lock().unwrap() = Some(Box::new(cb));
    }

    /// Register callback for lower limit switch state changes.
    pub fn on_lower_change(&self, cb: impl Fn(bool) + Send + 'static) {
        *self.on_lower_change.lock().unwrap() = Some(Box::new(cb));
    }

    /// Update limit switch states for the given position in mm.
    /// Fires callbacks only on transitions.
    pub fn update(&self, position_mm: f64) {
        let upper = position_mm < self.config.upper_threshold_mm;
        let prev_upper = self.upper_triggered.swap(upper, Ordering::Relaxed);
        if upper != prev_upper {
            if let Some(cb) = self.on_upper_change.lock().unwrap().as_ref() {
                cb(upper);
            }
        }

        let lower = position_mm > self.config.lower_threshold_mm;
        let prev_lower = self.lower_triggered.swap(lower, Ordering::Relaxed);
        if lower != prev_lower {
            if let Some(cb) = self.on_lower_change.lock().unwrap().as_ref() {
                cb(lower);
            }
        }
    }
}
