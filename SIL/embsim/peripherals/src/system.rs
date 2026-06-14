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
