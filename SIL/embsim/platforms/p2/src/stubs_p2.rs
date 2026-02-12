//! Propeller 2 hardware stubs — P2-specific functions that have no
//! MCU-agnostic equivalent and are no-ops (or simple actions) in emulation.

use tracing::info;

/// P2 clock configuration (no-op in emulation).
#[no_mangle]
pub unsafe extern "C" fn _clkset(_mode: u32, _freq: u32) {}

/// P2 hub configuration (no-op in emulation).
#[no_mangle]
pub unsafe extern "C" fn _hubset(_val: u32) {}

/// P2 reboot.
#[no_mangle]
pub unsafe extern "C" fn _reboot() {
    info!("_reboot called");
    std::process::exit(0);
}
