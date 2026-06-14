//! embsim-p2 — Propeller 2 platform for embsim.
//!
//! Provides `#[no_mangle] extern "C"` FFI trampolines matching the P2
//! firmware's HAL headers, delegating to generic peripheral implementations
//! in `embsim-peripherals`. Also defines P2-specific constants.
//!
//! # P2-Specific Constants
//! - Clock frequency: 180 MHz
//! - Max cogs (threads): 8
//! - Max hardware locks: 32
//! - Max GPIO: 64

pub use embsim_core;
pub use embsim_peripherals;

// Re-export peripheral modules for convenience.
pub use embsim_peripherals::{encoder, filesystem, gpio, i2c, lock, pulse_out, serial, system, timer};

mod ffi;
mod stubs_flexc;
mod stubs_p2;

/// Propeller 2 clock frequency (180 MHz).
pub const P2_CLOCK_FREQ: u32 = 180_000_000;

/// Propeller 2 max cogs.
pub const P2_MAX_COGS: usize = 8;

/// Propeller 2 max hardware locks.
pub const P2_MAX_LOCKS: usize = 32;

/// Propeller 2 max GPIO channels (64 I/O pins).
pub const P2_MAX_GPIO: usize = 64;

/// The Propeller 2 platform, for use with `embsim_runtime::Emulator::builder`.
///
/// A zero-sized handle that supplies the P2's clock/core/lock constants so a
/// consumer never threads `P2_*` constants by hand.
#[derive(Debug, Clone, Copy, Default)]
pub struct P2;

impl embsim_runtime::Platform for P2 {
    fn clock_freq_hz(&self) -> u32 {
        P2_CLOCK_FREQ
    }
    fn max_cores(&self) -> usize {
        P2_MAX_COGS
    }
    fn max_locks(&self) -> usize {
        P2_MAX_LOCKS
    }
}
