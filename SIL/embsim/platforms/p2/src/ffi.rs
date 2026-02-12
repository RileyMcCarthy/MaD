//! P2 FFI trampolines — `#[no_mangle] extern "C"` functions matching the
//! firmware's HAL_* interface. Each function delegates to the generic
//! peripheral implementation in `embsim-peripherals`.

use embsim_peripherals::{encoder, gpio, i2c, lock, pulse_out, serial, system, timer};
use tracing::info;

// ============================================================
// GPIO
// ============================================================

#[no_mangle]
pub unsafe extern "C" fn HAL_GPIO_setActive(channel: i32, active: bool) {
    if channel >= 0 {
        gpio::set_active(channel as usize, active);
    }
}

#[no_mangle]
pub unsafe extern "C" fn HAL_GPIO_getActive(channel: i32) -> bool {
    if channel >= 0 {
        gpio::get_active(channel as usize)
    } else {
        false
    }
}

#[no_mangle]
pub unsafe extern "C" fn HAL_GPIO_toggleActive(channel: i32) {
    if channel >= 0 {
        gpio::toggle_active(channel as usize);
    }
}

// ============================================================
// Serial
// ============================================================

#[no_mangle]
pub unsafe extern "C" fn HAL_serial_start(channel: i32) {
    if channel >= 0 {
        serial::start(channel as usize);
    }
}

#[no_mangle]
pub unsafe extern "C" fn HAL_serial_stop(channel: i32) {
    if channel >= 0 {
        serial::stop(channel as usize);
    }
}

#[no_mangle]
pub unsafe extern "C" fn HAL_serial_transmitData(
    channel: i32,
    data: *const u8,
    len: u32,
) {
    if data.is_null() || len == 0 || channel < 0 {
        return;
    }
    let buf = std::slice::from_raw_parts(data, len as usize);
    serial::transmit_data(channel as usize, buf);
}

#[no_mangle]
pub unsafe extern "C" fn HAL_serial_recieveDataTimeout(
    channel: i32,
    data: *mut u8,
    len: u32,
    timeout_us: u32,
) -> bool {
    if data.is_null() || len == 0 || channel < 0 {
        let wall_us = embsim_core::virtual_clock::virtual_to_wall_us(timeout_us as u64);
        if wall_us > 0 {
            std::thread::sleep(std::time::Duration::from_micros(wall_us));
        }
        return false;
    }
    let buf = std::slice::from_raw_parts_mut(data, len as usize);
    serial::receive_data_timeout(channel as usize, buf, timeout_us as u64)
}

#[no_mangle]
pub unsafe extern "C" fn HAL_serial_recieveByte(channel: i32, data: *mut u8) -> bool {
    if data.is_null() || channel < 0 {
        return false;
    }
    match serial::receive_byte(channel as usize) {
        Some(byte) => {
            *data = byte;
            true
        }
        None => false,
    }
}

// ============================================================
// Encoder
// ============================================================

#[no_mangle]
pub unsafe extern "C" fn HAL_encoder_start(channel: i32) {
    if channel >= 0 {
        encoder::start(channel as usize);
    }
}

#[no_mangle]
pub unsafe extern "C" fn HAL_encoder_value(channel: i32) -> i32 {
    if channel >= 0 {
        encoder::value(channel as usize)
    } else {
        0
    }
}

#[no_mangle]
pub unsafe extern "C" fn HAL_encoder_set(channel: i32, value: i32) {
    if channel >= 0 {
        encoder::set(channel as usize, value);
    }
}

// ============================================================
// Pulse Out
// ============================================================

#[no_mangle]
pub unsafe extern "C" fn HAL_pulseOut_start(channel: i32, pulses: u32, frequency: u32) {
    if channel >= 0 {
        pulse_out::start(channel as usize, pulses, frequency);
    }
}

#[no_mangle]
pub unsafe extern "C" fn HAL_pulseOut_run(channel: i32, pulses: *mut u32) -> bool {
    if channel < 0 || pulses.is_null() {
        return true;
    }
    let (emitted, done) = pulse_out::run(channel as usize);
    *pulses = emitted;
    done
}

#[no_mangle]
pub unsafe extern "C" fn HAL_pulseOut_stop(channel: i32) {
    if channel >= 0 {
        pulse_out::stop(channel as usize);
    }
}

// ============================================================
// Timer
// ============================================================

#[no_mangle]
pub unsafe extern "C" fn HAL_time_getMs() -> u32 {
    timer::get_ms()
}

#[no_mangle]
pub unsafe extern "C" fn HAL_time_getUs() -> u32 {
    timer::get_us()
}

#[no_mangle]
pub unsafe extern "C" fn HAL_time_waitMs(ms: u32) {
    timer::wait_ms(ms);
}

#[no_mangle]
pub unsafe extern "C" fn HAL_time_waitUs(us: u32) {
    timer::wait_us(us);
}

#[no_mangle]
pub unsafe extern "C" fn HAL_time_getCycles() -> u32 {
    timer::get_cycles()
}

#[no_mangle]
pub unsafe extern "C" fn HAL_time_getClockFreq() -> u32 {
    timer::get_clock_freq()
}

// ============================================================
// Lock
// ============================================================

#[no_mangle]
pub unsafe extern "C" fn HAL_lock_create() -> i32 {
    lock::create()
}

#[no_mangle]
pub unsafe extern "C" fn HAL_lock_try(lock_id: i32) -> bool {
    lock::try_acquire(lock_id)
}

#[no_mangle]
pub unsafe extern "C" fn HAL_lock_release(lock_id: i32) {
    lock::release(lock_id);
}

// ============================================================
// System
// ============================================================

#[no_mangle]
pub unsafe extern "C" fn HAL_system_init() {
    info!("HAL_system_init called (already initialized by embsim)");
}

#[no_mangle]
pub unsafe extern "C" fn HAL_system_reboot() {
    info!("HAL_system_reboot: firmware requested reboot");
    std::process::exit(0);
}

#[no_mangle]
pub unsafe extern "C" fn HAL_system_startThread(
    func: Option<unsafe extern "C" fn(*mut std::ffi::c_void)>,
    arg: *mut std::ffi::c_void,
    _stack: *mut std::ffi::c_void,
    _stack_size: u32,
) -> i32 {
    system::start_thread(func, arg)
}

// ============================================================
// I2C
// ============================================================

#[no_mangle]
pub unsafe extern "C" fn i2c_setup(
    self_: *mut i2c::I2C,
    scl: u8,
    sda: u8,
    khz: u32,
    pullup: i32,
) {
    if let Some(i2c) = self_.as_mut() {
        i2c::setup(i2c, scl, sda, khz, pullup);
    }
}

#[no_mangle]
pub unsafe extern "C" fn i2c_start(self_: *mut i2c::I2C) {
    if let Some(i2c) = self_.as_mut() {
        i2c::start(i2c);
    }
}

#[no_mangle]
pub unsafe extern "C" fn i2c_write(self_: *mut i2c::I2C, byte: u8) -> bool {
    if let Some(i2c) = self_.as_mut() {
        i2c::write(i2c, byte)
    } else {
        false
    }
}

#[no_mangle]
pub unsafe extern "C" fn i2c_read(self_: *mut i2c::I2C, ack: bool) -> u8 {
    if let Some(i2c) = self_.as_mut() {
        i2c::read(i2c, ack)
    } else {
        0
    }
}

#[no_mangle]
pub unsafe extern "C" fn i2c_stop(self_: *mut i2c::I2C) {
    if let Some(i2c) = self_.as_mut() {
        i2c::stop(i2c);
    }
}
