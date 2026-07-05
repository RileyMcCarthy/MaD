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

// ============================================================
// Tests
// ============================================================
//
// These exercise the PRIVATE pure logic (`conversion_interval_us`,
// `voltage_to_adc`) and the PRIVATE protocol state machine (`process_byte`,
// `send_conversion`) directly, driving bytes by hand and inspecting
// `adc.registers` / the `continuous` flag. The live `protocol_loop` thread
// (timing-driven) is intentionally NOT relied upon here — see the agent gaps.

#[cfg(test)]
mod tests {
    use super::*;

    /// Build an `Ads122u04` with simple, exact transfer-function parameters.
    /// `vref = 2_097_152 mV` is `2^21`, so `2^23 / vref == 4` — voltage→code
    /// arithmetic stays exact with `gain == 1`. The background protocol thread
    /// spawned by `new()` simply idles against the socketpair and is harmless.
    fn make_adc(gain: f64, zero_offset: i32) -> (Arc<Ads122u04>, RawFd) {
        let config = Config { vref_mv: 2_097_152.0, gain, zero_offset };
        Ads122u04::new(config)
    }

    /// A throwaway, non-blocking socketpair used as the firmware<->model link in
    /// state-machine tests. Returns `(write_end, read_end)`: `process_byte` /
    /// `send_conversion` write to `write_end`, the test reads from `read_end`.
    fn test_pair() -> (RawFd, RawFd) {
        let mut fds = [0i32; 2];
        let ret = unsafe { libc::socketpair(libc::AF_UNIX, libc::SOCK_STREAM, 0, fds.as_mut_ptr()) };
        assert_eq!(ret, 0, "socketpair failed");
        // Non-blocking on both ends so a test never hangs on a read.
        for fd in fds {
            unsafe {
                let flags = libc::fcntl(fd, libc::F_GETFL);
                libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK);
            }
        }
        (fds[0], fds[1])
    }

    /// Read up to `n` bytes from `fd`, retrying briefly on EAGAIN.
    fn read_n(fd: RawFd, n: usize) -> Vec<u8> {
        let mut out = Vec::new();
        let mut buf = [0u8; 64];
        let want = n.min(buf.len());
        for _ in 0..1000 {
            match nix::unistd::read(fd, &mut buf[..want]) {
                Ok(0) => break,
                Ok(k) => {
                    out.extend_from_slice(&buf[..k]);
                    if out.len() >= n {
                        break;
                    }
                }
                Err(nix::errno::Errno::EAGAIN) => std::thread::yield_now(),
                Err(_) => break,
            }
        }
        out
    }

    fn regs(adc: &Ads122u04) -> [u8; REGISTER_COUNT] {
        *adc.registers.lock().unwrap()
    }

    // ── conversion_interval_us: DR table + turbo halving ──

    /// Every data-rate code maps to the datasheet interval, the reserved code
    /// (111) falls back to the fastest rate, and bit 4 (turbo) halves it.
    #[test]
    fn conversion_interval_full_dr_table() {
        // (DR code in bits 7:5) → expected normal-mode interval (µs).
        let table: [(u8, u64); 8] = [
            (0b000, 50_000),
            (0b001, 22_222),
            (0b010, 11_111),
            (0b011, 5_714),
            (0b100, 3_030),
            (0b101, 1_667),
            (0b110, 1_000),
            (0b111, 1_000), // reserved → fastest fallback
        ];
        for (dr, expected) in table {
            let reg = dr << 5; // turbo bit (4) clear
            assert_eq!(
                conversion_interval_us(reg),
                expected,
                "DR {dr:#05b} normal-mode interval"
            );
            // Set the turbo bit (bit 4): interval halves.
            let turbo_reg = reg | (1 << 4);
            assert_eq!(
                conversion_interval_us(turbo_reg),
                expected / 2,
                "DR {dr:#05b} turbo-mode interval"
            );
        }
    }

    /// Turbo bit in isolation halves the default (DR=000) interval and the
    /// lowest data rate, independent of the other low bits which must be
    /// ignored.
    #[test]
    fn conversion_interval_ignores_low_bits() {
        // DR=000, turbo=0, but assorted junk in bits 3:0 — must not matter.
        assert_eq!(conversion_interval_us(0b0000_1111 & 0b0000_1111), 50_000);
        assert_eq!(conversion_interval_us(0b0000_0111), 50_000);
        // DR=000, turbo=1, junk low bits.
        assert_eq!(conversion_interval_us(0b0001_0101), 25_000);
    }

    // ── voltage_to_adc: transfer function ──

    /// Zero volts maps exactly to the calibrated zero offset.
    #[test]
    fn voltage_zero_is_zero_offset() {
        let (adc, _fw) = make_adc(1.0, 1234);
        adc.set_voltage(0.0);
        assert_eq!(adc.adc_value.load(Ordering::Relaxed), 1234);
    }

    /// A known voltage maps to `round_toward_zero(v*gain*2^23/vref) + offset`.
    /// With vref == 2^21 and gain 1, the factor `2^23/vref` is exactly 4.
    #[test]
    fn voltage_maps_to_expected_code() {
        let (adc, _fw) = make_adc(1.0, 0);
        adc.set_voltage(100.0);
        // 100 * 1 * 2^23 / 2^21 = 100 * 4 = 400.
        assert_eq!(adc.adc_value.load(Ordering::Relaxed), 400);

        // Match the production formula bit-for-bit at a non-round input.
        let v = 137.0_f64;
        let code = (v * 1.0 * ADC_MAX_CODE) / 2_097_152.0;
        adc.set_voltage(v);
        assert_eq!(adc.adc_value.load(Ordering::Relaxed), code as i32);
    }

    /// Doubling the PGA gain doubles the resulting code (offset held at 0).
    #[test]
    fn gain_scales_code_linearly() {
        let (g1, _a) = make_adc(1.0, 0);
        let (g2, _b) = make_adc(2.0, 0);
        g1.set_voltage(100.0);
        g2.set_voltage(100.0);
        let c1 = g1.adc_value.load(Ordering::Relaxed);
        let c2 = g2.adc_value.load(Ordering::Relaxed);
        assert_eq!(c1, 400);
        assert_eq!(c2, 800, "doubling gain doubles the code");
    }

    /// A negative voltage produces a code strictly below the zero offset.
    #[test]
    fn negative_voltage_is_below_zero_offset() {
        let (adc, _fw) = make_adc(1.0, 5000);
        adc.set_voltage(-50.0);
        let code = adc.adc_value.load(Ordering::Relaxed);
        assert!(code < 5000, "negative voltage must read below zero offset, got {code}");
        // -50 * 4 = -200, + 5000 = 4800.
        assert_eq!(code, 4800);
    }

    // ── process_byte: protocol state machine ──

    /// SYNC then START enters continuous mode.
    #[test]
    fn sync_then_start_sets_continuous() {
        let (adc, _fw) = make_adc(1.0, 0);
        let (wr, _rd) = test_pair();
        let mut cont = false;

        let st = process_byte(&adc, wr, ParseState::WaitSync, SYNC_BYTE, &mut cont);
        // Still not continuous until the command lands.
        assert!(!cont);
        let _ = process_byte(&adc, wr, st, CMD_START, &mut cont);
        assert!(cont, "START must enable continuous mode");
    }

    /// RESET clears continuous mode and zeroes all registers.
    #[test]
    fn reset_clears_continuous_and_registers() {
        let (adc, _fw) = make_adc(1.0, 0);
        let (wr, _rd) = test_pair();
        // Pre-load some register state and set continuous.
        *adc.registers.lock().unwrap() = [0xAA; REGISTER_COUNT];
        let mut cont = true;

        let st = process_byte(&adc, wr, ParseState::WaitSync, SYNC_BYTE, &mut cont);
        let _ = process_byte(&adc, wr, st, CMD_RESET, &mut cont);

        assert!(!cont, "RESET clears continuous");
        assert_eq!(regs(&adc), [0u8; REGISTER_COUNT], "RESET zeroes registers");
    }

    /// POWERDOWN clears continuous mode (registers untouched).
    #[test]
    fn powerdown_clears_continuous() {
        let (adc, _fw) = make_adc(1.0, 0);
        let (wr, _rd) = test_pair();
        *adc.registers.lock().unwrap() = [0x11; REGISTER_COUNT];
        let mut cont = true;

        let st = process_byte(&adc, wr, ParseState::WaitSync, SYNC_BYTE, &mut cont);
        let _ = process_byte(&adc, wr, st, CMD_POWERDOWN, &mut cont);

        assert!(!cont, "POWERDOWN clears continuous");
        assert_eq!(regs(&adc), [0x11; REGISTER_COUNT], "POWERDOWN leaves registers intact");
    }

    /// WREG writes the data byte into the register selected by `(cmd>>1)&0xF`.
    /// `0b0100` upper nibble = WREG; register index 2 → command `0x44`.
    #[test]
    fn wreg_writes_selected_register() {
        let (adc, _fw) = make_adc(1.0, 0);
        let (wr, _rd) = test_pair();
        let mut cont = false;

        // WREG register 2: upper nibble 0100, (cmd>>1)&0xF == 2 → cmd = 0x44.
        let wreg_cmd: u8 = (0b0100 << 4) | (2 << 1); // 0x44
        assert_eq!((wreg_cmd >> 4) & 0x0F, 0b0100);
        assert_eq!(((wreg_cmd >> 1) & 0x0F) as usize, 2);

        let st = process_byte(&adc, wr, ParseState::WaitSync, SYNC_BYTE, &mut cont);
        let st = process_byte(&adc, wr, st, wreg_cmd, &mut cont);
        // Next byte is the data payload.
        let _ = process_byte(&adc, wr, st, 0x9C, &mut cont);

        assert_eq!(regs(&adc)[2], 0x9C, "WREG must store the data byte in register 2");
        // Other registers untouched.
        assert_eq!(regs(&adc)[0], 0x00);
    }

    /// Two consecutive WREG transactions write two different registers.
    #[test]
    fn wreg_multiple_registers() {
        let (adc, _fw) = make_adc(1.0, 0);
        let (wr, _rd) = test_pair();
        let mut cont = false;

        // Write reg 1 = 0x07 (e.g. CONFIG1 for 1000 SPS-ish), reg 0 = 0x33.
        let mut feed = |reg: usize, val: u8| {
            let cmd: u8 = (0b0100 << 4) | ((reg as u8) << 1);
            let st = process_byte(&adc, wr, ParseState::WaitSync, SYNC_BYTE, &mut cont);
            let st = process_byte(&adc, wr, st, cmd, &mut cont);
            let _ = process_byte(&adc, wr, st, val, &mut cont);
        };
        feed(1, 0x07);
        feed(0, 0x33);
        assert_eq!(regs(&adc)[1], 0x07);
        assert_eq!(regs(&adc)[0], 0x33);
    }

    /// RREG (upper nibble 0b0010) returns to WaitSync and emits the register
    /// value on the fd; a subsequent SYNC+START still works, proving the state
    /// machine recovered cleanly.
    #[test]
    fn rreg_returns_to_waitsync_and_emits_value() {
        let (adc, _fw) = make_adc(1.0, 0);
        let (wr, rd) = test_pair();
        adc.registers.lock().unwrap()[3] = 0x5A;
        let mut cont = false;

        // RREG register 3: upper nibble 0010, (cmd>>1)&0xF == 3 → 0x26.
        let rreg_cmd: u8 = (0b0010 << 4) | (3 << 1);
        assert_eq!((rreg_cmd >> 4) & 0x0F, 0b0010);

        let st = process_byte(&adc, wr, ParseState::WaitSync, SYNC_BYTE, &mut cont);
        let _ = process_byte(&adc, wr, st, rreg_cmd, &mut cont);

        // The register value was written back to the fd.
        let got = read_n(rd, 1);
        assert_eq!(got, vec![0x5A], "RREG emits the register's current value");

        // State machine recovered: SYNC+START still enables continuous mode.
        let st = process_byte(&adc, wr, ParseState::WaitSync, SYNC_BYTE, &mut cont);
        let _ = process_byte(&adc, wr, st, CMD_START, &mut cont);
        assert!(cont);
    }

    /// RREG on an out-of-range register index emits a single `0` byte and does
    /// not panic.
    #[test]
    fn rreg_invalid_register_emits_zero() {
        let (adc, _fw) = make_adc(1.0, 0);
        let (wr, rd) = test_pair();
        let mut cont = false;

        // register index = REGISTER_COUNT (5) → out of range.
        let rreg_cmd: u8 = (0b0010 << 4) | ((REGISTER_COUNT as u8) << 1);
        let st = process_byte(&adc, wr, ParseState::WaitSync, SYNC_BYTE, &mut cont);
        let _ = process_byte(&adc, wr, st, rreg_cmd, &mut cont);

        assert_eq!(read_n(rd, 1), vec![0x00], "invalid RREG emits zero");
    }

    /// WREG to an out-of-range register index is silently ignored on the data
    /// byte (no panic, no register mutation).
    #[test]
    fn wreg_invalid_register_is_ignored() {
        let (adc, _fw) = make_adc(1.0, 0);
        let (wr, _rd) = test_pair();
        let mut cont = false;

        let wreg_cmd: u8 = (0b0100 << 4) | ((REGISTER_COUNT as u8) << 1); // reg 5
        let st = process_byte(&adc, wr, ParseState::WaitSync, SYNC_BYTE, &mut cont);
        let st = process_byte(&adc, wr, st, wreg_cmd, &mut cont);
        let _ = process_byte(&adc, wr, st, 0xFF, &mut cont);
        assert_eq!(regs(&adc), [0u8; REGISTER_COUNT], "out-of-range WREG mutates nothing");
    }

    /// A non-sync byte in WaitSync is discarded and we stay in WaitSync: a
    /// following command byte (without a sync first) is treated as garbage and
    /// does NOT enter continuous mode.
    #[test]
    fn non_sync_byte_stays_in_waitsync() {
        let (adc, _fw) = make_adc(1.0, 0);
        let (wr, _rd) = test_pair();
        let mut cont = false;

        // 0x00 is not the sync byte.
        let st = process_byte(&adc, wr, ParseState::WaitSync, 0x00, &mut cont);
        // Feed START directly — interpreted as another stray non-sync byte.
        let _ = process_byte(&adc, wr, st, CMD_START, &mut cont);
        assert!(!cont, "without a preceding SYNC, a command must not take effect");
    }

    /// An unknown command (sync OK, but command nibble is neither RREG/WREG nor
    /// a known opcode) returns to WaitSync without side effects.
    #[test]
    fn unknown_command_returns_to_waitsync() {
        let (adc, _fw) = make_adc(1.0, 0);
        let (wr, _rd) = test_pair();
        let mut cont = false;

        // Upper nibble 0b1111 is neither RREG (0010) nor WREG (0100); low bits
        // don't match RESET/START/POWERDOWN either.
        let bogus: u8 = 0xF0;
        let st = process_byte(&adc, wr, ParseState::WaitSync, SYNC_BYTE, &mut cont);
        let _ = process_byte(&adc, wr, st, bogus, &mut cont);

        assert!(!cont, "unknown command has no effect");
        assert_eq!(regs(&adc), [0u8; REGISTER_COUNT]);

        // And the machine is back at WaitSync: a fresh SYNC+START works.
        let st = process_byte(&adc, wr, ParseState::WaitSync, SYNC_BYTE, &mut cont);
        let _ = process_byte(&adc, wr, st, CMD_START, &mut cont);
        assert!(cont);
    }

    // ── send_conversion: little-endian 24-bit packing ──

    /// `send_conversion` writes the low, middle, then high byte of the 24-bit
    /// ADC value (little-endian).
    #[test]
    fn send_conversion_packs_little_endian() {
        let (adc, _fw) = make_adc(1.0, 0);
        let (wr, rd) = test_pair();

        // 0x123456 → low 0x56, mid 0x34, high 0x12.
        adc.adc_value.store(0x123456, Ordering::Relaxed);
        send_conversion(&adc, wr);
        assert_eq!(read_n(rd, 3), vec![0x56, 0x34, 0x12]);
    }

    /// Only the low 24 bits are transmitted; the top byte of the 32-bit value is
    /// dropped, and a negative `i32` is reinterpreted via its `u32` bit pattern.
    #[test]
    fn send_conversion_truncates_to_24_bits() {
        let (adc, _fw) = make_adc(1.0, 0);
        let (wr, rd) = test_pair();

        // 0xAABBCCDD as i32 is negative; low 24 bits are 0xBBCCDD.
        adc.adc_value.store(0xAABBCCDDu32 as i32, Ordering::Relaxed);
        send_conversion(&adc, wr);
        assert_eq!(
            read_n(rd, 3),
            vec![0xDD, 0xCC, 0xBB],
            "low 24 bits, little-endian; high byte 0xAA dropped"
        );
    }

    /// Zero packs to three zero bytes.
    #[test]
    fn send_conversion_zero() {
        let (adc, _fw) = make_adc(1.0, 0);
        let (wr, rd) = test_pair();
        adc.adc_value.store(0, Ordering::Relaxed);
        send_conversion(&adc, wr);
        assert_eq!(read_n(rd, 3), vec![0x00, 0x00, 0x00]);
    }

    /// `Config` derives `Clone`/`Debug`.
    #[test]
    fn config_clone_and_debug() {
        let c = Config { vref_mv: 2048.0, gain: 4.0, zero_offset: -7 };
        let c2 = c.clone();
        assert_eq!(c2.gain, 4.0);
        assert_eq!(c2.zero_offset, -7);
        assert!(format!("{c:?}").contains("vref_mv"));
    }
}
