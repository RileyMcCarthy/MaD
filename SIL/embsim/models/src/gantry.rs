//! Model: Gantry mechanics — converts carriage position to extension and limits.
//!
//! This model represents machine-level mechanics between commanded carriage
//! position and sample extension. It is responsible for:
//! - engagement/slack before the sample is strained
//! - converting absolute gantry position to sample extension
//! - limit switch threshold evaluation
//!
//! Has no knowledge of MCU peripherals.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

/// Gantry mechanics configuration.
#[derive(Debug, Clone)]
pub struct Config {
    /// Initial travel in mm before the sample starts straining.
    pub engagement_slack_mm: f64,
    /// If true, tensile travel is toward decreasing machine position.
    pub tension_on_decreasing_position: bool,
    /// Upper limit switch threshold in mm (position below this triggers upper).
    pub upper_threshold_mm: f64,
    /// Lower limit switch threshold in mm (position above this triggers lower).
    pub lower_threshold_mm: f64,
}

pub struct Gantry {
    config: Config,
    baseline_position_mm: Mutex<Option<f64>>,
    upper_triggered: AtomicBool,
    lower_triggered: AtomicBool,
    on_extension_change: Mutex<Option<Box<dyn Fn(f64) + Send>>>,
    on_upper_change: Mutex<Option<Box<dyn Fn(bool) + Send>>>,
    on_lower_change: Mutex<Option<Box<dyn Fn(bool) + Send>>>,
}

impl Gantry {
    pub fn new(config: Config) -> Arc<Self> {
        Arc::new(Self {
            config,
            baseline_position_mm: Mutex::new(None),
            upper_triggered: AtomicBool::new(false),
            lower_triggered: AtomicBool::new(false),
            on_extension_change: Mutex::new(None),
            on_upper_change: Mutex::new(None),
            on_lower_change: Mutex::new(None),
        })
    }

    pub fn on_extension_change(&self, cb: impl Fn(f64) + Send + 'static) {
        *self.on_extension_change.lock().unwrap() = Some(Box::new(cb));
    }

    pub fn on_upper_change(&self, cb: impl Fn(bool) + Send + 'static) {
        *self.on_upper_change.lock().unwrap() = Some(Box::new(cb));
    }

    pub fn on_lower_change(&self, cb: impl Fn(bool) + Send + 'static) {
        *self.on_lower_change.lock().unwrap() = Some(Box::new(cb));
    }

    /// Update gantry mechanics from absolute machine position in mm.
    pub fn on_position(&self, position_mm: f64) {
        let baseline = {
            let mut guard = self.baseline_position_mm.lock().unwrap();
            match *guard {
                Some(v) => v,
                None => {
                    *guard = Some(position_mm);
                    position_mm
                }
            }
        };

        let tensile_travel_mm = if self.config.tension_on_decreasing_position {
            baseline - position_mm
        } else {
            position_mm - baseline
        };
        let extension_mm = (tensile_travel_mm - self.config.engagement_slack_mm).max(0.0);

        if let Some(cb) = self.on_extension_change.lock().unwrap().as_ref() {
            cb(extension_mm);
        }

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

