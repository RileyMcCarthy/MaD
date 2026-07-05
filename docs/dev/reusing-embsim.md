# Reusing embsim

**embsim** is the generic SIL framework that powers MaD's emulator. It was
extracted from MaD specifically to be reused: the `core`, `peripherals`, `models`,
`runtime`, and `tools` crates carry **no MaD- or Propeller-2-specific
assumptions**. This page is a pointer for using it on another project.

## What you provide

A new project supplies just two things:

1. **A platform crate** — `#[no_mangle] extern "C"` HAL trampolines (one per C
   HAL function your firmware calls, delegating to the generic peripheral) plus a
   `Platform` impl that supplies MCU constants:

    ```rust
    impl embsim_runtime::Platform for MyMcu {
        fn clock_freq_hz(&self) -> u32 { 16_000_000 }
        fn max_cores(&self)    -> usize { 1 }
        fn max_locks(&self)    -> usize { 8 }
    }
    ```

2. **A `Machine`** — declares peripheral channel counts and wires peripheral
   events to physical models:

    ```rust
    impl embsim_runtime::Machine for MyMachine {
        fn peripheral_counts(&self, fw: &FirmwareInfo) -> PeripheralCounts { /* … */ }
        fn host_serial_channel(&self, fw: &FirmwareInfo) -> usize { /* … */ }
        fn wire(&self, fw: &FirmwareInfo) { /* register callbacks, initial states */ }
    }
    ```

Then the emulator is about ten lines (load the firmware archive, build, run). The
runtime owns the init ordering and preflights every required symbol, reporting all
missing ones at once.

## Reference material

- [`SIL/embsim/README.md`](https://github.com/RileyMcCarthy/MaD/blob/main/SIL/embsim/README.md)
  — the framework overview and the ~10-line emulator.
- [`SIL/embsim/CONTRACT.md`](https://github.com/RileyMcCarthy/MaD/blob/main/SIL/embsim/CONTRACT.md)
  — the exact list of symbols a platform must export and the ABI rules.
- `SIL/embsim/examples/minimal/` — a complete, firmware-free template:
  `cargo run -p embsim-minimal-example`.

## How MaD uses it

MaD's own consumer code is the reference implementation, isolated in three crates:

| Crate | Role |
|---|---|
| `embsim/platforms/p2` (`embsim-p2`) | Propeller 2 HAL trampolines + `Platform` |
| `embsim-mad-models` | MaD physics: gantry, sample, strain gauge |
| `mad-protocol` | Generated MaD protocol types |
| `MaDSim` | The `mad-emulator` binary + the MaD `Machine` wiring |

The dependency graph is acyclic — no generic crate depends on a project crate —
which is what keeps embsim reusable. See the
[SIL emulator](../how-it-works/sil-emulator.md) page for the crate diagram.

!!! note "One firmware per process"
    The HAL binds to a single `libfirmware.a` through process-global symbols, so
    there is exactly one firmware per OS process. Run multiple processes to run
    multiple instances; don't try to instance-scope the HAL.
