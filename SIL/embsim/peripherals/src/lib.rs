//! embsim-peripherals — Generic MCU peripheral implementations.
//!
//! Platform-agnostic peripheral modules: GPIO channel banks, FD-bridged serial,
//! encoder counters, pulse output, timers, lock pools, thread management,
//! I2C stubs, and filesystem mounting. These have NO knowledge of any specific
//! MCU — platform crates (e.g., `embsim-p2`) add FFI trampolines on top.

pub mod encoder;
pub mod filesystem;
pub mod gpio;
pub mod i2c;
pub mod lock;
pub mod pulse_out;
pub mod serial;
pub mod system;
pub mod timer;

/// Shared test plumbing for the whole crate.
///
/// `timer`, `serial`, and `pulse_out` all read the process-global
/// `embsim_core::virtual_clock`. Re-initializing that clock re-anchors virtual
/// time to zero, which would corrupt any sibling test mid-flight. So this module
/// pins the clock exactly once (at 1.0x / 180 MHz) and never touches it again,
/// and serializes every test in the crate behind a single mutex so global
/// peripheral state (channel counts, FDs, callbacks, lock pools) can never be
/// observed half-reset by a concurrently-running test.
///
/// Every test in this crate must start with:
/// ```ignore
/// let _g = crate::test_support::guard();
/// crate::test_support::ensure_clock();
/// ```
/// and must NEVER call `virtual_clock::init` or `virtual_clock::set_scale`.
#[cfg(test)]
pub(crate) mod test_support {
    use std::sync::{Mutex, OnceLock};

    /// Process-wide serialization lock for all of this crate's tests.
    pub static LOCK: Mutex<()> = Mutex::new(());

    /// Take the crate test lock, recovering from poison left by a panicking
    /// (e.g. `#[should_panic]`) test rather than propagating it.
    pub fn guard() -> std::sync::MutexGuard<'static, ()> {
        LOCK.lock().unwrap_or_else(|p| {
            LOCK.clear_poison();
            p.into_inner()
        })
    }

    /// Initialize the shared virtual clock exactly once. Subsequent calls are
    /// no-ops, so virtual time is never re-anchored out from under a sibling
    /// test. Pinned at 1.0x speed and a 180 MHz simulated clock.
    pub fn ensure_clock() {
        static C: OnceLock<()> = OnceLock::new();
        C.get_or_init(|| embsim_core::virtual_clock::init(1.0, 180_000_000));
    }
}
