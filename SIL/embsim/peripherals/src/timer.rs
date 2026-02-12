//! Timer — Timing functions backed by VirtualClock.

use embsim_core::virtual_clock;

/// Get virtual milliseconds elapsed since boot.
pub fn get_ms() -> u32 {
    virtual_clock::virtual_ms() as u32
}

/// Get virtual microseconds elapsed since boot.
pub fn get_us() -> u32 {
    virtual_clock::virtual_us() as u32
}

/// Blocking wait for specified virtual milliseconds.
pub fn wait_ms(ms: u32) {
    let wall_us = virtual_clock::virtual_to_wall_us(ms as u64 * 1000);
    if wall_us > 0 {
        std::thread::sleep(std::time::Duration::from_micros(wall_us));
    }
}

/// Blocking wait for specified virtual microseconds.
pub fn wait_us(us: u32) {
    let wall_us = virtual_clock::virtual_to_wall_us(us as u64);
    if wall_us > 0 {
        std::thread::sleep(std::time::Duration::from_micros(wall_us));
    }
}

/// Get raw virtual cycle counter value.
pub fn get_cycles() -> u32 {
    virtual_clock::virtual_cycles() as u32
}

/// Get the simulated clock frequency.
pub fn get_clock_freq() -> u32 {
    virtual_clock::clock_freq()
}
