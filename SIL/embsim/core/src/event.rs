//! Multi-subscriber callback primitive.
//!
//! Models and peripherals expose state changes as events. [`Observers<T>`] is
//! the substrate they use: unlike a bare `Mutex<Option<Box<dyn Fn>>>`,
//! [`subscribe`](Observers::subscribe) **appends** — registering a second
//! observer never silently overwrites the first.
//!
//! This lets a single state change fan out to *both* the next stage in a
//! physical pipeline (e.g. one model's output feeding the next) *and* any
//! number of trace / inspection sinks, without the wiring layer having to
//! manually fuse the two into one closure.
//!
//! ```
//! use embsim_core::event::Observers;
//! use std::sync::{Arc, atomic::{AtomicU32, Ordering}};
//!
//! let ev: Observers<f64> = Observers::new();
//! let hits = Arc::new(AtomicU32::new(0));
//! let h = hits.clone();
//! ev.subscribe(move |_v| { h.fetch_add(1, Ordering::Relaxed); });
//! let h = hits.clone();
//! ev.subscribe(move |_v| { h.fetch_add(1, Ordering::Relaxed); }); // does NOT overwrite
//! ev.emit(1.5);
//! assert_eq!(hits.load(Ordering::Relaxed), 2);
//! ```

use std::sync::Mutex;

/// A list of observers notified, in registration order, when a value is emitted.
pub struct Observers<T> {
    subs: Mutex<Vec<Box<dyn Fn(T) + Send>>>,
}

impl<T> Observers<T> {
    /// Create an empty observer list. `const` so it can back a `static`.
    pub const fn new() -> Self {
        Self { subs: Mutex::new(Vec::new()) }
    }

    /// Append an observer. Observers fire in the order they were added.
    pub fn subscribe(&self, observer: impl Fn(T) + Send + 'static) {
        self.subs.lock().unwrap().push(Box::new(observer));
    }

    /// Remove all observers (used by `reset`/teardown).
    pub fn clear(&self) {
        self.subs.lock().unwrap().clear();
    }

    /// Number of registered observers.
    pub fn len(&self) -> usize {
        self.subs.lock().unwrap().len()
    }

    /// True if no observers are registered.
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

impl<T: Clone> Observers<T> {
    /// Notify every observer with `value` (cloned per observer).
    pub fn emit(&self, value: T) {
        // The lock is held across observer calls, matching the prior single-
        // callback behavior. Observers must not re-enter the same `Observers`.
        for observer in self.subs.lock().unwrap().iter() {
            observer(value.clone());
        }
    }
}

impl<T> Default for Observers<T> {
    fn default() -> Self {
        Self::new()
    }
}
