//! Serial — FD-bridged serial port channels.
//!
//! Bridges firmware serial channels to file descriptors. The peripheral
//! manages raw FDs and has no knowledge of what's on the other end
//! (PTY, force gauge, etc). Channel assignment is done by the project
//! wiring layer via `init_channel_fd()`.

use std::os::fd::{BorrowedFd, RawFd};
use std::sync::atomic::{AtomicI32, AtomicUsize, Ordering};
use tracing::{trace, debug};

/// Maximum serial channels supported.
const MAX_CHANNELS: usize = 16;

/// Configured channel count.
static CHANNEL_COUNT: AtomicUsize = AtomicUsize::new(0);

/// File descriptors for each channel. -1 = not connected.
static CHANNEL_FDS: [AtomicI32; MAX_CHANNELS] = {
    const INIT: AtomicI32 = AtomicI32::new(-1);
    [INIT; MAX_CHANNELS]
};

// ============================================================
// Initialization
// ============================================================

/// Configure the serial peripheral with the number of channels.
pub fn init(count: usize) {
    assert!(count <= MAX_CHANNELS, "Serial count {} exceeds max {}", count, MAX_CHANNELS);
    CHANNEL_COUNT.store(count, Ordering::Relaxed);
}

/// Initialize a serial channel with a file descriptor.
pub fn init_channel_fd(channel: usize, fd: RawFd) {
    if channel < MAX_CHANNELS {
        CHANNEL_FDS[channel].store(fd, Ordering::Relaxed);
        debug!("Serial channel {} initialized with fd={}", channel, fd);
    }
}

// ============================================================
// Core API
// ============================================================

/// Start a serial channel (no-op in emulation, channels are FD-based).
pub fn start(channel: usize) {
    trace!("serial::start(channel={})", channel);
}

/// Stop a serial channel (no-op in emulation).
pub fn stop(channel: usize) {
    trace!("serial::stop(channel={})", channel);
}

/// Transmit data on a serial channel.
pub fn transmit_data(channel: usize, data: &[u8]) {
    if data.is_empty() {
        return;
    }
    let count = CHANNEL_COUNT.load(Ordering::Relaxed);
    if channel >= count {
        trace!("serial::transmit_data(channel={}): unknown", channel);
        return;
    }

    let fd = CHANNEL_FDS[channel].load(Ordering::Relaxed);
    if fd < 0 {
        trace!(
            "serial::transmit_data(channel={}): not connected, discarding {} bytes",
            channel, data.len()
        );
        return;
    }

    let borrowed = unsafe { BorrowedFd::borrow_raw(fd) };
    let mut written = 0;
    while written < data.len() {
        match nix::unistd::write(borrowed, &data[written..]) {
            Ok(n) => written += n,
            Err(nix::errno::Errno::EAGAIN) => {
                std::thread::yield_now();
            }
            Err(e) => {
                trace!("serial::transmit_data(channel={}): write error: {}", channel, e);
                break;
            }
        }
    }
    trace!("serial::transmit_data(channel={}, len={})", channel, data.len());
}

/// Receive data with a timeout (virtual microseconds).
/// Returns true if all `len` bytes were received before timeout.
pub fn receive_data_timeout(channel: usize, buf: &mut [u8], timeout_us: u64) -> bool {
    let count = CHANNEL_COUNT.load(Ordering::Relaxed);
    if buf.is_empty() || channel >= count {
        let wall_us = embsim_core::virtual_clock::virtual_to_wall_us(timeout_us);
        if wall_us > 0 {
            std::thread::sleep(std::time::Duration::from_micros(wall_us));
        }
        return false;
    }

    let fd = CHANNEL_FDS[channel].load(Ordering::Relaxed);
    if fd < 0 {
        let wall_us = embsim_core::virtual_clock::virtual_to_wall_us(timeout_us);
        if wall_us > 0 {
            std::thread::sleep(std::time::Duration::from_micros(wall_us));
        }
        return false;
    }

    let wall_us = embsim_core::virtual_clock::virtual_to_wall_us(timeout_us);
    let deadline = std::time::Instant::now() + std::time::Duration::from_micros(wall_us);
    let mut total_read = 0;

    while total_read < buf.len() {
        match nix::unistd::read(fd, &mut buf[total_read..]) {
            Ok(0) => break,
            Ok(n) => {
                total_read += n;
                if total_read >= buf.len() {
                    break;
                }
            }
            Err(nix::errno::Errno::EAGAIN) => {
                if std::time::Instant::now() >= deadline {
                    break;
                }
                std::thread::sleep(std::time::Duration::from_micros(100));
            }
            Err(_) => break,
        }
    }

    total_read == buf.len()
}

/// Receive a single byte (non-blocking).
/// Returns Some(byte) if a byte was available, None otherwise.
pub fn receive_byte(channel: usize) -> Option<u8> {
    let count = CHANNEL_COUNT.load(Ordering::Relaxed);
    if channel >= count {
        return None;
    }

    let fd = CHANNEL_FDS[channel].load(Ordering::Relaxed);
    if fd < 0 {
        return None;
    }

    let mut byte = [0u8; 1];
    match nix::unistd::read(fd, &mut byte) {
        Ok(1) => Some(byte[0]),
        _ => None,
    }
}
