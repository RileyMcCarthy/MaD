//! System — Thread management and system lifecycle.
//!
//! Maps MCU execution cores to OS threads. Firmware-provided stack buffers
//! are ignored (OS manages thread stacks). "core" is the MCU-neutral term;
//! a platform's own vocabulary (e.g. the Propeller 2's "cog") stays in that
//! platform crate.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;
use std::thread;
use tracing::info;

/// Maximum threads supported (hard ceiling of the handle table).
pub const MAX_THREADS: usize = 32;

/// Configured max thread count.
static MAX_THREAD_COUNT: AtomicUsize = AtomicUsize::new(8);

/// Thread handles for joining on shutdown.
static THREAD_HANDLES: Mutex<Vec<Option<thread::JoinHandle<()>>>> = Mutex::new(Vec::new());

/// Initialize thread handle storage.
fn ensure_initialized() {
    let mut handles = THREAD_HANDLES.lock().unwrap();
    let max = MAX_THREAD_COUNT.load(Ordering::Relaxed);
    if handles.is_empty() {
        handles.resize_with(max, || None);
    }
}

// ============================================================
// Initialization
// ============================================================

/// Configure the system peripheral with max thread count. Resets the handle
/// table first, so re-init (after [`join_all_threads`]) is a clean start.
pub fn init(max_threads: usize) {
    assert!(max_threads <= MAX_THREADS, "Thread count {} exceeds max {}", max_threads, MAX_THREADS);
    reset();
    MAX_THREAD_COUNT.store(max_threads, Ordering::Relaxed);
    ensure_initialized();
    info!("system::init: emulator platform initialized (max_threads={})", max_threads);
}

/// Clear the thread handle table.
///
/// Only safe once spawned threads have finished — call [`join_all_threads`]
/// first. Clearing live handles would detach (not stop) those threads; the
/// firmware is one-per-process by construction, so a restart joins then resets.
pub fn reset() {
    THREAD_HANDLES.lock().unwrap().clear();
}

// ============================================================
// Core API
// ============================================================

/// Start a new thread. Returns the thread/core ID (>= 0) or -1 on failure.
///
/// # Safety
/// The function pointer and argument must be valid for the lifetime of the thread.
pub unsafe fn start_thread(
    func: Option<unsafe extern "C" fn(*mut std::ffi::c_void)>,
    arg: *mut std::ffi::c_void,
) -> i32 {
    let func = match func {
        Some(f) => f,
        None => {
            tracing::error!("system::start_thread: null function pointer");
            return -1;
        }
    };

    ensure_initialized();

    let mut handles = THREAD_HANDLES.lock().unwrap();

    let slot_id = match handles.iter().position(|h| h.is_none()) {
        Some(id) => id,
        None => {
            tracing::error!("system::start_thread: no available thread slots");
            return -1;
        }
    };

    let arg_usize = arg as usize;
    let func_ptr = func as usize;
    let thread_name = format!("core-{}", slot_id);

    let handle = thread::Builder::new()
        .name(thread_name.clone())
        .spawn(move || {
            info!("Thread {} started", thread_name);
            unsafe {
                let f: unsafe extern "C" fn(*mut std::ffi::c_void) =
                    std::mem::transmute(func_ptr);
                f(arg_usize as *mut std::ffi::c_void);
            }
            info!("Thread {} exited", thread_name);
        });

    match handle {
        Ok(h) => {
            info!("system::start_thread: started core-{}", slot_id);
            handles[slot_id] = Some(h);
            slot_id as i32
        }
        Err(e) => {
            tracing::error!("system::start_thread: failed to spawn thread: {}", e);
            -1
        }
    }
}

/// Wait for all threads to finish (called from main on shutdown).
pub fn join_all_threads() {
    let mut handles = THREAD_HANDLES.lock().unwrap();
    for (i, handle) in handles.iter_mut().enumerate() {
        if let Some(h) = handle.take() {
            info!("Joining core-{}", i);
            let _ = h.join();
        }
    }
}

