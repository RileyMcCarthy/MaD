//! Model: ADS122U04 — UART-based ADC IC serial protocol state machine.
//!
//! Emulates the ADS122U04 UART-based ADC IC. Receives input voltage via
//! `set_voltage()` callback, converts to ADC counts, and sends conversion
//! data to firmware over a serial pipe when in continuous mode.
//!
//! The ADC has no concept of force or sensors — it only knows voltage.
//! Upstream models (e.g., strain gauge) provide voltage updates via callback.
//!
//! ADC transfer function parameters are configurable via `Config`.
//!
//! Has no knowledge of serial drivers or MCU peripherals. Communicates
//! through an internal pipe: firmware writes to one end, this model reads
//! from the other end and writes responses back.

use std::os::fd::{BorrowedFd, RawFd};
use std::sync::atomic::{AtomicI32, Ordering};
use std::sync::{Arc, Mutex};
use tracing::{debug, info, trace, warn};

// ============================================================
// ADS122U04 Protocol Constants
// ============================================================

const SYNC_BYTE: u8 = 0x55;
const CMD_RESET: u8 = 0x06;
const CMD_START: u8 = 0x08;
const CMD_POWERDOWN: u8 = 0x01;

const REGISTER_COUNT: usize = 5;

/// Index of CONFIG1 — encodes data-rate (bits 7:5) and operating mode (bit 4).
const REG_CONFIG1: usize = 1;

/// Default conversion interval if CONFIG1 is unwritten (datasheet reset = 20 SPS).
const DEFAULT_CONVERSION_INTERVAL_US: u64 = 50_000;

/// ADC resolution (24-bit, but effective range is 23-bit + sign).
const ADC_MAX_CODE: f64 = 8_388_608.0; // 2^23

/// Compute the conversion interval (virtual µs) from the contents of CONFIG1.
///
/// CONFIG1 bit layout (per ADS122U04 datasheet):
///   [7:5] DR   — data rate (000=20 SPS … 110=1000 SPS)
///   [4]   MODE — 0 = normal, 1 = turbo (doubles the rate)
///
/// Reserved DR codes (111) fall back to the fastest configured rate.
fn conversion_interval_us(reg_config1: u8) -> u64 {
    let dr = (reg_config1 >> 5) & 0b111;
    let turbo = ((reg_config1 >> 4) & 0b1) == 1;
    let normal_us: u64 = match dr {
        0b000 => 50_000, // 20 SPS
        0b001 => 22_222, // 45 SPS
        0b010 => 11_111, // 90 SPS
        0b011 => 5_714,  // 175 SPS
        0b100 => 3_030,  // 330 SPS
        0b101 => 1_667,  // 600 SPS
        0b110 => 1_000,  // 1000 SPS
        _ => 1_000,
    };
    if turbo {
        normal_us / 2
    } else {
        normal_us
    }
}

// ============================================================
// Configuration
// ============================================================

/// ADS122U04 ADC configuration.
#[derive(Debug, Clone)]
pub struct Config {
    /// Reference voltage in millivolts (e.g., 2048.0 for internal 2.048V).
    pub vref_mv: f64,
    /// PGA gain (e.g., 1.0, 2.0, 4.0, ..., 128.0).
    pub gain: f64,
    /// ADC offset at zero voltage (from calibration).
    pub zero_offset: i32,
}

// ============================================================
// ADS122U04 instance
// ============================================================

pub struct Ads122u04 {
    config: Config,
    /// The current ADC value to send in conversions.
    adc_value: AtomicI32,
    /// Model-side FD (this model reads/writes).
    model_fd: AtomicI32,
    /// Internal register state.
    registers: Mutex<[u8; REGISTER_COUNT]>,
}

