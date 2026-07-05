//! Integration coverage for the `embsim-runtime` entry abstraction.
//!
//! Two surfaces are exercised here:
//!
//! 1. **Pure / fallible builder logic** — `EmulatorError` Display strings, the
//!    `error::Error` impl, `PeripheralCounts::default()`, and every `build()`
//!    validation branch. These touch no globals and run freely in parallel.
//!
//! 2. **Full `run()` flows** — replicate `examples/minimal/src/main.rs`: a
//!    1-core `Platform`, a `Machine` that declares one GPIO + one serial
//!    channel and wires a `gpio::on_change`, an empty `FirmwareInfo`, and a
//!    no-op entry. `run()` initializes the *global* peripherals and creates a
//!    PTY, so these tests serialize on a crate-local `TEST_LOCK` and each uses a
//!    UNIQUE host-pty path under `std::env::temp_dir()`. They recover from lock
//!    poisoning the same way `pulse_out.rs` does.

use std::error::Error;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};

use embsim_memory_inspect::FirmwareInfo;
use embsim_peripherals::gpio;
use embsim_runtime::{Emulator, EmulatorError, Machine, PeripheralCounts, Platform};

// ============================================================
// Serialization for the global-touching full-run tests
// ============================================================

/// Any test that calls `Emulator::run` mutates process-global peripheral state
/// and creates a PTY — serialize them and recover from panic-induced poison.
static TEST_LOCK: Mutex<()> = Mutex::new(());

fn lock_or_recover() -> MutexGuard<'static, ()> {
    TEST_LOCK.lock().unwrap_or_else(|p| {
        TEST_LOCK.clear_poison();
        p.into_inner()
    })
}

/// Monotonic counter so each full-run test gets a distinct PTY symlink path,
/// avoiding collisions if two test binaries ever overlap on disk.
static PTY_SEQ: AtomicU32 = AtomicU32::new(0);

/// A unique, never-colliding host-pty path under the OS temp dir.
fn unique_pty_path(tag: &str) -> PathBuf {
    let n = PTY_SEQ.fetch_add(1, Ordering::Relaxed);
    let pid = std::process::id();
    std::env::temp_dir().join(format!("tty.embsim_rt_{tag}_{pid}_{n}"))
}

/// A unique sd-card directory under the OS temp dir (created so `filesystem::init`
/// has a real path to mount).
fn unique_sd_path(tag: &str) -> PathBuf {
    let n = PTY_SEQ.fetch_add(1, Ordering::Relaxed);
    let pid = std::process::id();
    let dir = std::env::temp_dir().join(format!("sd.embsim_rt_{tag}_{pid}_{n}"));
    std::fs::create_dir_all(&dir).expect("create sd temp dir");
    dir
}

// ============================================================
// Test fixtures: a minimal Platform + configurable Machine
// ============================================================

/// A 1-core platform mirroring `MiniPlatform` from the minimal example.
struct MiniPlatform;

impl Platform for MiniPlatform {
    fn clock_freq_hz(&self) -> u32 {
        1_000_000
    }
    fn max_cores(&self) -> usize {
        1
    }
    fn max_locks(&self) -> usize {
        1
    }
}

/// A configurable machine. `gpio`/`serial` counts and the set of
/// `required_symbols` are parameterized so a single type drives the happy path,
/// the `TooManyChannels` path, the `MissingSymbols` path, and the ordering hook
/// test. `wire_flag`/`wired_log` let a test observe wiring + ordering.
struct MiniMachine {
    gpio: usize,
    serial: usize,
    required: &'static [&'static str],
    /// Set to `true` inside `wire`, so a test can prove `wire` ran.
    wire_flag: Arc<AtomicU32>,
    /// Ordering log: each step pushes a tag so a test can assert the sequence
    /// (peripheral_counts -> host_serial_channel -> wire).
    order_log: Arc<Mutex<Vec<&'static str>>>,
}

