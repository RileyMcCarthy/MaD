//! Model: Sample — material model converting position to force.
//!
//! Simulates a test sample's mechanical response. Receives servo position
//! updates in mm via `on_position()` callback, calculates force in Newtons,
//! and fires `on_change` so downstream models (strain gauge) get updated.
//!
//! Has no knowledge of MCU peripherals or drivers.

use std::sync::{Arc, Mutex};
use tracing::trace;

// ============================================================
// Sample instance
// ============================================================

pub struct Sample {
    on_change: Mutex<Option<Box<dyn Fn(f64) + Send>>>,
}

impl Sample {
    /// Create a new sample model instance.
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            on_change: Mutex::new(None),
        })
    }

    /// Register a callback fired when force changes.
    /// The callback receives force in Newtons.
    pub fn on_change(&self, cb: impl Fn(f64) + Send + 'static) {
        *self.on_change.lock().unwrap() = Some(Box::new(cb));
    }

    /// Called when the stepper position changes. Calculates force and fires on_change.
    /// This is the input callback wired from the stepper model.
    /// Position is in mm.
    pub fn on_position(&self, position_mm: f64) {
        let force_n = calculate_force(position_mm);
        trace!("sample: pos={:.3}mm → force={:.3}N", position_mm, force_n);

        if let Some(cb) = self.on_change.lock().unwrap().as_ref() {
            cb(force_n);
        }
    }
}

// ============================================================
// Internal
// ============================================================

/// Calculate force in Newtons from servo position in mm.
/// Simple linear model: force = position_mm
/// Only produces positive force when position > 0 (sample in tension).
fn calculate_force(position_mm: f64) -> f64 {
    position_mm
}
