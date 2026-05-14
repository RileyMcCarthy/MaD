//! Serial — FD-bridged serial port channels.
//!
//! Bridges firmware serial channels to file descriptors. The peripheral
//! manages raw FDs and has no knowledge of what's on the other end
//! (PTY, force gauge, etc). Channel assignment is done by the project
//! wiring layer via `init_channel_fd()`.

use std::os::fd::{BorrowedFd, RawFd};
use std::sync::atomic::{AtomicI32, AtomicU32, AtomicU64, AtomicUsize, Ordering};
use tracing::{trace, debug};

/// Maximum serial channels supported.
const MAX_CHANNELS: usize = 16;

/// Bits clocked per byte on the wire (8N1: 1 start + 8 data + 1 stop).
const BITS_PER_BYTE: u64 = 10;

/// Configured channel count.
static CHANNEL_COUNT: AtomicUsize = AtomicUsize::new(0);

/// File descriptors for each channel. -1 = not connected.
static CHANNEL_FDS: [AtomicI32; MAX_CHANNELS] = {
    const INIT: AtomicI32 = AtomicI32::new(-1);
    [INIT; MAX_CHANNELS]
};

/// Configured baud per channel. 0 = unpaced (instant TX/RX, default).
static CHANNEL_BAUD: [AtomicU32; MAX_CHANNELS] = {
    const INIT: AtomicU32 = AtomicU32::new(0);
    [INIT; MAX_CHANNELS]
};

/// Next virtual-microsecond at which the TX line is free for this channel.
/// Advanced atomically per chunk to model serialized UART transmission.
static CHANNEL_TX_NEXT_V_US: [AtomicU64; MAX_CHANNELS] = {
    const INIT: AtomicU64 = AtomicU64::new(0);
    [INIT; MAX_CHANNELS]
};

/// Next virtual-microsecond at which the firmware may consume the next byte
/// from the RX line. Independent of TX so the link is full-duplex.
static CHANNEL_RX_NEXT_V_US: [AtomicU64; MAX_CHANNELS] = {
    const INIT: AtomicU64 = AtomicU64::new(0);
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

/// Configure deterministic baud-rate pacing for a channel (full-duplex).
///
/// `baud == 0` disables pacing (instant TX/RX, default). Any positive value
/// enables both directions: every `transmit_data` and every successful read
/// reserves a slot on its respective TX or RX schedule and blocks (in wall
/// time) for the virtual duration a real UART would spend clocking those
/// bytes (`bytes * 10 / baud` seconds at 8N1).
///
/// All scheduling decisions read `embsim_core::virtual_clock`, so timing is
/// reproducible across runs and scales correctly with `--speed`.
///
/// Calling `set_baud` resets both TX and RX schedules for the channel.
pub fn set_baud(channel: usize, baud: u32) {
    if channel >= MAX_CHANNELS {
        return;
    }
    CHANNEL_BAUD[channel].store(baud, Ordering::Relaxed);
    CHANNEL_TX_NEXT_V_US[channel].store(0, Ordering::Relaxed);
    CHANNEL_RX_NEXT_V_US[channel].store(0, Ordering::Relaxed);
    if baud == 0 {
        debug!("Serial channel {} baud pacing disabled", channel);
    } else {
        debug!(
            "Serial channel {} baud pacing enabled at {} bps ({} us/byte, full-duplex)",
            channel,
            baud,
            BITS_PER_BYTE * 1_000_000 / baud as u64
        );
    }
}

/// Reserve a slot of `n` bytes on the given direction's schedule and block
/// (in wall time) for the equivalent virtual duration. No-op when `baud` is 0.
fn pace_bytes(slot: &AtomicU64, baud: u32, n: usize) {
    if n == 0 || baud == 0 {
        return;
    }

    let cost_v_us = (n as u64).saturating_mul(BITS_PER_BYTE * 1_000_000) / baud as u64;
    if cost_v_us == 0 {
        return;
    }

    let now_v = embsim_core::virtual_clock::virtual_us();

    let mut current = slot.load(Ordering::Relaxed);
    let end_v = loop {
        let start_v = current.max(now_v);
        let end_v = start_v.saturating_add(cost_v_us);
        match slot.compare_exchange_weak(current, end_v, Ordering::Relaxed, Ordering::Relaxed) {
            Ok(_) => break end_v,
            Err(actual) => current = actual,
        }
    };

    let wait_v_us = end_v.saturating_sub(now_v);
    let wall_us = embsim_core::virtual_clock::virtual_to_wall_us(wait_v_us);
    if wall_us > 0 {
        std::thread::sleep(std::time::Duration::from_micros(wall_us));
    }
}

/// Reserve a TX slot of `n` bytes; sleeps to model the firmware blocking
/// while the UART clocks the bytes out.
fn pace_tx(channel: usize, n: usize) {
    if channel >= MAX_CHANNELS {
        return;
    }
    let baud = CHANNEL_BAUD[channel].load(Ordering::Relaxed);
    pace_bytes(&CHANNEL_TX_NEXT_V_US[channel], baud, n);
}

/// Reserve an RX slot of `n` bytes; called after a successful read so the
/// firmware can never consume bytes faster than the wire could deliver them.
fn pace_rx(channel: usize, n: usize) {
    if channel >= MAX_CHANNELS {
        return;
    }
    let baud = CHANNEL_BAUD[channel].load(Ordering::Relaxed);
    pace_bytes(&CHANNEL_RX_NEXT_V_US[channel], baud, n);
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

    // Reserve and wait for our slot on the simulated wire before clocking the
    // bytes out. No-op unless `set_baud` has been called for this channel.
    pace_tx(channel, data.len());

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
                // Throttle consumption to virtual baud. Sleeps wall-time
                // equivalent of n*10/baud virtual µs; no-op when unpaced.
                pace_rx(channel, n);
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
        Ok(1) => {
            // Throttle consumption to virtual baud (no-op when unpaced).
            pace_rx(channel, 1);
            Some(byte[0])
        }
        _ => None,
    }
}
