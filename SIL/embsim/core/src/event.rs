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

// ============================================================
// Tests
// ============================================================

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex as StdMutex};

    /// `Observers` is instance-based — every test owns a fresh list, so no
    /// process-global lock is needed (unlike the clock / peripheral suites).

    /// A freshly constructed list (via `new` and `default`) is empty: `len` is
    /// 0 and `is_empty` is true.
    #[test]
    fn new_and_default_are_empty() {
        let a: Observers<f64> = Observers::new();
        assert_eq!(a.len(), 0);
        assert!(a.is_empty());

        let b: Observers<i32> = Observers::default();
        assert_eq!(b.len(), 0);
        assert!(b.is_empty());
    }

    /// `subscribe` APPENDS rather than overwrites: registering a second observer
    /// grows the list and BOTH fire on a single emit.
    #[test]
    fn subscribe_appends_and_both_fire() {
        let ev: Observers<u32> = Observers::new();
        let hits = Arc::new(AtomicU32::new(0));

        let h = hits.clone();
        ev.subscribe(move |_v| {
            h.fetch_add(1, Ordering::Relaxed);
        });
        assert_eq!(ev.len(), 1);
        assert!(!ev.is_empty());

        let h = hits.clone();
        ev.subscribe(move |_v| {
            h.fetch_add(1, Ordering::Relaxed);
        });
        assert_eq!(ev.len(), 2, "second subscribe must append, not replace");

        ev.emit(7);
        assert_eq!(hits.load(Ordering::Relaxed), 2, "both observers fired");
    }

    /// `emit` invokes observers in registration order. Each observer logs its
    /// own index; the recorded order must be ascending [0, 1, 2].
    #[test]
    fn emit_fires_in_registration_order() {
        let ev: Observers<()> = Observers::new();
        let order = Arc::new(StdMutex::new(Vec::<usize>::new()));

        for idx in 0..3usize {
            let o = order.clone();
            ev.subscribe(move |_v| {
                o.lock().unwrap().push(idx);
            });
        }

        ev.emit(());
        assert_eq!(*order.lock().unwrap(), vec![0, 1, 2]);
    }

    /// `emit` clones the value once per observer. A `Clone`-counting payload
    /// proves each registered observer received its own clone.
    #[test]
    fn emit_clones_value_per_observer() {
        // Payload whose `Clone` impl bumps a shared counter.
        struct Tracked {
            clones: Arc<AtomicUsize>,
        }
        impl Clone for Tracked {
            fn clone(&self) -> Self {
                self.clones.fetch_add(1, Ordering::Relaxed);
                Tracked { clones: self.clones.clone() }
            }
        }

        let clones = Arc::new(AtomicUsize::new(0));
        let ev: Observers<Tracked> = Observers::new();

        let seen = Arc::new(AtomicUsize::new(0));
        for _ in 0..3 {
            let s = seen.clone();
            ev.subscribe(move |t: Tracked| {
                // Touch the value so it is genuinely delivered, not optimized away.
                let _ = Arc::strong_count(&t.clones);
                s.fetch_add(1, Ordering::Relaxed);
            });
        }

        ev.emit(Tracked { clones: clones.clone() });

        // Three observers → three clones of the emitted value.
        assert_eq!(clones.load(Ordering::Relaxed), 3, "one clone per observer");
        assert_eq!(seen.load(Ordering::Relaxed), 3, "every observer was delivered the value");
    }

    /// `clear` empties the list so a subsequent `emit` fires nothing, and
    /// `is_empty`/`len` reflect the cleared state.
    #[test]
    fn clear_empties_and_silences_emit() {
        let ev: Observers<u8> = Observers::new();
        let hits = Arc::new(AtomicU32::new(0));
        let h = hits.clone();
        ev.subscribe(move |_v| {
            h.fetch_add(1, Ordering::Relaxed);
        });
        assert_eq!(ev.len(), 1);

        ev.clear();
        assert_eq!(ev.len(), 0);
        assert!(ev.is_empty());

        ev.emit(1);
        assert_eq!(hits.load(Ordering::Relaxed), 0, "cleared list fires nothing");
    }

    /// Multiple `emit` calls re-fire every observer each time (observers are not
    /// one-shot).
    #[test]
    fn multiple_emits_refire_all_observers() {
        let ev: Observers<u32> = Observers::new();
        let hits = Arc::new(AtomicU32::new(0));
        for _ in 0..2 {
            let h = hits.clone();
            ev.subscribe(move |v| {
                h.fetch_add(v, Ordering::Relaxed);
            });
        }

        ev.emit(1);
        ev.emit(1);
        ev.emit(1);
        // 2 observers × 3 emits × value 1 = 6.
        assert_eq!(hits.load(Ordering::Relaxed), 6);
    }

    /// `emit` on an observer-less list is a harmless no-op.
    #[test]
    fn emit_with_no_observers_is_noop() {
        let ev: Observers<i64> = Observers::new();
        ev.emit(-42); // must not panic
        assert!(ev.is_empty());
    }
}
