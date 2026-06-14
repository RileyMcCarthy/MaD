# embsim

A generic **software-in-the-loop (SIL) emulator framework** for embedded firmware.

embsim links your real firmware C code against Rust implementations of its
hardware-access (HAL) layer, plus emulated peripherals and physical models, so
the firmware runs unmodified on a host with **no physical hardware**. Host
software (a desktop app, a test harness) talks to the emulated serial port
through a `/dev` PTY symlink, exactly as it would to a real board.

It was extracted from the [MaD](../../..) tensile tester but is designed to be
reused: the `core`, `peripherals`, `models`, `runtime`, and `tools` crates carry
no MaD- or Propeller-2-specific assumptions. A new project supplies a *platform
crate* and a *machine*, and gets a runnable emulator.

## Crate layering

```
                 ┌──────────────────────────────────────────────┐
   consumer      │  your-emulator (binary)  +  your Machine impl │
   (project)     └───────────────┬──────────────────────────────┘
                                 │
   platform      ┌───────────────▼──────────────┐   #[no_mangle] HAL trampolines
   (per-MCU)     │  embsim-p2  (or your-platform)│   + Platform impl (constants)
                 └───────────────┬──────────────┘
                                 │
   framework     ┌───────────────▼──────────────┐
                 │        embsim-runtime         │   Emulator builder + Platform/Machine traits
                 └───────┬───────────────┬──────┘
                         │               │
          ┌──────────────▼──┐   ┌────────▼─────────┐
          │ embsim-peripherals│   │   embsim-models  │   GPIO/serial/encoder/…   device & IC models
          └──────────────┬──┘   └────────┬─────────┘   + EdgeDetector
                         │               │
                 ┌───────▼───────────────▼──────┐
                 │          embsim-core          │   virtual clock · serial PTY · event (Observers)
                 └───────────────────────────────┘

   tools (beside the stack):  memory-inspect (DWARF reader) · trace (live viewer) ·
                              ui (web shell) · build-support (firmware linking)
```

The dependency graph is acyclic: **no generic crate depends on a project crate.**
MaD-specific code lives in `MaDSim/`, `embsim-mad-models/`, and `mad-protocol/`.

## What a new project provides

Just two things:

### 1. A platform crate — `#[no_mangle]` HAL trampolines + a `Platform`

Your firmware calls C functions like `HAL_GPIO_setActive`. A platform crate
provides a Rust `#[no_mangle] extern "C"` function for each, delegating to the
generic peripheral, and implements the `Platform` trait to supply MCU constants:

```rust
pub struct MyMcu;
impl embsim_runtime::Platform for MyMcu {
    fn clock_freq_hz(&self) -> u32 { 16_000_000 }
    fn max_cores(&self)    -> usize { 1 }
    fn max_locks(&self)    -> usize { 8 }
}
```

See [`CONTRACT.md`](CONTRACT.md) for the full list of symbols a platform must
export and the ABI rules, and `embsim-p2` for a complete reference.

### 2. A `Machine` — the project wiring

The machine declares peripheral channel counts and connects peripheral events to
physical models:

```rust
impl embsim_runtime::Machine for MyMachine {
    fn peripheral_counts(&self, fw: &FirmwareInfo) -> PeripheralCounts { /* ... */ }
    fn host_serial_channel(&self, fw: &FirmwareInfo) -> usize { /* ... */ }
    fn wire(&self, fw: &FirmwareInfo) { /* register callbacks, set initial states */ }
}
```

### Then the whole emulator is ~10 lines

```rust
let fw = FirmwareInfo::from_archive("path/to/libfirmware.a")?;
Emulator::builder(MyMcu)
    .firmware(fw)
    .machine(Box::new(MyMachine))
    .clock_speed(1.0)
    .host_pty("/tmp/tty.sim_client")
    .sd_path("./sd")
    .entry(|| unsafe { firmware_begin() })
    .build()?
    .run()?;
```

The **runtime owns the init ordering** (clock before peripherals; `serial::init`
before bridging the PTY; …) so consumers can't get it wrong. It also preflights
every symbol the machine declares in `required_symbols()` and reports *all*
missing ones at once (`EmulatorError::MissingSymbols`) — invaluable when porting
to firmware whose enums were renamed.

A complete, runnable, firmware-free template is in
[`examples/minimal/`](examples/minimal/src/main.rs) — `cargo run -p embsim-minimal-example`.

## One firmware per OS process (by construction)

The firmware HAL is bound through process-global `#[no_mangle]` symbols against a
single `libfirmware.a`. **There is therefore exactly one firmware per OS
process.** To run several instances, run several processes (the MaD Playwright
suite does this with `workers: 1`). Do **not** try to instance-scope the HAL
layer — the Rust statics in `peripherals` are not the constraint; the single C
symbol set is. (The host-side *tools* — trace store, UI registry — are separate
and may be reset between runs.)

## Building & running (MaD reference)

From `SIL/`:

```bash
make emulator     # build firmware (.a) + protocol + bridge, then cargo build
make test         # emulator + Playwright E2E
make playground    # run the emulator + app for manual testing
cargo build -p mad-emulator       # just the emulator binary
cargo run -p embsim-minimal-example   # the firmware-free template
```

The firmware archive location can be overridden without editing `build.rs` via
`EMBSIM_FIRMWARE_LIB_DIR` / `EMBSIM_FIRMWARE_LIB_NAME` (see the `embsim-build`
crate).
