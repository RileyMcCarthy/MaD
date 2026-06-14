//! Model: Gantry mechanics — converts carriage position to extension and limits.
//!
//! This model represents machine-level mechanics between commanded carriage
//! position and sample extension. It is responsible for:
//! - engagement/slack before the sample is strained
//! - converting absolute gantry position to sample extension
//! - limit switch threshold evaluation
//!
//! Has no knowledge of MCU peripherals.

use embsim_core::event::Observers;
use embsim_models::edge::EdgeDetector;
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
    upper: EdgeDetector,
    lower: EdgeDetector,
    on_extension_change: Observers<f64>,
    on_upper_change: Observers<bool>,
    on_lower_change: Observers<bool>,
}

impl Gantry {
    pub fn new(config: Config) -> Arc<Self> {
        Arc::new(Self {
            config,
            baseline_position_mm: Mutex::new(None),
            upper: EdgeDetector::new(false),
            lower: EdgeDetector::new(false),
            on_extension_change: Observers::new(),
            on_upper_change: Observers::new(),
            on_lower_change: Observers::new(),
        })
    }

    /// Subscribe to sample-extension updates (mm). Multiple subscribers allowed.
    pub fn on_extension_change(&self, cb: impl Fn(f64) + Send + 'static) {
        self.on_extension_change.subscribe(cb);
    }

    /// Subscribe to upper-limit transitions. Multiple subscribers allowed.
    pub fn on_upper_change(&self, cb: impl Fn(bool) + Send + 'static) {
        self.on_upper_change.subscribe(cb);
    }

    /// Subscribe to lower-limit transitions. Multiple subscribers allowed.
    pub fn on_lower_change(&self, cb: impl Fn(bool) + Send + 'static) {
        self.on_lower_change.subscribe(cb);
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

        self.on_extension_change.emit(extension_mm);

        if let Some(upper) = self.upper.update(position_mm < self.config.upper_threshold_mm) {
            self.on_upper_change.emit(upper);
        }
        if let Some(lower) = self.lower.update(position_mm > self.config.lower_threshold_mm) {
            self.on_lower_change.emit(lower);
        }
    }
}

