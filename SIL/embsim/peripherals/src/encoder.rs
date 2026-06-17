//! Encoder — Generic position counter peripheral.

use std::sync::atomic::{AtomicI32, AtomicUsize, Ordering};
use tracing::trace;

/// Maximum encoder channels supported (hard ceiling of the backing array).
pub const MAX_CHANNELS: usize = 16;

/// Configured channel count.
static CHANNEL_COUNT: AtomicUsize = AtomicUsize::new(0);

/// Encoder values (atomic for thread safety).
static ENCODER_VALUES: [AtomicI32; MAX_CHANNELS] = {
    const INIT: AtomicI32 = AtomicI32::new(0);
    [INIT; MAX_CHANNELS]
};

// ============================================================
// Initialization
// ============================================================

/// Configure the encoder peripheral with the number of channels.
/// Resets all counters, so re-init yields a clean state.
pub fn init(count: usize) {
    assert!(count <= MAX_CHANNELS, "Encoder count {} exceeds max {}", count, MAX_CHANNELS);
    reset();
    CHANNEL_COUNT.store(count, Ordering::Relaxed);
}

/// Clear all encoder values and channel count (used by `init` and teardown).
pub fn reset() {
    CHANNEL_COUNT.store(0, Ordering::Relaxed);
    for v in ENCODER_VALUES.iter() {
        v.store(0, Ordering::Relaxed);
    }
}

// ============================================================
// Core API
// ============================================================

/// Start an encoder channel (no-op in emulation).
pub fn start(channel: usize) {
    trace!("encoder::start(channel={})", channel);
}

/// Get the current encoder value.
pub fn value(channel: usize) -> i32 {
    if channel < CHANNEL_COUNT.load(Ordering::Relaxed) {
        ENCODER_VALUES[channel].load(Ordering::Relaxed)
    } else {
        0
    }
}

/// Set the encoder value (used by MCU HAL or wiring layer).
pub fn set(channel: usize, val: i32) {
    if channel < CHANNEL_COUNT.load(Ordering::Relaxed) {
        ENCODER_VALUES[channel].store(val, Ordering::Relaxed);
        trace!("encoder::set(channel={}, value={})", channel, val);
    }
}

// ============================================================
// Wiring API
// ============================================================

/// Set encoder value from external source.
pub fn set_value(channel: usize, val: i32) {
    set(channel, val);
}

// ============================================================
// Tests
// ============================================================

#[cfg(test)]
mod tests {
    use super::*;

    /// Take the crate test lock, pin the clock, and reset the encoder bank.
    fn setup(count: usize) {
        crate::test_support::ensure_clock();
        init(count);
    }

    #[test]
    fn init_at_max_channels_is_allowed() {
        let _g = crate::test_support::guard();
        // Exactly MAX_CHANNELS is the inclusive upper bound.
        setup(MAX_CHANNELS);
        assert_eq!(value(MAX_CHANNELS - 1), 0);
    }

    #[test]
    #[should_panic(expected = "exceeds max")]
    fn init_above_max_channels_panics() {
        let _g = crate::test_support::guard();
        crate::test_support::ensure_clock();
        init(MAX_CHANNELS + 1);
    }

    #[test]
    fn value_and_set_in_range() {
        let _g = crate::test_support::guard();
        setup(4);
        assert_eq!(value(2), 0, "encoders start at zero");
        set(2, -1234);
        assert_eq!(value(2), -1234);
        set(2, i32::MAX);
        assert_eq!(value(2), i32::MAX);
    }

    #[test]
    fn out_of_range_value_is_zero_and_set_is_a_no_op() {
        let _g = crate::test_support::guard();
        setup(2);
        // Channel 9 is unconfigured: read returns 0, write is dropped.
        assert_eq!(value(9), 0);
        set(9, 5000);
        assert_eq!(value(9), 0);
        // In-range channels remain untouched.
        assert_eq!(value(0), 0);
    }

    #[test]
    fn set_value_is_an_alias_for_set() {
        let _g = crate::test_support::guard();
        setup(2);
        set_value(1, 777);
        assert_eq!(value(1), 777);
        // Out-of-range alias is likewise a no-op.
        set_value(50, 1);
        assert_eq!(value(50), 0);
    }

    #[test]
    fn reset_zeroes_all_values_and_count() {
        let _g = crate::test_support::guard();
        setup(3);
        set(0, 10);
        set(1, 20);
        set(2, 30);
        reset();
        // Count is cleared, so every read is out-of-range → 0.
        assert_eq!(value(0), 0);
        assert_eq!(value(1), 0);
        assert_eq!(value(2), 0);
        // Re-init exposes the (already-zeroed) storage.
        init(3);
        assert_eq!(value(0), 0);
        assert_eq!(value(2), 0);
    }

    #[test]
    fn start_is_a_no_op() {
        let _g = crate::test_support::guard();
        setup(1);
        // start() is a documented no-op in emulation; it must not panic or
        // change the value.
        set(0, 99);
        start(0);
        assert_eq!(value(0), 99);
    }
}
