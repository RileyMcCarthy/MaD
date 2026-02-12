//! Virtual Clock — provides scalable time for the emulator.
//!
//! All timer functions route through this module.
//! At 1x: virtual time == wall time
//! At 5x: virtual time advances 5x faster (waits are 5x shorter)
//! At 0.5x: virtual time advances 0.5x (waits are 2x longer)

use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::time::Instant;

/// Global virtual clock state.
static SCALE_NUMER: AtomicU64 = AtomicU64::new(1);
static SCALE_DENOM: AtomicU64 = AtomicU64::new(1);

/// Boot instant (set once at init).
static BOOT_INSTANT: std::sync::OnceLock<Instant> = std::sync::OnceLock::new();

/// Simulated clock frequency (configurable per MCU).
static CLOCK_FREQ: AtomicU32 = AtomicU32::new(180_000_000);

/// Initialize the virtual clock with the given speed scale and clock frequency.
/// Must be called once before any time functions.
pub fn init(speed: f64, freq: u32) {
    BOOT_INSTANT.get_or_init(Instant::now);
    CLOCK_FREQ.store(freq, Ordering::Relaxed);
    set_scale(speed);
}

/// Change the time scale at runtime.
/// Uses integer numerator/denominator to avoid floating point in the hot path.
pub fn set_scale(scale: f64) {
    let precision = 1000u64;
    let numer = (scale * precision as f64) as u64;
    let denom = precision;
    SCALE_NUMER.store(numer, Ordering::Relaxed);
    SCALE_DENOM.store(denom, Ordering::Relaxed);
}

/// Get virtual microseconds elapsed since boot.
pub fn virtual_us() -> u64 {
    let boot = BOOT_INSTANT.get().expect("Virtual clock not initialized");
    let wall_us = boot.elapsed().as_micros() as u64;
    let numer = SCALE_NUMER.load(Ordering::Relaxed);
    let denom = SCALE_DENOM.load(Ordering::Relaxed);
    wall_us * numer / denom
}

/// Get virtual milliseconds elapsed since boot.
pub fn virtual_ms() -> u64 {
    virtual_us() / 1000
}

/// Convert a virtual wait duration to a wall-clock sleep duration.
/// If speed is 5x, a 1000us virtual wait becomes a 200us real sleep.
pub fn virtual_to_wall_us(virtual_wait_us: u64) -> u64 {
    let numer = SCALE_NUMER.load(Ordering::Relaxed);
    let denom = SCALE_DENOM.load(Ordering::Relaxed);
    virtual_wait_us * denom / numer.max(1)
}

/// Get the simulated clock frequency.
pub fn clock_freq() -> u32 {
    CLOCK_FREQ.load(Ordering::Relaxed)
}

/// Get virtual cycle count (virtual_us * cycles_per_us).
pub fn virtual_cycles() -> u64 {
    let us = virtual_us();
    us * (CLOCK_FREQ.load(Ordering::Relaxed) as u64 / 1_000_000)
}
