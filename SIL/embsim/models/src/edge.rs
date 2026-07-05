//! Edge detection — report only on boolean transitions.
//!
//! A tiny reusable primitive shared by any model that turns a continuous input
//! into edge-triggered events (limit switches, thresholds, comparators). It
//! replaces the hand-rolled `AtomicBool::swap` + compare pattern that was
//! previously copy-pasted across models.

use std::sync::atomic::{AtomicBool, Ordering};

/// Tracks a boolean level and reports only when it changes.
pub struct EdgeDetector {
    state: AtomicBool,
}

impl EdgeDetector {
    /// Create a detector seeded with an initial level.
    pub const fn new(initial: bool) -> Self {
        Self { state: AtomicBool::new(initial) }
    }

    /// Feed the current level. Returns `Some(level)` on a rising or falling
    /// edge (the level changed), or `None` if it is unchanged.
    pub fn update(&self, level: bool) -> Option<bool> {
        let prev = self.state.swap(level, Ordering::Relaxed);
        if level != prev {
            Some(level)
        } else {
            None
        }
    }

    /// Current level.
    pub fn state(&self) -> bool {
        self.state.load(Ordering::Relaxed)
    }
}

impl Default for EdgeDetector {
    fn default() -> Self {
        Self::new(false)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reports_only_on_transitions() {
        let e = EdgeDetector::new(false);
        assert_eq!(e.update(false), None); // no change
        assert_eq!(e.update(true), Some(true)); // rising
        assert_eq!(e.update(true), None); // held
        assert_eq!(e.update(false), Some(false)); // falling
        assert!(!e.state());
    }
}
