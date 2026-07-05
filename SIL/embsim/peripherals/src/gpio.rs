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

// ============================================================
// Tests
// ============================================================

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering as AtomicOrdering};
    use std::sync::Arc;

    /// Take the crate test lock, pin the clock, and reset GPIO to a clean
    /// `count`-wide bank with no callbacks or names.
    fn setup(count: usize) {
        crate::test_support::ensure_clock();
        init(count, None);
    }

    #[test]
    fn init_at_max_channels_is_allowed() {
        let _g = crate::test_support::guard();
        // Exactly MAX_CHANNELS is the inclusive upper bound.
        setup(MAX_CHANNELS);
        assert!(!get_active(0));
        assert!(!get_active(MAX_CHANNELS - 1));
    }

    #[test]
    #[should_panic(expected = "exceeds max")]
    fn init_above_max_channels_panics() {
        let _g = crate::test_support::guard();
        crate::test_support::ensure_clock();
        init(MAX_CHANNELS + 1, None);
    }

    #[test]
    fn set_and_get_active_in_range() {
        let _g = crate::test_support::guard();
        setup(4);
        assert!(!get_active(2), "channels start low");
        set_active(2, true);
        assert!(get_active(2));
        set_active(2, false);
        assert!(!get_active(2));
    }

    #[test]
    fn out_of_range_set_active_is_a_no_op_and_get_returns_false() {
        let _g = crate::test_support::guard();
        setup(2);
        // Channel 5 is past the configured count: write is dropped, read is false.
        set_active(5, true);
        assert!(!get_active(5));
        // The in-range channels are untouched.
        assert!(!get_active(0));
        assert!(!get_active(1));
    }

    #[test]
    fn toggle_active_flips_state_and_fires_callback() {
        let _g = crate::test_support::guard();
        setup(2);
        let last = Arc::new(AtomicU32::new(u32::MAX));
        {
            let l = Arc::clone(&last);
            on_change(0, move |active| l.store(active as u32, AtomicOrdering::Relaxed));
        }
        toggle_active(0);
        assert!(get_active(0), "toggle from low → high");
        assert_eq!(last.load(AtomicOrdering::Relaxed), 1, "callback saw new state true");
        toggle_active(0);
        assert!(!get_active(0), "toggle from high → low");
        assert_eq!(last.load(AtomicOrdering::Relaxed), 0, "callback saw new state false");
    }

    #[test]
    fn toggle_out_of_range_is_a_no_op() {
        let _g = crate::test_support::guard();
        setup(1);
        // Channel 9 is unconfigured; toggle must not panic or affect channel 0.
        toggle_active(9);
        assert!(!get_active(0));
    }

    #[test]
    fn set_active_fires_change_callback_with_value() {
        let _g = crate::test_support::guard();
        setup(2);
        let count = Arc::new(AtomicU32::new(0));
        let value = Arc::new(AtomicU32::new(u32::MAX));
        {
            let c = Arc::clone(&count);
            let v = Arc::clone(&value);
            on_change(1, move |active| {
                c.fetch_add(1, AtomicOrdering::Relaxed);
                v.store(active as u32, AtomicOrdering::Relaxed);
            });
        }
        set_active(1, true);
        assert_eq!(count.load(AtomicOrdering::Relaxed), 1);
        assert_eq!(value.load(AtomicOrdering::Relaxed), 1);
    }

    #[test]
    fn set_state_changes_value_but_does_not_fire_callback() {
        let _g = crate::test_support::guard();
        setup(2);
        // Per the docs, the external `set_state` writes the value WITHOUT firing
        // the change callback (only firmware writes via set_active/toggle do).
        let hits = Arc::new(AtomicU32::new(0));
        {
            let h = Arc::clone(&hits);
            on_change(0, move |_| {
                h.fetch_add(1, AtomicOrdering::Relaxed);
            });
        }
        set_state(0, true);
        assert!(get_active(0), "set_state changes the observed value");
        assert_eq!(hits.load(AtomicOrdering::Relaxed), 0, "set_state does not fire callback");
    }

    #[test]
    fn set_state_out_of_range_is_a_no_op() {
        let _g = crate::test_support::guard();
        setup(1);
        // Channel 7 is unconfigured; set_state silently drops the write.
        set_state(7, true);
        assert!(!get_active(7));
    }

    #[test]
    fn on_change_is_one_per_channel_re_register_overwrites() {
        let _g = crate::test_support::guard();
        setup(1);
        let first = Arc::new(AtomicU32::new(0));
        let second = Arc::new(AtomicU32::new(0));
        {
            let f = Arc::clone(&first);
            on_change(0, move |_| {
                f.fetch_add(1, AtomicOrdering::Relaxed);
            });
        }
        {
            let s = Arc::clone(&second);
            on_change(0, move |_| {
                s.fetch_add(1, AtomicOrdering::Relaxed);
            });
        }
        set_active(0, true);
        assert_eq!(first.load(AtomicOrdering::Relaxed), 0, "first callback overwritten");
        assert_eq!(second.load(AtomicOrdering::Relaxed), 1, "only the latest fires");
    }

    #[test]
    fn reset_clears_state_callbacks_and_names() {
        let _g = crate::test_support::guard();
        static NAMES: &[&str] = &["ALPHA", "BETA"];
        crate::test_support::ensure_clock();
        init(2, Some(NAMES));
        set_active(0, true);
        let hits = Arc::new(AtomicU32::new(0));
        {
            let h = Arc::clone(&hits);
            on_change(0, move |_| {
                h.fetch_add(1, AtomicOrdering::Relaxed);
            });
        }
        reset();
        // State cleared back to low.
        assert!(!get_active(0));
        // Names cleared → fallback to numeric index.
        assert_eq!(channel_name(0), "0");
        // Channel count cleared, so re-arming and writing fires nothing.
        init(2, None);
        set_active(0, true); // callback was cleared by reset()
        assert_eq!(hits.load(AtomicOrdering::Relaxed), 0, "callback cleared by reset");
    }

    #[test]
    fn channel_name_uses_names_when_set_else_index() {
        let _g = crate::test_support::guard();
        static NAMES: &[&str] = &["ENA", "DIR"];
        crate::test_support::ensure_clock();
        init(2, Some(NAMES));
        // In-range index resolves to its name.
        assert_eq!(channel_name(0), "ENA");
        assert_eq!(channel_name(1), "DIR");
        // Past the names slice → numeric fallback.
        assert_eq!(channel_name(2), "2");
        // With no names configured, every channel falls back to its index.
        init(2, None);
        assert_eq!(channel_name(0), "0");
        assert_eq!(channel_name(1), "1");
    }
}
