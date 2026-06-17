//! Model: Limit Switch — virtual limit switch.
//!
//! Given a position in mm, determines whether limit switches are triggered.
//! Fires callbacks only on state transitions (edge-triggered).
//! Thresholds are configurable via `Config`.
//!
//! Has no knowledge of GPIO or any MCU peripheral.

use crate::edge::EdgeDetector;
use embsim_core::event::Observers;
use std::sync::Arc;

// ============================================================
// Configuration
// ============================================================

/// Limit switch configuration.
#[derive(Debug, Clone)]
pub struct Config {
    /// Upper limit switch threshold in mm (position below this triggers upper).
    pub upper_threshold_mm: f64,
    /// Lower limit switch threshold in mm (position above this triggers lower).
    pub lower_threshold_mm: f64,
}

// ============================================================
// Limit switch instance
// ============================================================

pub struct LimitSwitch {
    config: Config,
    upper: EdgeDetector,
    lower: EdgeDetector,
    on_upper_change: Observers<bool>,
    on_lower_change: Observers<bool>,
}

impl LimitSwitch {
    /// Create a new limit switch model instance.
    pub fn new(config: Config) -> Arc<Self> {
        tracing::info!(
            "limit_switch: init upper={:.1}mm lower={:.1}mm",
            config.upper_threshold_mm, config.lower_threshold_mm
        );
        Arc::new(Self {
            config,
            upper: EdgeDetector::new(false),
            lower: EdgeDetector::new(false),
            on_upper_change: Observers::new(),
            on_lower_change: Observers::new(),
        })
    }

    /// Subscribe to upper limit switch transitions. Multiple subscribers allowed.
    pub fn on_upper_change(&self, cb: impl Fn(bool) + Send + 'static) {
        self.on_upper_change.subscribe(cb);
    }

    /// Subscribe to lower limit switch transitions. Multiple subscribers allowed.
    pub fn on_lower_change(&self, cb: impl Fn(bool) + Send + 'static) {
        self.on_lower_change.subscribe(cb);
    }

    /// Update limit switch states for the given position in mm.
    /// Fires callbacks only on transitions.
    pub fn update(&self, position_mm: f64) {
        if let Some(upper) = self.upper.update(position_mm < self.config.upper_threshold_mm) {
            self.on_upper_change.emit(upper);
        }
        if let Some(lower) = self.lower.update(position_mm > self.config.lower_threshold_mm) {
            self.on_lower_change.emit(lower);
        }
    }
}

