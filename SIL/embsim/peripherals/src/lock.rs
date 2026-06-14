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
