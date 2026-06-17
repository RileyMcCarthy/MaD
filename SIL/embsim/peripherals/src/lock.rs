//! Lock — Mutex-based lock pool using parking_lot.
//!
//! Maps MCU hardware locks to parking_lot Mutex<()>.
//! Non-recursive (matches typical MCU lock behavior).

use parking_lot::Mutex;
use std::sync::atomic::{AtomicI32, AtomicUsize, Ordering};
use tracing::trace;

/// Hard ceiling on lock slots backed by the static `LOCKS` array. `init` sizes
/// the live pool up to this value (a platform passes its own count, e.g. the
/// Propeller 2's 32). Raise this constant if a target needs more slots.
pub const MAX_LOCKS: usize = 64;

/// Configured max lock count.
static MAX_LOCK_COUNT: AtomicUsize = AtomicUsize::new(MAX_LOCKS);

static LOCKS: [Mutex<()>; MAX_LOCKS] = {
    const INIT: Mutex<()> = Mutex::new(());
    [INIT; MAX_LOCKS]
};

static NEXT_LOCK: AtomicI32 = AtomicI32::new(0);

use std::cell::RefCell;
thread_local! {
    static HELD_LOCKS: RefCell<[bool; MAX_LOCKS]> = RefCell::new([false; MAX_LOCKS]);
}

// ============================================================
// Initialization
// ============================================================

/// Configure the lock pool with a maximum count. Resets the allocator and any
/// locks held by the calling thread, so re-init yields a fresh pool.
pub fn init(max: usize) {
    assert!(max <= MAX_LOCKS, "Lock count {} exceeds max {}", max, MAX_LOCKS);
    reset();
    MAX_LOCK_COUNT.store(max, Ordering::Relaxed);
}

/// Reset the lock allocator (`NEXT_LOCK` only ever grows otherwise) and release
/// any locks held by the calling thread. Used by `init` and teardown.
pub fn reset() {
    NEXT_LOCK.store(0, Ordering::Relaxed);
    HELD_LOCKS.with(|h| {
        let mut held = h.borrow_mut();
        for (idx, was) in held.iter_mut().enumerate() {
            if *was {
                unsafe { LOCKS[idx].force_unlock() };
                *was = false;
            }
        }
    });
}

// ============================================================
// Core API
// ============================================================

/// Allocate a new lock. Returns lock ID (>= 0) or -1 on failure.
pub fn create() -> i32 {
    let max = MAX_LOCK_COUNT.load(Ordering::Relaxed) as i32;
    let idx = NEXT_LOCK.fetch_add(1, Ordering::Relaxed);
    if idx >= max {
        tracing::error!("lock::create: out of locks");
        return -1;
    }
    trace!("lock::create: allocated lock {}", idx);
    idx
}

/// Non-blocking lock acquire attempt. Returns true if acquired.
pub fn try_acquire(lock: i32) -> bool {
    let max = MAX_LOCK_COUNT.load(Ordering::Relaxed);
    if lock < 0 || lock as usize >= max {
        return false;
    }
    let idx = lock as usize;

    let already_held = HELD_LOCKS.with(|h| h.borrow()[idx]);
    if already_held {
        // This thread already holds this lock and is trying to take it again.
        // MCU hardware locks are typically non-reentrant, so on real silicon the
        // firmware would spin here forever (self-deadlock) — silently. We fail
        // loudly instead: re-entrant acquisition means a locked critical section
        // called a helper that re-locks the same lock, which is a firmware bug.
        tracing::error!(
            "FATAL: re-entrant acquisition of lock {} by a thread that already holds it — \
             this self-deadlocks on hardware. A locked critical section called a helper \
             that re-locks the same lock. (Run with the trace viewer to find it.)",
            lock
        );
        panic!("re-entrant lock {} acquisition (firmware self-deadlock)", lock);
    }

    if let Some(guard) = LOCKS[idx].try_lock() {
        std::mem::forget(guard);
        HELD_LOCKS.with(|h| h.borrow_mut()[idx] = true);
        trace!("lock::try_acquire({}): acquired", lock);
        true
    } else {
        false
    }
}

/// Release a previously acquired lock.
pub fn release(lock: i32) {
    let max = MAX_LOCK_COUNT.load(Ordering::Relaxed);
    if lock < 0 || lock as usize >= max {
        return;
    }
    let idx = lock as usize;

    let was_held = HELD_LOCKS.with(|h| {
        let mut held = h.borrow_mut();
        let was = held[idx];
        held[idx] = false;
        was
    });

    if was_held {
        unsafe {
            LOCKS[idx].force_unlock();
        }
        trace!("lock::release({}): released", lock);
    }
}

// ============================================================
// Tests
// ============================================================