// ============================================================
// Tests
// ============================================================

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicBool;

    /// Trivial, fast thread body: treats `arg` as a `*const AtomicBool` and sets
    /// it true so the test can observe the thread actually ran. Never loops.
    unsafe extern "C" fn set_flag(arg: *mut std::ffi::c_void) {
        let flag = &*(arg as *const AtomicBool);
        flag.store(true, Ordering::SeqCst);
    }

    /// Take the crate test lock (the handle table is process-global), pin the
    /// clock, and reset the handle table to a clean `max`-slot pool.
    fn setup(max: usize) {
        crate::test_support::ensure_clock();
        init(max);
    }

    #[test]
    fn init_at_max_threads_is_allowed() {
        let _g = crate::test_support::guard();
        // Exactly MAX_THREADS is the inclusive upper bound.
        setup(MAX_THREADS);
        join_all_threads();
        reset();
    }

    #[test]
    #[should_panic(expected = "exceeds max")]
    fn init_above_max_threads_panics() {
        let _g = crate::test_support::guard();
        crate::test_support::ensure_clock();
        init(MAX_THREADS + 1);
    }

    #[test]
    fn start_thread_runs_function_and_returns_slot_id() {
        let _g = crate::test_support::guard();
        setup(4);
        // The flag must outlive the spawned thread; join before it drops.
        let flag = Box::new(AtomicBool::new(false));
        let arg = (&*flag as *const AtomicBool) as *mut std::ffi::c_void;
        let id = unsafe { start_thread(Some(set_flag), arg) };
        assert!(id >= 0, "valid spawn returns a non-negative slot id");
        // Joining guarantees the thread body (and its side effect) completed.
        join_all_threads();
        assert!(flag.load(Ordering::SeqCst), "thread body ran and set the flag");
        reset();
    }

    #[test]
    fn start_thread_with_null_function_returns_minus_one() {
        let _g = crate::test_support::guard();
        setup(4);
        let id = unsafe { start_thread(None, std::ptr::null_mut()) };
        assert_eq!(id, -1, "null function pointer is rejected");
        join_all_threads();
        reset();
    }

    #[test]
    fn slots_are_reused_after_join() {
        let _g = crate::test_support::guard();
        setup(2);
        let flag_a = Box::new(AtomicBool::new(false));
        let arg_a = (&*flag_a as *const AtomicBool) as *mut std::ffi::c_void;
        let id0 = unsafe { start_thread(Some(set_flag), arg_a) };
        assert_eq!(id0, 0, "first thread takes slot 0");
        join_all_threads();
        assert!(flag_a.load(Ordering::SeqCst));

        // join_all_threads took the handle, so slot 0 is free again.
        let flag_b = Box::new(AtomicBool::new(false));
        let arg_b = (&*flag_b as *const AtomicBool) as *mut std::ffi::c_void;
        let id1 = unsafe { start_thread(Some(set_flag), arg_b) };
        assert_eq!(id1, 0, "freed slot 0 is reused");
        join_all_threads();
        assert!(flag_b.load(Ordering::SeqCst));
        reset();
    }

    #[test]
    fn reset_clears_handle_table_after_join() {
        let _g = crate::test_support::guard();
        setup(2);
        let flag = Box::new(AtomicBool::new(false));
        let arg = (&*flag as *const AtomicBool) as *mut std::ffi::c_void;
        let _ = unsafe { start_thread(Some(set_flag), arg) };
        // Must join before reset (reset would otherwise detach a live thread).
        join_all_threads();
        assert!(flag.load(Ordering::SeqCst));
        reset();
        // After reset + re-init, slot allocation starts fresh at 0.
        init(2);
        let flag2 = Box::new(AtomicBool::new(false));
        let arg2 = (&*flag2 as *const AtomicBool) as *mut std::ffi::c_void;
        let id = unsafe { start_thread(Some(set_flag), arg2) };
        assert_eq!(id, 0, "handle table cleared → first slot is 0 again");
        join_all_threads();
        reset();
    }
}