impl Ads122u04 {
    /// Create a new ADS122U04 model instance. Creates an internal pipe pair
    /// and starts the protocol handler thread.
    /// Returns `(Arc<Self>, firmware_fd)` — wire firmware_fd to the serial driver.
    pub fn new(config: Config) -> (Arc<Self>, RawFd) {
        info!(
            "ADS122U04: init vref={:.1}mV gain={:.1} zero_offset={}",
            config.vref_mv, config.gain, config.zero_offset
        );

        let (model_fd, firmware_fd) = create_pipe_pair();

        let instance = Arc::new(Self {
            adc_value: AtomicI32::new(config.zero_offset),
            config,
            model_fd: AtomicI32::new(model_fd),
            registers: Mutex::new([0u8; REGISTER_COUNT]),
        });

        // Start the protocol handler thread
        let adc = Arc::clone(&instance);
        std::thread::Builder::new()
            .name("ads122u04".into())
            .spawn(move || protocol_loop(&adc))
            .expect("Failed to start ADS122U04 thread");

        debug!("ADS122U04 model initialized (firmware_fd={}, model_fd={})", firmware_fd, model_fd);
        (instance, firmware_fd)
    }

    /// Set the input voltage in millivolts. Converts to ADC value internally.
    /// This is the callback input from upstream models (e.g., strain gauge).
    pub fn set_voltage(&self, voltage_mv: f64) {
        let adc = self.voltage_to_adc(voltage_mv);
        self.adc_value.store(adc, Ordering::Relaxed);
        trace!("ADS122U04: voltage={:.4}mV → adc={}", voltage_mv, adc);
    }

    /// Convert input voltage (mV) to ADC counts.
    fn voltage_to_adc(&self, voltage_mv: f64) -> i32 {
        let code = (voltage_mv * self.config.gain * ADC_MAX_CODE) / self.config.vref_mv;
        (code as i32) + self.config.zero_offset
    }
}

// ============================================================
// Internal pipe creation
// ============================================================

/// Create a bidirectional pipe pair using socketpair.
/// Returns (model_fd, firmware_fd) as raw file descriptors.
fn create_pipe_pair() -> (RawFd, RawFd) {
    let mut fds = [0i32; 2];
    let ret = unsafe {
        libc::socketpair(libc::AF_UNIX, libc::SOCK_STREAM, 0, fds.as_mut_ptr())
    };
    assert_eq!(ret, 0, "Failed to create ADS122U04 socket pair");

    // Set model side to non-blocking for polling reads
    unsafe {
        let flags = libc::fcntl(fds[0], libc::F_GETFL);
        libc::fcntl(fds[0], libc::F_SETFL, flags | libc::O_NONBLOCK);
    }

    (fds[0], fds[1])
}

// ============================================================
// Protocol state machine
// ============================================================

/// Parser state for the byte-by-byte protocol.
enum ParseState {
    /// Waiting for sync byte (0x55)
    WaitSync,
    /// Got sync, waiting for command byte
    WaitCommand,
    /// Writing a register: got sync + command, waiting for data byte
    WaitWriteData { register: usize },
}

/// Main protocol loop — runs on its own thread.
fn protocol_loop(adc: &Ads122u04) {
    let model_fd = adc.model_fd.load(Ordering::Relaxed);
    if model_fd < 0 {
        warn!("ADS122U04: model_fd not initialized");
        return;
    }

    let mut state = ParseState::WaitSync;
    let mut continuous = false;
    let mut last_conversion_us: u64 = 0;

    loop {
        // Try to read incoming bytes from firmware
        let mut byte = [0u8; 1];
        match nix::unistd::read(model_fd, &mut byte) {
            Ok(1) => {
                state = process_byte(adc, model_fd, state, byte[0], &mut continuous);
            }
            Ok(_) => {}
            Err(nix::errno::Errno::EAGAIN) => {
                // No data available — proceed to send conversions if needed
            }
            Err(e) => {
                warn!("ADS122U04: read error: {}", e);
                break;
            }
        }

        // Send continuous conversion data if active. The conversion interval
        // is derived from CONFIG1 (DR bits + Turbo flag) so the model honors
        // whatever rate the firmware configured via WREG (1000 SPS by default
        // in MaD firmware).
        if continuous {
            let reg1 = adc.registers.lock().unwrap()[REG_CONFIG1];
            let interval_us = if reg1 == 0 {
                DEFAULT_CONVERSION_INTERVAL_US
            } else {
                conversion_interval_us(reg1)
            };
            let now_us = embsim_core::virtual_clock::virtual_us();
            if now_us >= last_conversion_us + interval_us {
                last_conversion_us = now_us;
                send_conversion(adc, model_fd);
            }
        }

        // Sleep briefly to avoid busy-looping. Must be substantially finer than
        // the configured conversion interval so we don't miss the 1000 SPS edge
        // (1 ms period). 250 µs gives at least 4× oversample at the fastest
        // non-turbo rate the firmware supports.
        let wall_us = embsim_core::virtual_clock::virtual_to_wall_us(250);
        if wall_us > 0 {
            std::thread::sleep(std::time::Duration::from_micros(wall_us));
        }
    }
}

