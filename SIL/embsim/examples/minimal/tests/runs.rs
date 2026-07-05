//! Keep the onboarding template runnable.
//!
//! The example is a binary, so its `main()` is not importable from an
//! integration test. We instead replicate the exact flow `main()` performs —
//! `MiniPlatform` + `MiniMachine` + an empty `FirmwareInfo` + a no-op entry —
//! against a UNIQUE host-pty/sd path under `std::env::temp_dir()`, and assert
//! the emulator builds and `run()`s to `Ok`. This guards against the template
//! silently rotting as the runtime API evolves.
//!
//! `run()` touches process-global peripheral state and creates a PTY; this is
//! the only test in the crate that does so, but we still guard with a
//! `TEST_LOCK` for robustness if more are added later, and recover from poison
//! the way `pulse_out.rs` does.

use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Mutex, MutexGuard};

use embsim_memory_inspect::FirmwareInfo;
use embsim_peripherals::gpio;
use embsim_runtime::{Emulator, Machine, PeripheralCounts, Platform};

static TEST_LOCK: Mutex<()> = Mutex::new(());

fn lock_or_recover() -> MutexGuard<'static, ()> {
    TEST_LOCK.lock().unwrap_or_else(|p| {
        TEST_LOCK.clear_poison();
        p.into_inner()
    })
}

static SEQ: AtomicU32 = AtomicU32::new(0);

fn unique_path(tag: &str) -> PathBuf {
    let n = SEQ.fetch_add(1, Ordering::Relaxed);
    let pid = std::process::id();
    std::env::temp_dir().join(format!("tty.embsim_minex_{tag}_{pid}_{n}"))
}

/// Verbatim copy of the example's `MiniPlatform`.
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

/// Verbatim copy of the example's `MiniMachine`.
struct MiniMachine;

impl Machine for MiniMachine {
    fn peripheral_counts(&self, _fw: &FirmwareInfo) -> PeripheralCounts {
        PeripheralCounts {
            gpio: 1,
            serial: 1,
            ..Default::default()
        }
    }

    fn host_serial_channel(&self, _fw: &FirmwareInfo) -> usize {
        0
    }

    fn wire(&self, _fw: &FirmwareInfo) {
        gpio::on_change(0, |level| {
            // Same shape as the example, but silent in tests.
            let _ = level;
        });
    }
}

/// The minimal example flow builds and runs to completion.
#[test]
fn minimal_example_flow_runs_ok() {
    let _g = lock_or_recover();
    let pty = unique_path("ok");

    let result = Emulator::builder(MiniPlatform)
        .firmware(FirmwareInfo::new())
        .machine(Box::new(MiniMachine))
        .host_pty(pty.to_str().unwrap())
        .sd_path(std::env::temp_dir().to_str().unwrap())
        .entry(|| {
            // A real firmware would loop here; the no-op returns immediately.
        })
        .build()
        .expect("minimal example should build")
        .run();

    assert!(result.is_ok(), "minimal example run() should be Ok: {result:?}");
}
