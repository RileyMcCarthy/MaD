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
