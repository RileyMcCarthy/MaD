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

// ============================================================
// Tests
// ============================================================

#[cfg(test)]
mod tests {
    //! Tests for the P2 platform: the `Platform` constants and the
    //! `#[no_mangle]` HAL trampolines (delegation + null/negative guards).
    //!
    //! The trampolines mutate the process-global peripheral state in
    //! `embsim-peripherals`, so every test serializes behind [`guard`] and
    //! re-`init`s the peripherals at the top via [`setup`]. The virtual clock is
    //! pinned exactly once (re-`init` would re-anchor time for sibling tests).
    //! The submodules `ffi`/`stubs_flexc`/`stubs_p2` are crate-private but their
    //! `pub extern "C"` symbols are reachable here via `crate::...` paths.

    use super::*;
    use embsim_peripherals::{encoder, gpio, i2c, lock, pulse_out, serial, system};
    use embsim_runtime::Platform as _;
    use std::ffi::{c_void, CString};
    use std::sync::atomic::{AtomicU32, Ordering};
    use std::sync::{Mutex, OnceLock};

    /// Serializes all P2 tests — they share the global peripheral banks.
    static TEST_LOCK: Mutex<()> = Mutex::new(());

    /// Take the test lock, recovering from poison left by a `#[should_panic]`
    /// or otherwise-panicking sibling test (matches the `pulse_out.rs` pattern).
    fn guard() -> std::sync::MutexGuard<'static, ()> {
        TEST_LOCK.lock().unwrap_or_else(|p| {
            TEST_LOCK.clear_poison();
            p.into_inner()
        })
    }

    /// Pin the shared virtual clock exactly once (1.0x at the P2's 180 MHz).
    fn ensure_clock() {
        static C: OnceLock<()> = OnceLock::new();
        C.get_or_init(|| embsim_core::virtual_clock::init(1.0, P2_CLOCK_FREQ));
    }

    /// Re-initialize every peripheral to a known clean state before a test.
    fn setup() {
        ensure_clock();
        gpio::init(8, None);
        serial::init(4);
        encoder::init(4);
        pulse_out::init(4);
        lock::init(P2_MAX_LOCKS);
        system::init(P2_MAX_COGS);
    }

    /// A connected, non-blocking bidirectional fd pair (returns `(a, b)`).
    fn socketpair_nonblock() -> (i32, i32) {
        let mut fds = [0i32; 2];
        let r = unsafe { libc::socketpair(libc::AF_UNIX, libc::SOCK_STREAM, 0, fds.as_mut_ptr()) };
        assert_eq!(r, 0, "socketpair failed");
        for &fd in &fds {
            unsafe {
                let fl = libc::fcntl(fd, libc::F_GETFL);
                libc::fcntl(fd, libc::F_SETFL, fl | libc::O_NONBLOCK);
            }
        }
        (fds[0], fds[1])
    }

    // ── Platform constants + trait impl ──

    /// The P2 constants and the `Platform` impl report the documented values.
    #[test]
    fn platform_constants_and_trait() {
        assert_eq!(P2_CLOCK_FREQ, 180_000_000);
        assert_eq!(P2_MAX_COGS, 8);
        assert_eq!(P2_MAX_LOCKS, 32);
        assert_eq!(P2_MAX_GPIO, 64);

        let p = P2;
        assert_eq!(p.clock_freq_hz(), 180_000_000);
        assert_eq!(p.max_cores(), 8);
        assert_eq!(p.max_locks(), 32);

        // Zero-sized handle is Copy + Clone + Debug + Default.
        let copy = p;
        let cloned = p.clone();
        assert_eq!(copy.max_cores(), cloned.max_cores());
        assert!(!format!("{:?}", P2::default()).is_empty());
    }

    // ── GPIO trampolines ──

    /// `HAL_GPIO_*` delegate to the generic gpio bank, and a negative channel is
    /// a safe no-op / false.
    #[test]
    fn gpio_trampolines_delegate_and_guard() {
        let _g = guard();
        setup();
        unsafe {
            ffi::HAL_GPIO_setActive(2, true);
            assert!(gpio::get_active(2), "trampoline wrote the bank");
            assert!(ffi::HAL_GPIO_getActive(2), "getActive reads the bank");

            ffi::HAL_GPIO_toggleActive(2);
            assert!(!gpio::get_active(2), "toggle flipped it");
            assert!(!ffi::HAL_GPIO_getActive(2));

            // Negative channels are guarded before the `as usize` cast.
            ffi::HAL_GPIO_setActive(-1, true);
            assert!(!ffi::HAL_GPIO_getActive(-1));
            ffi::HAL_GPIO_toggleActive(-1);
        }
    }

    // ── Serial trampolines ──

    /// `HAL_serial_transmitData` and `HAL_serial_recieveByte` move real bytes
    /// across the wired fd, and `recieveByte` is non-blocking (false when idle).
    #[test]
    fn serial_transmit_and_receive_roundtrip() {
        let _g = guard();
        setup();
        let (ch_fd, peer) = socketpair_nonblock();
        serial::init_channel_fd(0, ch_fd);

        unsafe {
            // TX: the trampoline writes to the channel fd; read it from the peer.
            ffi::HAL_serial_transmitData(0, b"hi".as_ptr(), 2);
            let mut buf = [0u8; 2];
            let n = libc::read(peer, buf.as_mut_ptr() as *mut c_void, 2);
            assert_eq!(n, 2);
            assert_eq!(&buf, b"hi");

            // RX: write to the peer; the trampoline reads it from the channel fd.
            assert_eq!(libc::write(peer, b"Z".as_ptr() as *const c_void, 1), 1);
            let mut byte = 0u8;
            assert!(ffi::HAL_serial_recieveByte(0, &mut byte as *mut u8));
            assert_eq!(byte, b'Z');

            // Nothing buffered now → non-blocking false (never hangs).
            assert!(!ffi::HAL_serial_recieveByte(0, &mut byte as *mut u8));

            libc::close(ch_fd);
            libc::close(peer);
        }
    }

    /// `HAL_serial_recieveDataTimeout` fills the buffer and returns true when all
    /// bytes are available.
    #[test]
    fn serial_receive_data_timeout_full_read() {
        let _g = guard();
        setup();
        let (ch_fd, peer) = socketpair_nonblock();
        serial::init_channel_fd(0, ch_fd);
        unsafe {
            assert_eq!(libc::write(peer, b"abcd".as_ptr() as *const c_void, 4), 4);
            let mut buf = [0u8; 4];
            let ok = ffi::HAL_serial_recieveDataTimeout(0, buf.as_mut_ptr(), 4, 50_000);
            assert!(ok, "all 4 bytes arrived before timeout");
            assert_eq!(&buf, b"abcd");
            libc::close(ch_fd);
            libc::close(peer);
        }
    }

    /// Serial trampolines guard null pointers and negative channels without UB.
    #[test]
    fn serial_trampolines_guard_null_and_negative() {
        let _g = guard();
        setup();
        unsafe {
            let mut b = 0u8;
            assert!(!ffi::HAL_serial_recieveByte(-1, &mut b as *mut u8));
            assert!(!ffi::HAL_serial_recieveByte(0, std::ptr::null_mut()));
            // No-ops: negative channel, null data, zero length.
            ffi::HAL_serial_transmitData(-1, b"x".as_ptr(), 1);
            ffi::HAL_serial_transmitData(0, std::ptr::null(), 1);
            ffi::HAL_serial_transmitData(0, b"x".as_ptr(), 0);
            // Tiny timeout keeps the (expected) failure fast.
            assert!(!ffi::HAL_serial_recieveDataTimeout(0, std::ptr::null_mut(), 4, 100));
            ffi::HAL_serial_start(0);
            ffi::HAL_serial_stop(0);
        }
    }

    // ── Encoder trampolines ──

    /// `HAL_encoder_*` delegate to the encoder bank; negatives are guarded.
    #[test]
    fn encoder_trampolines_delegate_and_guard() {
        let _g = guard();
        setup();
        unsafe {
            ffi::HAL_encoder_start(0);
            ffi::HAL_encoder_set(1, 42);
            assert_eq!(encoder::value(1), 42);
            assert_eq!(ffi::HAL_encoder_value(1), 42);
            assert_eq!(ffi::HAL_encoder_value(-1), 0);
            ffi::HAL_encoder_set(-1, 5); // no-op
        }
    }

    // ── Pulse-out trampolines ──

    /// `HAL_pulseOut_run` writes the emitted count and returns done; a null
    /// out-pointer or negative channel returns true (done) safely.
    #[test]
    fn pulseout_trampolines_delegate_and_guard() {
        let _g = guard();
        setup();
        unsafe {
            ffi::HAL_pulseOut_start(0, 10, 1_000);
            let mut emitted: u32 = 12_345;
            let _done = ffi::HAL_pulseOut_run(0, &mut emitted as *mut u32);
            assert!(emitted <= 10, "emitted is clamped to the total");
            ffi::HAL_pulseOut_stop(0);

            // Guards: null pointer / negative channel → done == true, no write.
            assert!(ffi::HAL_pulseOut_run(0, std::ptr::null_mut()));
            assert!(ffi::HAL_pulseOut_run(-1, &mut emitted as *mut u32));
            ffi::HAL_pulseOut_start(-1, 1, 1); // no-op
            ffi::HAL_pulseOut_stop(-1); // no-op
        }
    }

    // ── Timer trampolines ──

    /// `HAL_time_*` route through the virtual clock; clock-freq matches the P2.
    #[test]
    fn timer_trampolines() {
        let _g = guard();
        setup();
        unsafe {
            assert_eq!(ffi::HAL_time_getClockFreq(), 180_000_000);
            let _ = ffi::HAL_time_getMs();
            let _ = ffi::HAL_time_getUs();
            let _ = ffi::HAL_time_getCycles();
            // Zero waits return immediately.
            ffi::HAL_time_waitMs(0);
            ffi::HAL_time_waitUs(0);
        }
    }

    // ── Lock trampolines ──

    /// `HAL_lock_*` allocate/acquire/release; a negative id is rejected.
    #[test]
    fn lock_trampolines() {
        let _g = guard();
        setup();
        unsafe {
            let id = ffi::HAL_lock_create();
            assert!(id >= 0);
            assert!(ffi::HAL_lock_try(id), "fresh lock acquires");
            ffi::HAL_lock_release(id);
            assert!(ffi::HAL_lock_try(id), "re-acquires after release");
            ffi::HAL_lock_release(id);
            assert!(!ffi::HAL_lock_try(-1), "negative id rejected");
        }
    }

    // ── System trampolines ──

    static THREAD_RAN: AtomicU32 = AtomicU32::new(0);

    unsafe extern "C" fn thread_body(_arg: *mut c_void) {
        THREAD_RAN.fetch_add(1, Ordering::SeqCst);
    }

    /// `HAL_system_startThread` spawns + runs the function; null function → -1.
    #[test]
    fn system_start_thread_runs_then_joins() {
        let _g = guard();
        setup();
        THREAD_RAN.store(0, Ordering::SeqCst);
        let id = unsafe {
            ffi::HAL_system_startThread(Some(thread_body), std::ptr::null_mut(), std::ptr::null_mut(), 0)
        };
        assert!(id >= 0, "got a core id");
        system::join_all_threads();
        assert_eq!(THREAD_RAN.load(Ordering::SeqCst), 1, "thread body ran");

        let bad = unsafe {
            ffi::HAL_system_startThread(None, std::ptr::null_mut(), std::ptr::null_mut(), 0)
        };
        assert_eq!(bad, -1, "null function pointer is rejected");
    }

    /// `HAL_system_init` is a safe no-op log. (`HAL_system_reboot` is NOT called —
    /// it terminates the process.)
    #[test]
    fn system_init_is_safe_noop() {
        let _g = guard();
        setup();
        unsafe { ffi::HAL_system_init() };
    }

    // ── I2C trampolines ──

    /// I2C trampolines delegate with a valid handle and return defaults (and no
    /// UB) on a null `self`.
    #[test]
    fn i2c_trampolines_delegate_and_guard_null() {
        let _g = guard();
        setup();
        let mut bus = i2c::I2C { scl: 0, sda: 0, khz: 0, pullup: 0 };
        unsafe {
            ffi::i2c_setup(&mut bus, 1, 2, 400, 1);
            ffi::i2c_start(&mut bus);
            assert!(!ffi::i2c_write(&mut bus, 0xAB), "stub write returns false");
            assert_eq!(ffi::i2c_read(&mut bus, true), 0, "stub read returns 0");
            ffi::i2c_stop(&mut bus);

            // Null handle: defaults, no dereference.
            assert!(!ffi::i2c_write(std::ptr::null_mut(), 0));
            assert_eq!(ffi::i2c_read(std::ptr::null_mut(), false), 0);
            ffi::i2c_setup(std::ptr::null_mut(), 0, 0, 0, 0);
            ffi::i2c_start(std::ptr::null_mut());
            ffi::i2c_stop(std::ptr::null_mut());
        }
    }

    // ── FlexC VFS + P2 intrinsic stubs ──

    /// `mount`/`umount` succeed for a valid C string and reject null; the VFS
    /// open returns null.
    #[test]
    fn flexc_vfs_stubs() {
        let _g = guard();
        let dir = std::env::temp_dir().join("embsim_p2_mount_test");
        let name = CString::new(dir.to_str().unwrap()).unwrap();
        unsafe {
            assert_eq!(stubs_flexc::mount(name.as_ptr(), std::ptr::null_mut()), 0);
            assert_eq!(stubs_flexc::umount(name.as_ptr()), 0);
            assert_eq!(stubs_flexc::mount(std::ptr::null(), std::ptr::null_mut()), -1);
            assert_eq!(stubs_flexc::umount(std::ptr::null()), -1);
            assert!(stubs_flexc::_vfs_open_sdcard().is_null());
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// `_clkset`/`_hubset` are no-ops. (`_reboot` is NOT called — it exits.)
    #[test]
    fn p2_intrinsic_stubs_are_noops() {
        let _g = guard();
        unsafe {
            stubs_p2::_clkset(0, 0);
            stubs_p2::_hubset(0);
        }
    }
}
