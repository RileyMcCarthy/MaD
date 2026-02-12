//! Encoder — Generic position counter peripheral.

use std::sync::atomic::{AtomicI32, AtomicUsize, Ordering};
use tracing::trace;

/// Maximum encoder channels supported.
const MAX_CHANNELS: usize = 16;

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
pub fn init(count: usize) {
    assert!(count <= MAX_CHANNELS, "Encoder count {} exceeds max {}", count, MAX_CHANNELS);
    CHANNEL_COUNT.store(count, Ordering::Relaxed);
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
