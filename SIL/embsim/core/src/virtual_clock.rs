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

// ============================================================
// Tests
// ============================================================

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex as StdMutex;

    /// The virtual clock mutates process-global scale / frequency / boot-offset
    /// state, so every test that touches it must run serially. Recover from any
    /// panic-induced poisoning exactly like the `pulse_out` reference suite.
    static TEST_LOCK: StdMutex<()> = StdMutex::new(());

    fn lock_or_recover() -> std::sync::MutexGuard<'static, ()> {
        TEST_LOCK.lock().unwrap_or_else(|p| {
            TEST_LOCK.clear_poison();
            p.into_inner()
        })
    }

    /// `set_scale` then `virtual_to_wall_us` is a deterministic pure mapping:
    /// at 1.0× a virtual wait equals the wall wait; at 2.0× it halves; at 0.5×
    /// it doubles. No real time elapses, so the exact arithmetic is asserted.
    #[test]
    fn virtual_to_wall_is_deterministic_pure_mapping() {
        let _g = lock_or_recover();
        set_scale(1.0);
        assert_eq!(virtual_to_wall_us(1000), 1000, "1.0x: wall == virtual");
        set_scale(2.0);
        assert_eq!(virtual_to_wall_us(1000), 500, "2.0x: wall == virtual/2");
        set_scale(0.5);
        assert_eq!(virtual_to_wall_us(1000), 2000, "0.5x: wall == virtual*2");
    }

    /// A scale of 0.0 truncates the numerator to 0; `virtual_to_wall_us` must
    /// clamp the divisor via `numer.max(1)` so it never divides by zero. The
    /// result is therefore `wait * denom` (denom == 1000 internally).
    #[test]
    fn scale_zero_is_clamped_no_divide_by_zero() {
        let _g = lock_or_recover();
        set_scale(0.0);
        // numer == 0 → clamped to 1 → wait * denom(1000) / 1.
        assert_eq!(virtual_to_wall_us(1), 1000);
        assert_eq!(virtual_to_wall_us(7), 7000);
        // Restore a sane scale for any sibling that races on re-init.
        set_scale(1.0);
    }

    /// `virtual_to_wall_us(0)` is always 0 regardless of scale (no wait → no
    /// sleep), at normal, fast, slow, and clamped-zero scales.
    #[test]
    fn zero_wait_maps_to_zero_at_every_scale() {
        let _g = lock_or_recover();
        for s in [1.0, 2.0, 0.5, 0.0, 10.0] {
            set_scale(s);
            assert_eq!(virtual_to_wall_us(0), 0, "zero wait at scale {s}");
        }
        set_scale(1.0);
    }

    /// `init` stores the supplied clock frequency and `clock_freq` returns it.
    #[test]
    fn init_sets_clock_freq() {
        let _g = lock_or_recover();
        init(1.0, 180_000_000);
        assert_eq!(clock_freq(), 180_000_000);
        init(1.0, 320_000_000);
        assert_eq!(clock_freq(), 320_000_000);
    }

    /// `init` also applies the speed scale it is given (the scale feeds straight
    /// into the deterministic `virtual_to_wall_us` mapping).
    #[test]
    fn init_applies_speed_scale() {
        let _g = lock_or_recover();
        init(2.0, 1_000_000);
        assert_eq!(virtual_to_wall_us(1000), 500, "init(2.0) halves wall wait");
        init(0.5, 1_000_000);
        assert_eq!(virtual_to_wall_us(1000), 2000, "init(0.5) doubles wall wait");
        init(1.0, 1_000_000);
    }

    /// `virtual_us` is monotonic non-decreasing across repeated reads — virtual
    /// time never runs backwards (timing magnitude is machine-dependent and not
    /// asserted, only ordering).
    #[test]
    fn virtual_us_is_monotonic() {
        let _g = lock_or_recover();
        init(1.0, 180_000_000);
        let mut last = virtual_us();
        for _ in 0..1000 {
            let now = virtual_us();
            assert!(now >= last, "virtual_us went backwards: {now} < {last}");
            last = now;
        }
    }

    /// `virtual_ms` is monotonic and is exactly `virtual_us / 1000` ordering —
    /// ms can never exceed the µs reading divided by 1000.
    #[test]
    fn virtual_ms_tracks_virtual_us() {
        let _g = lock_or_recover();
        init(1.0, 180_000_000);
        let mut last_ms = virtual_ms();
        for _ in 0..1000 {
            let us = virtual_us();
            let ms = virtual_ms();
            assert!(ms >= last_ms, "virtual_ms went backwards");
            // ms reading taken after us can only have advanced, so ms*1000 may
            // exceed the earlier us; but ms must never exceed us/1000 + slack.
            assert!(ms <= virtual_us() / 1000, "ms must not lead the us clock");
            last_ms = ms;
            let _ = us;
        }
    }

    /// `virtual_cycles` is 0 whenever the configured frequency is 0 (the
    /// uninitialized-frequency default), no matter how much virtual time has
    /// elapsed.
    #[test]
    fn virtual_cycles_zero_when_freq_zero() {
        let _g = lock_or_recover();
        // Re-anchor with an explicit zero frequency.
        init(1.0, 0);
        assert_eq!(clock_freq(), 0);
        assert_eq!(virtual_cycles(), 0, "no freq → no cycles");
        // Even after advancing virtual time it stays zero.
        for _ in 0..500 {
            let _ = virtual_us();
        }
        assert_eq!(virtual_cycles(), 0);
    }

    /// With a non-zero frequency and advancing virtual time, `virtual_cycles`
    /// is monotonic non-decreasing and eventually grows above zero. The exact
    /// cycle count is wall-clock dependent and is deliberately NOT asserted.
    #[test]
    fn virtual_cycles_grow_with_time_when_freq_nonzero() {
        let _g = lock_or_recover();
        init(1.0, 180_000_000);
        let mut last = virtual_cycles();
        let mut grew = false;
        for _ in 0..200_000 {
            let now = virtual_cycles();
            assert!(now >= last, "cycles went backwards");
            if now > 0 {
                grew = true;
            }
            last = now;
            if grew {
                break;
            }
        }
        assert!(grew, "cycles should rise above zero as virtual time advances");
    }

    /// Re-`init` re-anchors the boot offset, so virtual time restarts near zero.
    /// We can't assert an exact value (wall time keeps moving), but immediately
    /// after a re-init the reading must be small relative to a coarse ceiling.
    #[test]
    fn reinit_reanchors_virtual_time() {
        let _g = lock_or_recover();
        init(1.0, 180_000_000);
        // Burn some virtual time.
        for _ in 0..50_000 {
            let _ = virtual_us();
        }
        let before = virtual_us();
        // Re-init should drop the reading back toward zero.
        init(1.0, 180_000_000);
        let after = virtual_us();
        // The re-anchored reading must be far below the accumulated `before`
        // (or `before` itself was tiny on a very fast machine — either way the
        // post-init value cannot exceed a generous 1-second ceiling).
        assert!(
            after < 1_000_000,
            "re-anchored virtual_us should be small, got {after}"
        );
        let _ = before;
    }
}