impl MiniMachine {
    fn new() -> Self {
        Self {
            gpio: 1,
            serial: 1,
            required: &[],
            wire_flag: Arc::new(AtomicU32::new(0)),
            order_log: Arc::new(Mutex::new(Vec::new())),
        }
    }
}

impl Machine for MiniMachine {
    fn required_symbols(&self) -> &'static [&'static str] {
        self.required
    }

    fn peripheral_counts(&self, _fw: &FirmwareInfo) -> PeripheralCounts {
        self.order_log.lock().unwrap().push("counts");
        PeripheralCounts {
            gpio: self.gpio,
            serial: self.serial,
            ..Default::default()
        }
    }

    fn host_serial_channel(&self, _fw: &FirmwareInfo) -> usize {
        self.order_log.lock().unwrap().push("host_ch");
        0
    }

    fn wire(&self, _fw: &FirmwareInfo) {
        self.order_log.lock().unwrap().push("wire");
        self.wire_flag.store(1, Ordering::Relaxed);
        // Mirror the minimal example: register a gpio on_change callback. This
        // is the global-peripheral side effect that mandates the TEST_LOCK.
        gpio::on_change(0, |_level| {});
    }
}

// ============================================================
// 1. EmulatorError Display + std::error::Error impl
// ============================================================

/// Every `EmulatorError` variant renders a message containing its key text.
#[test]
fn emulator_error_display_strings() {
    let firmware = EmulatorError::Firmware("bad dwarf".to_string());
    assert!(firmware.to_string().contains("bad dwarf"));
    assert!(firmware.to_string().contains("firmware"));

    let missing_fw = EmulatorError::MissingFirmware;
    assert!(missing_fw.to_string().contains("no firmware"));
    // The message names the two ways to supply firmware.
    assert!(missing_fw.to_string().contains(".firmware"));

    let missing_machine = EmulatorError::MissingMachine;
    assert!(missing_machine.to_string().contains("no machine"));
    assert!(missing_machine.to_string().contains(".machine"));

    let missing_entry = EmulatorError::MissingEntry;
    assert!(missing_entry.to_string().contains("no firmware entry"));
    assert!(missing_entry.to_string().contains(".entry"));

    let missing_syms = EmulatorError::MissingSymbols(vec!["A_E".to_string(), "B_E".to_string()]);
    let msg = missing_syms.to_string();
    assert!(msg.contains("2"), "should report the count: {msg}");
    assert!(msg.contains("A_E") && msg.contains("B_E"), "should list each: {msg}");

    let too_many = EmulatorError::TooManyChannels {
        peripheral: "gpio",
        requested: 9999,
        max: 64,
    };
    let msg = too_many.to_string();
    assert!(msg.contains("gpio"));
    assert!(msg.contains("9999"));
    assert!(msg.contains("64"));

    let pty = EmulatorError::Pty(std::io::Error::new(std::io::ErrorKind::Other, "boom"));
    let msg = pty.to_string();
    assert!(msg.contains("PTY"));
    assert!(msg.contains("boom"));
}

/// `MissingSymbols` with an empty list still renders cleanly (count 0).
#[test]
fn missing_symbols_empty_list_displays_zero() {
    let e = EmulatorError::MissingSymbols(vec![]);
    let msg = e.to_string();
    assert!(msg.contains('0'), "count of 0 expected: {msg}");
}

/// `EmulatorError` is a real `std::error::Error` (usable as `Box<dyn Error>`).
#[test]
fn emulator_error_is_std_error() {
    fn as_error(e: EmulatorError) -> Box<dyn Error> {
        Box::new(e)
    }
    let boxed = as_error(EmulatorError::MissingMachine);
    // Exercise the trait-object path: Display flows through the Error impl.
    assert!(boxed.to_string().contains("no machine"));
    // source() defaults to None — confirm we can call it via the trait.
    assert!(boxed.source().is_none());
}

// ============================================================
// 2. PeripheralCounts::default()
// ============================================================

