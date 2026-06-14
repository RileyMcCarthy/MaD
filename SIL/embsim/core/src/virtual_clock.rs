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

/// Immovable process time origin (set once, the first time `init` runs).
static PROCESS_ORIGIN: std::sync::OnceLock<Instant> = std::sync::OnceLock::new();

/// Real microseconds (from `PROCESS_ORIGIN`) at which the virtual clock was
/// last (re)anchored. Re-anchored on every `init`, so re-initializing the
/// emulator in-process restarts virtual time at 0 without the lock-free hot
/// path ever taking a mutex.
static BOOT_OFFSET_US: AtomicU64 = AtomicU64::new(0);

/// Simulated clock frequency in Hz, supplied per-MCU by `init`.
///
/// Defaults to `0` (uninitialized) rather than any specific part's frequency,
/// so a project that forgets to call `init` gets an obviously-wrong `0` from
/// cycle math instead of silently inheriting another MCU's clock. Platform
/// crates (e.g. `embsim-p2`) own their real frequency.
static CLOCK_FREQ: AtomicU32 = AtomicU32::new(0);

/// Initialize the virtual clock with the given speed scale and clock frequency.
/// Must be called before any time functions. Calling it again re-anchors
/// virtual time to 0 (an in-process restart) and updates the scale/frequency.
pub fn init(speed: f64, freq: u32) {
    let origin = PROCESS_ORIGIN.get_or_init(Instant::now);
    BOOT_OFFSET_US.store(origin.elapsed().as_micros() as u64, Ordering::Relaxed);
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

/// Get virtual microseconds elapsed since the last `init`.
pub fn virtual_us() -> u64 {
    let origin = PROCESS_ORIGIN.get().expect("Virtual clock not initialized");
    let wall_us = (origin.elapsed().as_micros() as u64)
        .saturating_sub(BOOT_OFFSET_US.load(Ordering::Relaxed));
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

/// Get virtual cycle count (`virtual_us * clock_freq / 1_000_000`).
///
/// Computed in `u128` and divided last so frequencies that are not a whole
/// number of MHz keep full precision (the old `freq / 1_000_000` pre-divide
/// silently truncated sub-MHz and fractional-MHz parts).
pub fn virtual_cycles() -> u64 {
    let us = virtual_us() as u128;
    let freq = CLOCK_FREQ.load(Ordering::Relaxed) as u128;
    (us * freq / 1_000_000) as u64
}
