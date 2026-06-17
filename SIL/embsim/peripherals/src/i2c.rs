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

// ============================================================
// Tests
// ============================================================

#[cfg(test)]
mod tests {
    use super::*;

    fn make_bus() -> I2C {
        I2C { scl: 0, sda: 0, khz: 0, pullup: 0 }
    }

    #[test]
    fn setup_start_stop_do_not_panic() {
        let _g = crate::test_support::guard();
        crate::test_support::ensure_clock();
        // The stub lifecycle methods are no-ops that must never panic.
        let mut bus = make_bus();
        setup(&mut bus, 1, 2, 400, 1);
        start(&mut bus);
        stop(&mut bus);
    }

    #[test]
    fn write_always_reports_failure() {
        let _g = crate::test_support::guard();
        crate::test_support::ensure_clock();
        // The stub never ACKs — write() returns false for any byte.
        let mut bus = make_bus();
        assert!(!write(&mut bus, 0x00));
        assert!(!write(&mut bus, 0xFF));
    }

    #[test]
    fn read_always_returns_zero() {
        let _g = crate::test_support::guard();
        crate::test_support::ensure_clock();
        // The stub has no device behind it — read() yields 0 for both ack states.
        let mut bus = make_bus();
        assert_eq!(read(&mut bus, true), 0);
        assert_eq!(read(&mut bus, false), 0);
    }
}