/// `PeripheralCounts::default()` is all-zero / `None`.
#[test]
fn peripheral_counts_default_is_zeroed() {
    let c = PeripheralCounts::default();
    assert_eq!(c.gpio, 0);
    assert_eq!(c.serial, 0);
    assert_eq!(c.encoder, 0);
    assert_eq!(c.pulse_out, 0);
    assert!(c.gpio_names.is_none());
    // Clone + Debug are derived; smoke-test them so they stay wired.
    let cloned = c.clone();
    assert_eq!(cloned.gpio, 0);
    assert!(format!("{c:?}").contains("PeripheralCounts"));
}

// ============================================================
// 3. build() validation branches (no globals touched)
// ============================================================

/// Assert a `build()` result is `Err` matching `$pat`, without requiring the
/// `Ok` (`Emulator`) variant to implement `Debug` (it does not).
fn assert_build_err(result: Result<Emulator, EmulatorError>, label: &str) -> EmulatorError {
    match result {
        Ok(_) => panic!("{label}: expected an error, got Ok"),
        Err(e) => e,
    }
}

/// `build()` with no machine -> `MissingMachine`. (No PTY is created.)
#[test]
fn build_without_machine_errors() {
    let err = assert_build_err(
        Emulator::builder(MiniPlatform)
            .firmware(FirmwareInfo::new())
            .entry(|| {})
            .build(),
        "no machine",
    );
    assert!(matches!(err, EmulatorError::MissingMachine), "got {err:?}");
}

/// `build()` with a machine but no entry -> `MissingEntry`.
#[test]
fn build_without_entry_errors() {
    let err = assert_build_err(
        Emulator::builder(MiniPlatform)
            .firmware(FirmwareInfo::new())
            .machine(Box::new(MiniMachine::new()))
            .build(),
        "no entry",
    );
    assert!(matches!(err, EmulatorError::MissingEntry), "got {err:?}");
}

/// `build()` with machine + entry but neither firmware nor firmware_lib ->
/// `MissingFirmware`.
#[test]
fn build_without_firmware_errors() {
    let err = assert_build_err(
        Emulator::builder(MiniPlatform)
            .machine(Box::new(MiniMachine::new()))
            .entry(|| {})
            .build(),
        "no firmware",
    );
    assert!(matches!(err, EmulatorError::MissingFirmware), "got {err:?}");
}

/// `build()` with a `firmware_lib` pointing at a nonexistent archive ->
/// `EmulatorError::Firmware(_)` (the parse fails before the PTY is created).
#[test]
fn build_with_bad_firmware_lib_errors() {
    let err = assert_build_err(
        Emulator::builder(MiniPlatform)
            .firmware_lib("/nonexistent/definitely/not/here/lib.a")
            .machine(Box::new(MiniMachine::new()))
            .entry(|| {})
            .build(),
        "bad firmware lib",
    );
    assert!(matches!(err, EmulatorError::Firmware(_)), "got {err:?}");
}

/// Validation order: machine is checked before entry. With neither, the FIRST
/// missing-piece error (`MissingMachine`) surfaces.
#[test]
fn build_reports_machine_before_entry() {
    let err = assert_build_err(
        Emulator::builder(MiniPlatform)
            .firmware(FirmwareInfo::new())
            .build(),
        "neither machine nor entry",
    );
    assert!(matches!(err, EmulatorError::MissingMachine), "got {err:?}");
}

// ============================================================
// 4. Full successful run() (touches global peripherals + PTY)
// ============================================================

