//! I2C — Generic I2C bus stubs.
//!
//! Provides a C-compatible I2C struct and no-op implementations.
//! Projects can override specific functions if I2C emulation is needed.

use tracing::trace;

/// C-compatible I2C bus handle.
#[repr(C)]
pub struct I2C {
    pub scl: u8,
    pub sda: u8,
    pub khz: u32,
    pub pullup: i32,
}

pub fn setup(_i2c: &mut I2C, _scl: u8, _sda: u8, _khz: u32, _pullup: i32) {
    trace!("i2c::setup");
}

pub fn start(_i2c: &mut I2C) {
    trace!("i2c::start");
}

pub fn write(_i2c: &mut I2C, _byte: u8) -> bool {
    false
}

pub fn read(_i2c: &mut I2C, _ack: bool) -> u8 {
    0
}

pub fn stop(_i2c: &mut I2C) {
    trace!("i2c::stop");
}
