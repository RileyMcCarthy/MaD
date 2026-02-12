//! Model: Stepper — time-domain stepper motor model.
//!
//! Accepts pulse commands via `start_motion()` (called from pulse_out callback).
//! Runs its own thread at a fixed 10ms period. Each tick, the thread calculates
//! how many steps occurred in that period (`steps = frequency * 0.01`) and
//! applies them as a single batch. A new `start_motion()` call immediately
//! replaces the active command — no explicit preemption logic needed.
//!
//! Outputs position in mm via the `on_change` callback, using a configurable
//! steps-per-mm ratio. Internally tracks position in steps for accuracy.
//!
//! Has no knowledge of GPIO, encoders, or any MCU peripheral.

use std::sync::atomic::{AtomicBool, AtomicI64, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use tracing::{debug, info, trace};

/// Thread update period in virtual microseconds (10ms).
const TICK_PERIOD_US: u64 = 10_000;

// ============================================================
// Configuration
// ============================================================

/// Stepper model configuration.
#[derive(Debug, Clone)]
pub struct Config {
    /// Steps per millimeter (e.g., 4 * 2048 = 8192 for 4-microstep, 2048-step encoder).
    pub steps_per_mm: f64,
}

// ============================================================
// Stepper instance
// ============================================================

pub struct Stepper {
    config: Config,
    /// Current absolute position in steps (CW positive, CCW negative).
    position: AtomicI64,
    /// Whether the stepper driver is enabled (informational only).
    enabled: AtomicBool,
    /// Current direction: true = CW (positive), false = CCW (negative).
    direction_cw: AtomicBool,
    /// Active motion: remaining pulses. 0 = idle.
    remaining: AtomicU32,
    /// Active motion: commanded frequency in Hz (steps/sec).
    frequency: AtomicU32,
    /// Fractional step accumulator (fixed-point, scaled by 1000).
    frac_accum: AtomicU32,
    /// Whether the stepper thread has been started.
    thread_started: AtomicBool,
    /// Position change callback — fired each tick with position in mm.
    on_change: Mutex<Option<Box<dyn Fn(f64) + Send>>>,
}

impl Stepper {
    /// Create a new stepper model instance.
    pub fn new(config: Config) -> Arc<Self> {
        info!("stepper: init steps_per_mm={}", config.steps_per_mm);
        Arc::new(Self {
            config,
            position: AtomicI64::new(0),
            enabled: AtomicBool::new(false),
            direction_cw: AtomicBool::new(true),
            remaining: AtomicU32::new(0),
            frequency: AtomicU32::new(0),
            frac_accum: AtomicU32::new(0),
            thread_started: AtomicBool::new(false),
            on_change: Mutex::new(None),
        })
    }

    /// Register a callback fired each tick when position changes.
    /// The callback receives position in mm.
    pub fn on_change(&self, cb: impl Fn(f64) + Send + 'static) {
        *self.on_change.lock().unwrap() = Some(Box::new(cb));
    }

    /// Enable or disable the stepper.
    pub fn set_enabled(&self, enabled: bool) {
        self.enabled.store(enabled, Ordering::Relaxed);
        debug!("stepper: enabled={}", enabled);
    }

    /// Set the motor direction.
    /// `active` matches firmware convention: false = CW, true = CCW.
    pub fn set_direction(&self, active: bool) {
        self.direction_cw.store(!active, Ordering::Relaxed);
        trace!("stepper: direction={}", if !active { "CW" } else { "CCW" });
    }

    /// Start a new motion command, replacing any active motion.
    /// Called from pulse_out on_start callback.
    pub fn start_motion(self: &Arc<Self>, pulses: u32, frequency: u32) {
        if pulses == 0 {
            return;
        }

        // Ensure the stepper thread is running
        if !self.thread_started.swap(true, Ordering::Relaxed) {
            let stepper = Arc::clone(self);
            std::thread::Builder::new()
                .name("stepper".into())
                .spawn(move || stepper_thread(&stepper))
                .expect("Failed to start stepper thread");
        }

        let freq = frequency.max(1);

        // Replace active motion — reset accumulator, set new command
        self.frac_accum.store(0, Ordering::Relaxed);
        self.frequency.store(freq, Ordering::Relaxed);
        self.remaining.store(pulses, Ordering::Release);

        trace!("stepper: motion started pulses={} freq={}", pulses, freq);
    }

}

// ============================================================
// Stepper thread — fixed 10ms tick
// ============================================================

/// Main stepper thread. Runs at a fixed 10ms period. Each tick,
/// calculates how many steps to apply and fires on_change once.
fn stepper_thread(stepper: &Stepper) {
    info!("Stepper thread started (period={}us)", TICK_PERIOD_US);
    let steps_per_mm = stepper.config.steps_per_mm;

    loop {
        // Sleep for one tick period (virtual time → wall time)
        let wall_us = embsim_core::virtual_clock::virtual_to_wall_us(TICK_PERIOD_US);
        if wall_us > 0 {
            std::thread::sleep(std::time::Duration::from_micros(wall_us));
        }

        let remaining = stepper.remaining.load(Ordering::Acquire);
        if remaining == 0 {
            continue;
        }

        let freq = stepper.frequency.load(Ordering::Relaxed);
        let cw = stepper.direction_cw.load(Ordering::Relaxed);
        let step_dir: i64 = if cw { 1 } else { -1 };

        // Calculate steps this tick: steps = freq * tick_period
        // Use fixed-point (×1000) to accumulate fractional steps.
        // steps_x1000 = freq * tick_period_us * 1000 / 1_000_000
        //             = freq * tick_period_us / 1000
        let steps_x1000 = (freq as u64 * TICK_PERIOD_US) / 1000;
        let accum = stepper.frac_accum.load(Ordering::Relaxed) as u64 + steps_x1000;
        let steps = (accum / 1000) as u32;
        let new_accum = (accum % 1000) as u32;
        stepper.frac_accum.store(new_accum, Ordering::Relaxed);

        // Clamp to remaining
        let steps = steps.min(remaining);
        if steps == 0 {
            continue;
        }

        stepper.remaining.store(remaining - steps, Ordering::Release);

        // Apply position change
        let delta = step_dir * steps as i64;
        let new_pos = stepper.position.fetch_add(delta, Ordering::Relaxed) + delta;
        let pos_mm = new_pos as f64 / steps_per_mm;

        trace!(
            "stepper: tick steps={} pos={} ({:.3}mm) remaining={}",
            steps, new_pos, pos_mm, remaining - steps
        );

        // Fire position change callback with position in mm
        if let Some(cb) = stepper.on_change.lock().unwrap().as_ref() {
            cb(pos_mm);
        }
    }
}