/// A complete `build()? .run()?` over the minimal-example shape returns `Ok`,
/// runs the entry, and fires `wire`.
#[test]
fn full_run_succeeds_and_wires() {
    let _g = lock_or_recover();

    let machine = MiniMachine::new();
    let wire_flag = Arc::clone(&machine.wire_flag);
    let entry_ran = Arc::new(AtomicU32::new(0));
    let entry_ran2 = Arc::clone(&entry_ran);

    let pty = unique_pty_path("ok");
    let sd = unique_sd_path("ok");

    let result = Emulator::builder(MiniPlatform)
        .firmware(FirmwareInfo::new())
        .machine(Box::new(machine))
        .host_pty(pty.to_str().unwrap())
        .sd_path(sd.to_str().unwrap())
        .entry(move || {
            entry_ran2.store(1, Ordering::Relaxed);
        })
        .build()
        .expect("build should succeed")
        .run();

    assert!(result.is_ok(), "run() should be Ok: {result:?}");
    assert_eq!(wire_flag.load(Ordering::Relaxed), 1, "wire() must have run");
    assert_eq!(entry_ran.load(Ordering::Relaxed), 1, "entry must have run");
}

/// `Emulator::firmware()` borrows the parsed info after a successful build.
#[test]
fn emulator_exposes_firmware_after_build() {
    let _g = lock_or_recover();
    let pty = unique_pty_path("fwacc");

    let emu = Emulator::builder(MiniPlatform)
        .firmware(FirmwareInfo::new())
        .machine(Box::new(MiniMachine::new()))
        .host_pty(pty.to_str().unwrap())
        .sd_path(std::env::temp_dir().to_str().unwrap())
        .entry(|| {})
        .build()
        .expect("build should succeed");

    // Empty FirmwareInfo: no enum types present.
    assert!(!emu.firmware().has_enum_type("anything"));
    // Drop without run(); the PTY is cleaned up on drop.
}

/// `host_serial_baud` > 0 takes the baud-pacing branch in `run()` and still
/// returns `Ok`.
#[test]
fn full_run_with_baud_pacing_succeeds() {
    let _g = lock_or_recover();
    let pty = unique_pty_path("baud");
    let sd = unique_sd_path("baud");

    let result = Emulator::builder(MiniPlatform)
        .firmware(FirmwareInfo::new())
        .machine(Box::new(MiniMachine::new()))
        .host_pty(pty.to_str().unwrap())
        .sd_path(sd.to_str().unwrap())
        .host_serial_baud(230_400)
        .entry(|| {})
        .build()
        .expect("build should succeed")
        .run();

    assert!(result.is_ok(), "run() with baud pacing should be Ok: {result:?}");
}

// ============================================================
// 5. TooManyChannels (caught in run(), build() succeeds)
// ============================================================

/// A machine asking for 9999 gpio channels (> gpio::MAX_CHANNELS) builds fine
/// but `run()` returns `TooManyChannels { peripheral: "gpio", .. }`.
#[test]
fn run_rejects_too_many_gpio_channels() {
    let _g = lock_or_recover();
    let pty = unique_pty_path("toomany");

    let mut machine = MiniMachine::new();
    machine.gpio = 9999;

    let emu = Emulator::builder(MiniPlatform)
        .firmware(FirmwareInfo::new())
        .machine(Box::new(machine))
        .host_pty(pty.to_str().unwrap())
        .sd_path(std::env::temp_dir().to_str().unwrap())
        .entry(|| {})
        .build()
        .expect("build should succeed even with an over-large count");

    let err = emu.run().expect_err("run should reject the over-large count");
    match err {
        EmulatorError::TooManyChannels { peripheral, requested, max } => {
            assert_eq!(peripheral, "gpio");
            assert_eq!(requested, 9999);
            assert_eq!(max, gpio::MAX_CHANNELS);
            assert_eq!(max, 64);
        }
        other => panic!("expected TooManyChannels, got {other:?}"),
    }
}

// ============================================================
// 6. MissingSymbols preflight (before peripherals are touched)
// ============================================================