/// Process a single received byte, advance state machine.
fn process_byte(
    adc: &Ads122u04,
    fd: RawFd,
    state: ParseState,
    byte: u8,
    continuous: &mut bool,
) -> ParseState {
    match state {
        ParseState::WaitSync => {
            if byte == SYNC_BYTE {
                ParseState::WaitCommand
            } else {
                trace!("ADS122U04: discarding non-sync byte 0x{:02x}", byte);
                ParseState::WaitSync
            }
        }
        ParseState::WaitCommand => {
            let command = byte;

            if command == CMD_RESET {
                debug!("ADS122U04: RESET");
                *continuous = false;
                *adc.registers.lock().unwrap() = [0u8; REGISTER_COUNT];
                ParseState::WaitSync
            } else if command == CMD_START {
                debug!("ADS122U04: START (continuous mode)");
                *continuous = true;
                ParseState::WaitSync
            } else if command == CMD_POWERDOWN {
                debug!("ADS122U04: POWERDOWN");
                *continuous = false;
                ParseState::WaitSync
            } else {
                let upper_nibble = (command >> 4) & 0x0F;
                let register = ((command >> 1) & 0x0F) as usize;

                if upper_nibble == 0b0010 {
                    // RREG — read register
                    if register < REGISTER_COUNT {
                        let val = adc.registers.lock().unwrap()[register];
                        trace!("ADS122U04: RREG reg={} val=0x{:02x}", register, val);
                        write_bytes(fd, &[val]);
                    } else {
                        trace!("ADS122U04: RREG invalid reg={}", register);
                        write_bytes(fd, &[0]);
                    }
                    ParseState::WaitSync
                } else if upper_nibble == 0b0100 {
                    // WREG — write register, need one more data byte
                    trace!("ADS122U04: WREG reg={} (waiting for data)", register);
                    ParseState::WaitWriteData { register }
                } else {
                    trace!("ADS122U04: unknown command 0x{:02x}", command);
                    ParseState::WaitSync
                }
            }
        }
        ParseState::WaitWriteData { register } => {
            if register < REGISTER_COUNT {
                adc.registers.lock().unwrap()[register] = byte;
                debug!("ADS122U04: WREG reg={} val=0x{:02x}", register, byte);
            }
            ParseState::WaitSync
        }
    }
}

/// Send a 3-byte ADC conversion value to firmware.
fn send_conversion(adc: &Ads122u04, fd: RawFd) {
    let value = adc.adc_value.load(Ordering::Relaxed) as u32;
    let bytes = [
        (value & 0xFF) as u8,
        ((value >> 8) & 0xFF) as u8,
        ((value >> 16) & 0xFF) as u8,
    ];
    trace!("ADS122U04: sending conversion value={} bytes={:?}", value, bytes);
    write_bytes(fd, &bytes);
}

/// Write bytes to the model's FD.
fn write_bytes(fd: RawFd, data: &[u8]) {
    let borrowed = unsafe { BorrowedFd::borrow_raw(fd) };
    let mut written = 0;
    while written < data.len() {
        match nix::unistd::write(borrowed, &data[written..]) {
            Ok(n) => written += n,
            Err(nix::errno::Errno::EAGAIN) => {
                std::thread::yield_now();
            }
            Err(e) => {
                warn!("ADS122U04: write error: {}", e);
                break;
            }
        }
    }
}