#[cfg(test)]
mod tests {
    use super::*;

    /// Take the crate test lock (lock-pool state is process-global), pin the
    /// clock, and reset the allocator + any locks held by this thread.
    fn setup(max: usize) {
        crate::test_support::ensure_clock();
        init(max);
    }

    #[test]
    fn init_at_max_locks_is_allowed() {
        let _g = crate::test_support::guard();
        // Exactly MAX_LOCKS is the inclusive upper bound.
        setup(MAX_LOCKS);
        assert_eq!(create(), 0);
        // Cleanup so we don't leave locks held for the next test.
        reset();
    }

    #[test]
    #[should_panic(expected = "exceeds max")]
    fn init_above_max_locks_panics() {
        let _g = crate::test_support::guard();
        crate::test_support::ensure_clock();
        init(MAX_LOCKS + 1);
    }

    #[test]
    fn create_returns_increasing_ids_then_minus_one_when_exhausted() {
        let _g = crate::test_support::guard();
        setup(3);
        assert_eq!(create(), 0);
        assert_eq!(create(), 1);
        assert_eq!(create(), 2);
        // Pool exhausted → -1.
        assert_eq!(create(), -1);
        assert_eq!(create(), -1);
        reset();
    }

    #[test]
    fn try_acquire_then_release_round_trip() {
        let _g = crate::test_support::guard();
        setup(4);
        let id = create();
        assert!(try_acquire(id), "fresh lock acquires");
        release(id);
        // After release it can be acquired again (by this same thread).
        assert!(try_acquire(id), "re-acquire after release");
        release(id);
        reset();
    }

    #[test]
    fn try_acquire_out_of_range_or_negative_is_false() {
        let _g = crate::test_support::guard();
        setup(2);
        // Negative id and ids at/above the configured max are rejected.
        assert!(!try_acquire(-1));
        assert!(!try_acquire(2));
        assert!(!try_acquire(1000));
        reset();
    }

    #[test]
    fn double_acquire_same_thread_panics() {
        let _g = crate::test_support::guard();
        setup(2);
        let id = create();
        assert!(try_acquire(id), "first acquire succeeds");
        // A second acquire by the SAME thread hits the self-deadlock guard and
        // panics. Catch it ON THIS THREAD so we can release the lock we still
        // hold: libtest runs each test on its own worker thread and `reset()`
        // only frees locks held by the calling thread, so a panic that left
        // LOCK[id] locked would break every sibling test that reuses slot 0.
        let panicked = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _ = try_acquire(id);
        }));
        assert!(panicked.is_err(), "re-entrant acquire must panic");
        let payload = panicked.err().unwrap();
        let text = payload
            .downcast_ref::<String>()
            .map(String::as_str)
            .or_else(|| payload.downcast_ref::<&str>().copied())
            .unwrap_or("");
        assert!(text.contains("re-entrant"), "panic names the self-deadlock: {text:?}");
        // Free the still-held lock + restore a clean pool for the next test.
        release(id);
        reset();
    }

    #[test]
    fn lock_held_by_one_thread_blocks_another_until_release() {
        let _g = crate::test_support::guard();
        setup(2);
        let id = create();
        assert!(try_acquire(id), "main thread acquires");

        // Another thread cannot acquire while we hold it.
        let acquired_while_held = std::thread::spawn(move || try_acquire(id))
            .join()
            .unwrap();
        assert!(!acquired_while_held, "other thread blocked while held");

        // After we release, another thread can acquire it.
        release(id);
        let acquired_after_release = std::thread::spawn(move || {
            let got = try_acquire(id);
            if got {
                release(id); // tidy up the other thread's hold
            }
            got
        })
        .join()
        .unwrap();
        assert!(acquired_after_release, "other thread acquires after release");
        reset();
    }

    #[test]
    fn release_of_unheld_or_out_of_range_is_a_safe_no_op() {
        let _g = crate::test_support::guard();
        setup(2);
        let id = create();
        // Releasing a never-acquired lock is harmless.
        release(id);
        // Releasing out-of-range / negative ids is harmless.
        release(-1);
        release(999);
        // The lock is still freely acquirable afterwards.
        assert!(try_acquire(id));
        release(id);
        reset();
    }

    #[test]
    fn reset_resets_allocator_and_releases_held_locks() {
        let _g = crate::test_support::guard();
        setup(4);
        let id = create();
        assert_eq!(id, 0);
        assert!(try_acquire(id), "hold a lock before reset");
        reset();
        // Allocator restarted from 0.
        assert_eq!(create(), 0);
        // reset() released the lock held by this thread, so a fresh acquire of
        // the same slot succeeds again.
        assert!(try_acquire(0), "lock freed by reset is acquirable");
        release(0);
        reset();
    }
}
