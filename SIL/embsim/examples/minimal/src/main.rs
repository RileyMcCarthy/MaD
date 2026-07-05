//! The smallest possible embsim consumer — an onboarding template.
//!
//! A real emulator links a firmware `.a`, provides a platform crate of
//! `#[no_mangle]` HAL trampolines, and a `Machine` that wires physical models.
//! This example strips all of that away to show the *shape* of the entry API:
//! a hand-rolled [`Platform`] + [`Machine`] + an empty `FirmwareInfo` + a no-op
//! firmware entry. It compiles and runs (the no-op entry returns immediately, so
//! `run()` just initializes peripherals, wires, and exits).
//!
//! Run it:  `cargo run -p embsim-minimal-example`
//!
//! To turn this into a real emulator you would:
//!   1. Build your firmware as a static library and link it (see `embsim-build`).
//!   2. Write a platform crate of `#[no_mangle] extern "C"` HAL trampolines
//!      (see `embsim-p2` and `embsim/CONTRACT.md`).
//!   3. Replace `MiniMachine` with real channel counts + model wiring.
//!   4. Pass `FirmwareInfo::from_archive(path)` instead of `::new()`, and a real
//!      `.entry(|| unsafe { my_firmware_begin() })`.

use embsim_memory_inspect::FirmwareInfo;
use embsim_peripherals::gpio;
use embsim_runtime::{Emulator, Machine, PeripheralCounts, Platform};

/// MCU constants for our imaginary 1-core part. A real project gets these from
/// a platform crate (e.g. `embsim_p2::P2`).
struct MiniPlatform;

impl Platform for MiniPlatform {
    fn clock_freq_hz(&self) -> u32 {
        1_000_000 // 1 MHz
    }
    fn max_cores(&self) -> usize {
        1
    }
    fn max_locks(&self) -> usize {
        1
    }
}

/// The project wiring. A real `Machine` resolves channel counts from firmware
/// DWARF info and builds a graph of physical models; this one just declares one
/// GPIO + one serial channel and logs GPIO writes.
struct MiniMachine;

impl Machine for MiniMachine {
    // `required_symbols` defaults to none — this machine never looks up firmware
    // enums, so there is nothing for the runtime to preflight.

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
        // Fan firmware GPIO-0 writes out to a log line. A real machine would
        // instead drive a physical model (motor, LED, relay, …).
        gpio::on_change(0, |level| {
            println!("[mini] firmware set GPIO 0 = {level}");
        });
    }
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    Emulator::builder(MiniPlatform)
        // No real firmware: an empty FirmwareInfo. A real consumer passes
        // `.firmware(FirmwareInfo::from_archive(path)?)` or `.firmware_lib(path)`.
        .firmware(FirmwareInfo::new())
        .machine(Box::new(MiniMachine))
        .host_pty("/tmp/tty.embsim_minimal")
        .sd_path("/tmp")
        // A real entry calls into linked firmware: `|| unsafe { fw_begin() }`.
        // This no-op returns immediately, so `run()` initializes + wires + exits.
        .entry(|| {
            println!("[mini] firmware entry — a real firmware would loop here");
        })
        .build()?
        .run()?;
    Ok(())
}
