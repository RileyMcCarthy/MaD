//! GPIO — Generic channel bank with per-channel atomic state and change callbacks.

use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Mutex;
use tracing::trace;

/// Maximum GPIO channels supported (hard ceiling of the backing array).
pub const MAX_CHANNELS: usize = 64;

/// Configured channel count (set at init, default 0).
static CHANNEL_COUNT: AtomicUsize = AtomicUsize::new(0);

/// Channel state storage (one atomic bool per channel, thread-safe).
static GPIO_STATE: [AtomicBool; MAX_CHANNELS] = {
    const INIT: AtomicBool = AtomicBool::new(false);
    [INIT; MAX_CHANNELS]
};

/// Per-channel change callbacks — fired when firmware writes a channel.
/// Uses Vec instead of array since Box<dyn Fn> isn't const-initializable.
static CALLBACKS: Mutex<Vec<Option<Box<dyn Fn(bool) + Send>>>> = Mutex::new(Vec::new());

/// Optional channel names for logging (set at init).
static CHANNEL_NAMES: Mutex<Option<&'static [&'static str]>> = Mutex::new(None);

// ============================================================
// Initialization
// ============================================================

/// Configure the GPIO peripheral with the number of channels and optional names.
/// Must be called before firmware starts. Resets any prior state, so calling it
/// again (in-process restart) yields a clean bank.
pub fn init(count: usize, names: Option<&'static [&'static str]>) {
    assert!(count <= MAX_CHANNELS, "GPIO count {} exceeds max {}", count, MAX_CHANNELS);
    reset();
    CHANNEL_COUNT.store(count, Ordering::Relaxed);
    *CHANNEL_NAMES.lock().unwrap() = names;
    // Ensure callback vec is sized for all channels
    let mut cbs = CALLBACKS.lock().unwrap();
    cbs.resize_with(count, || None);
}

/// Clear all channel state, callbacks, and names (used by `init` and teardown).
pub fn reset() {
    CHANNEL_COUNT.store(0, Ordering::Relaxed);
    for state in GPIO_STATE.iter() {
        state.store(false, Ordering::Relaxed);
    }
    CALLBACKS.lock().unwrap().clear();
    *CHANNEL_NAMES.lock().unwrap() = None;
}

/// Get a channel name for logging (falls back to index if no names set).
fn channel_name(channel: usize) -> String {
    if let Ok(guard) = CHANNEL_NAMES.lock() {
        if let Some(names) = *guard {
            if channel < names.len() {
                return names[channel].to_string();
            }
        }
    }
    format!("{}", channel)
}

// ============================================================
// Core API
// ============================================================

/// Set a GPIO channel active state. Fires the change callback if registered.
pub fn set_active(channel: usize, active: bool) {
    let count = CHANNEL_COUNT.load(Ordering::Relaxed);
    if channel >= count {
        return;
    }
    GPIO_STATE[channel].store(active, Ordering::Relaxed);
    trace!("GPIO {} = {}", channel_name(channel), active);

    // Fire change callback if registered
    if let Ok(cbs) = CALLBACKS.lock() {
        if channel < cbs.len() {
            if let Some(cb) = cbs[channel].as_ref() {
                cb(active);
            }
        }
    }
}

/// Get a GPIO channel active state.
pub fn get_active(channel: usize) -> bool {
    let count = CHANNEL_COUNT.load(Ordering::Relaxed);
    if channel >= count {
        return false;
    }
    GPIO_STATE[channel].load(Ordering::Relaxed)
}

/// Toggle a GPIO channel and fire the change callback.
pub fn toggle_active(channel: usize) {
    let count = CHANNEL_COUNT.load(Ordering::Relaxed);
    if channel >= count {
        return;
    }
    let current = GPIO_STATE[channel].load(Ordering::Relaxed);
    let new_state = !current;
    GPIO_STATE[channel].store(new_state, Ordering::Relaxed);
    trace!("GPIO {} toggled → {}", channel_name(channel), new_state);

    // Fire change callback if registered
    if let Ok(cbs) = CALLBACKS.lock() {
        if channel < cbs.len() {
            if let Some(cb) = cbs[channel].as_ref() {
                cb(new_state);
            }
        }
    }
}

// ============================================================
// Wiring API — used by project wiring layer
// ============================================================

/// Set a GPIO channel state from external source (e.g., model → GPIO).
/// Does NOT fire change callbacks (only firmware writes trigger callbacks).
pub fn set_state(channel: usize, state: bool) {
    if channel < CHANNEL_COUNT.load(Ordering::Relaxed) {
        GPIO_STATE[channel].store(state, Ordering::Relaxed);
        trace!("GPIO {} (ext) = {}", channel_name(channel), state);
    }
}

/// Register a callback for when firmware changes a GPIO channel.
/// Only one callback per channel.
pub fn on_change(channel: usize, cb: impl Fn(bool) + Send + 'static) {
    if channel < MAX_CHANNELS {
        if let Ok(mut cbs) = CALLBACKS.lock() {
            if channel >= cbs.len() {
                cbs.resize_with(channel + 1, || None);
            }
            cbs[channel] = Some(Box::new(cb));
        }
    }
}