// ============================================================
// Tests
// ============================================================
//
// `LimitSwitch` keeps all state inside the instance (no process-global statics),
// so each test owns a fresh instance and they need no cross-test serialization.

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};

    /// Thresholds chosen so that the band `(lower, upper)` is a real interval:
    /// upper triggers when `pos < 10.0`, lower triggers when `pos > 2.0`.
    fn config() -> Config {
        Config { upper_threshold_mm: 10.0, lower_threshold_mm: 2.0 }
    }

    /// Records the last value and the number of times an `on_*_change` fired.
    #[derive(Default)]
    struct Recorder {
        last: AtomicBool,
        count: AtomicU32,
    }

    impl Recorder {
        fn new() -> Arc<Self> {
            Arc::new(Recorder::default())
        }
        fn record(self: &Arc<Self>) -> impl Fn(bool) + Send + 'static {
            let me = Arc::clone(self);
            move |v: bool| {
                me.last.store(v, Ordering::Relaxed);
                me.count.fetch_add(1, Ordering::Relaxed);
            }
        }
        fn count(&self) -> u32 {
            self.count.load(Ordering::Relaxed)
        }
        fn last(&self) -> bool {
            self.last.load(Ordering::Relaxed)
        }
    }

    /// A freshly built switch seeds both detectors at `false`. Feeding a
    /// position that leaves the upper predicate false (so no upper event) while
    /// raising the lower predicate confirms only the genuinely-changed channel
    /// fires.
    #[test]
    fn starts_idle_and_quiet_in_band() {
        let sw = LimitSwitch::new(config());
        let upper = Recorder::new();
        let lower = Recorder::new();
        sw.on_upper_change(upper.record());
        sw.on_lower_change(lower.record());

        // pos == 10.0: `pos < 10` is false (no change from seed → no upper
        // event); `pos > 2` is true (first lower transition → one lower event).
        sw.update(10.0);
        assert_eq!(upper.count(), 0, "upper must not fire when predicate stays false");
        assert_eq!(lower.count(), 1, "lower rises on first true predicate");
        assert!(lower.last(), "lower transitioned to true");
    }

    /// Moving past the upper threshold fires `upper(true)` exactly once; holding
    /// there fires nothing more; moving back above the threshold fires
    /// `upper(false)` once.
    #[test]
    fn upper_threshold_edge_triggers_both_directions() {
        let sw = LimitSwitch::new(config());
        let upper = Recorder::new();
        sw.on_upper_change(upper.record());

        // Start above the upper threshold so the upper predicate (`pos<10`) is
        // false, matching the seed — no event yet.
        sw.update(50.0);
        assert_eq!(upper.count(), 0);

        // Cross below the threshold: upper predicate becomes true → one event.
        sw.update(8.0);
        assert_eq!(upper.count(), 1, "crossing below upper fires once");
        assert!(upper.last(), "upper went true");

        // Stay below: no further events (edge-triggered, not level).
        sw.update(5.0);
        sw.update(1.0);
        assert_eq!(upper.count(), 1, "holding below upper fires nothing more");

        // Move back above the threshold: predicate false again → one event.
        sw.update(20.0);
        assert_eq!(upper.count(), 2, "crossing back above upper fires once");
        assert!(!upper.last(), "upper went false");
    }

    /// Moving past the lower threshold fires `lower(true)` once; holding fires
    /// nothing; dropping back below fires `lower(false)` once.
    #[test]
    fn lower_threshold_edge_triggers_both_directions() {
        let sw = LimitSwitch::new(config());
        let lower = Recorder::new();
        sw.on_lower_change(lower.record());

        // Below the lower threshold: predicate (`pos>2`) false, matches seed.
        sw.update(0.5);
        assert_eq!(lower.count(), 0);

        // Cross above the lower threshold → one event.
        sw.update(3.0);
        assert_eq!(lower.count(), 1, "crossing above lower fires once");
        assert!(lower.last());

        // Hold above: no further events.
        sw.update(5.0);
        sw.update(50.0);
        assert_eq!(lower.count(), 1, "holding above lower fires nothing more");

        // Drop back below → one falling event.
        sw.update(-1.0);
        assert_eq!(lower.count(), 2);
        assert!(!lower.last());
    }

    /// A position strictly inside the band trips *both* switches on the first
    /// update (both predicates become true) and the two channels are
    /// independent.
    #[test]
    fn position_in_band_trips_both_independently() {
        let sw = LimitSwitch::new(config());
        let upper = Recorder::new();
        let lower = Recorder::new();
        sw.on_upper_change(upper.record());
        sw.on_lower_change(lower.record());

        // 5.0: pos<10 true (upper rises) AND pos>2 true (lower rises).
        sw.update(5.0);
        assert_eq!(upper.count(), 1);
        assert!(upper.last());
        assert_eq!(lower.count(), 1);
        assert!(lower.last());

        // Drive far above the band: upper falls (pos<10 false), lower stays true.
        sw.update(100.0);
        assert_eq!(upper.count(), 2);
        assert!(!upper.last());
        assert_eq!(lower.count(), 1, "lower unchanged when staying above its threshold");
    }

    /// `Observers` appends, so multiple subscribers on the same channel are all
    /// notified with the same value — neither silently overwrites the other.
    #[test]
    fn multiple_subscribers_all_notified() {
        let sw = LimitSwitch::new(config());
        let a = Recorder::new();
        let b = Recorder::new();
        sw.on_upper_change(a.record());
        sw.on_upper_change(b.record());

        sw.update(50.0); // above upper, no change
        sw.update(1.0); // below upper → both fire true
        assert_eq!(a.count(), 1);
        assert_eq!(b.count(), 1);
        assert!(a.last());
        assert!(b.last());
    }

    /// With no subscribers, `update` crossing thresholds is a safe no-op (the
    /// edge state still advances internally so later subscribers see correct
    /// transitions).
    #[test]
    fn update_without_subscribers_is_safe() {
        let sw = LimitSwitch::new(config());
        sw.update(5.0);
        sw.update(50.0);
        sw.update(0.0);
        // No panic, no assertion — just exercising the empty-observer path.
    }

    /// Equality is *not* a trigger: `pos == upper_threshold` keeps `pos < upper`
    /// false, and `pos == lower_threshold` keeps `pos > lower` false. Confirms
    /// the strict-inequality boundary semantics.
    #[test]
    fn threshold_boundaries_are_strict() {
        let sw = LimitSwitch::new(config());
        let upper = Recorder::new();
        let lower = Recorder::new();
        sw.on_upper_change(upper.record());
        sw.on_lower_change(lower.record());

        // Exactly at thresholds: 10.0 < 10.0 is false; 2.0 > 2.0 is false.
        sw.update(10.0); // upper false (no change), lower: 10>2 true → lower rises
        // Reset lower below its threshold for a clean boundary check.
        sw.update(2.0); // upper: 2<10 true → upper rises; lower: 2>2 false → lower falls
        assert!(upper.last(), "upper rose crossing below 10");
        assert!(!lower.last(), "lower fell at exactly the lower threshold (strict >)");
        let upper_after = upper.count();
        // Re-feeding exactly the lower threshold must not re-trigger lower.
        let lower_after = lower.count();
        sw.update(2.0);
        assert_eq!(upper.count(), upper_after, "no upper change repeating same position");
        assert_eq!(lower.count(), lower_after, "no lower change repeating same position");
    }

    /// `Config` derives `Clone` and `Debug`; exercise both so the derives stay
    /// covered as the struct evolves.
    #[test]
    fn config_is_clone_and_debug() {
        let c = config();
        let c2 = c.clone();
        assert_eq!(c2.upper_threshold_mm, 10.0);
        assert_eq!(c2.lower_threshold_mm, 2.0);
        let s = format!("{c:?}");
        assert!(s.contains("upper_threshold_mm"));
    }

    /// The upper and lower channels are independent: oscillating purely across
    /// the *upper* threshold (while staying permanently below the *lower*
    /// threshold) toggles the upper recorder repeatedly and never fires the
    /// lower callback at all.
    #[test]
    fn channels_do_not_cross_talk() {
        // Widen the band so we can move across `upper` (10) while always staying
        // below `lower` (2)... that is impossible with the default band, so use
        // a config where the upper threshold sits *below* the lower one and we
        // operate entirely under the lower threshold.
        let cfg = Config { upper_threshold_mm: 1.0, lower_threshold_mm: 5.0 };
        let sw = LimitSwitch::new(cfg);

        let lower_fired = Arc::new(AtomicBool::new(false));
        {
            let f = Arc::clone(&lower_fired);
            sw.on_lower_change(move |_| f.store(true, Ordering::Relaxed));
        }
        let upper = Recorder::new();
        sw.on_upper_change(upper.record());

        // All positions below 5.0, so `pos > 5` (lower predicate) is always
        // false and never changes. Crossing 1.0 toggles the upper predicate.
        sw.update(0.0); // pos<1 true  → upper rises
        sw.update(2.0); // pos<1 false → upper falls (still <5, lower untouched)
        sw.update(0.0); // pos<1 true  → upper rises
        sw.update(3.0); // pos<1 false → upper falls

        assert_eq!(upper.count(), 4, "four upper transitions");
        assert!(
            !lower_fired.load(Ordering::Relaxed),
            "lower must never fire while position stays below its threshold"
        );
    }
}