/// A machine whose `required_symbols` are absent from an empty `FirmwareInfo`
/// makes `run()` return `MissingSymbols` listing ALL of them — and it happens
/// in preflight, so even an absurd channel count never trips `TooManyChannels`.
#[test]
fn run_reports_all_missing_symbols_first() {
    let _g = lock_or_recover();
    let pty = unique_pty_path("missingsym");

    let mut machine = MiniMachine::new();
    machine.required = &["HAL_FOO_E", "HAL_BAR_E", "HAL_BAZ_VARIANT"];
    // Also make the count absurd: if preflight did NOT run first, this would
    // surface as TooManyChannels instead of MissingSymbols.
    machine.gpio = 9999;

    let emu = Emulator::builder(MiniPlatform)
        .firmware(FirmwareInfo::new())
        .machine(Box::new(machine))
        .host_pty(pty.to_str().unwrap())
        .sd_path(std::env::temp_dir().to_str().unwrap())
        .entry(|| {})
        .build()
        .expect("build should succeed");

    let err = emu.run().expect_err("run should fail preflight");
    match err {
        EmulatorError::MissingSymbols(names) => {
            assert_eq!(names.len(), 3, "all three missing names reported: {names:?}");
            assert!(names.contains(&"HAL_FOO_E".to_string()));
            assert!(names.contains(&"HAL_BAR_E".to_string()));
            assert!(names.contains(&"HAL_BAZ_VARIANT".to_string()));
        }
        other => panic!("expected MissingSymbols, got {other:?}"),
    }
}

// ============================================================
// 7. on_wired hook ordering (after wire, before entry)
// ============================================================

/// The `on_wired` hook fires after `wire()` and before the firmware entry.
#[test]
fn on_wired_runs_after_wire_and_before_entry() {
    let _g = lock_or_recover();
    let pty = unique_pty_path("onwired");
    let sd = unique_sd_path("onwired");

    let machine = MiniMachine::new();
    let order_log = Arc::clone(&machine.order_log);

    let log_for_hook = Arc::clone(&order_log);
    let log_for_entry = Arc::clone(&order_log);

    let result = Emulator::builder(MiniPlatform)
        .firmware(FirmwareInfo::new())
        .machine(Box::new(machine))
        .host_pty(pty.to_str().unwrap())
        .sd_path(sd.to_str().unwrap())
        .on_wired(move |_fw| {
            log_for_hook.lock().unwrap().push("on_wired");
        })
        .entry(move || {
            log_for_entry.lock().unwrap().push("entry");
        })
        .build()
        .expect("build should succeed")
        .run();

    assert!(result.is_ok(), "run() should be Ok: {result:?}");

    let log = order_log.lock().unwrap();
    let wire_idx = log.iter().position(|&s| s == "wire").expect("wire ran");
    let hook_idx = log.iter().position(|&s| s == "on_wired").expect("on_wired ran");
    let entry_idx = log.iter().position(|&s| s == "entry").expect("entry ran");

    assert!(wire_idx < hook_idx, "wire must precede on_wired: {log:?}");
    assert!(hook_idx < entry_idx, "on_wired must precede entry: {log:?}");

    // And the firmware-derived steps happened before wiring.
    let counts_idx = log.iter().position(|&s| s == "counts").expect("counts ran");
    let host_idx = log.iter().position(|&s| s == "host_ch").expect("host_ch ran");
    assert!(counts_idx < wire_idx, "peripheral_counts before wire: {log:?}");
    assert!(host_idx < wire_idx, "host_serial_channel before wire: {log:?}");
}

/// Without an `on_wired` hook, `run()` still completes (the hook is optional).
#[test]
fn run_without_on_wired_hook_succeeds() {
    let _g = lock_or_recover();
    let pty = unique_pty_path("nohook");
    let sd = unique_sd_path("nohook");

    let result = Emulator::builder(MiniPlatform)
        .firmware(FirmwareInfo::new())
        .machine(Box::new(MiniMachine::new()))
        .host_pty(pty.to_str().unwrap())
        .sd_path(sd.to_str().unwrap())
        .entry(|| {})
        .build()
        .expect("build should succeed")
        .run();

    assert!(result.is_ok(), "run() without on_wired should be Ok: {result:?}");
}
