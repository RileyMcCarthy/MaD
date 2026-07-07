# Rust / SIL Coding Guidelines

This document governs the Rust code in `SIL/` — the `mad-emulator` binary (`MaDSim/`), the reusable **embsim** emulator framework (`embsim/*`, a git submodule of [RileyMcCarthy/embsim](https://github.com/RileyMcCarthy/embsim) with its own workspace and CI), and the MaD-specific consumer crates (`protocol` — at `Protocol/rust/` — and `models`). It reflects the conventions actually used in the workspace as of this writing; follow it to write code that fits in and builds on the first try.

> Scope note: this is **not** the firmware (that's C under `Firmware/`, governed by MISRA/CERT) nor the desktop app (TypeScript). This is the host-side Software-in-the-Loop emulator.

---

## 1. Workspace & crate layout

The workspace is a Cargo workspace with `resolver = "2"`, `edition = "2021"`, and centralized versions. See `SIL/Cargo.toml`.

```toml
[workspace]
members = [
    # Out-of-tree member: the generated Rust codec lives at Protocol/rust/,
    # next to its schema (its Cargo.toml points back via `workspace`).
    "../Protocol/rust",
    "models",
    "MaDSim",
]
# embsim is a git submodule with its own workspace root; its crates are
# consumed as path dependencies across the workspace boundary.
exclude = ["embsim"]
resolver = "2"
```

The embsim submodule has the same shape (workspace root at `SIL/embsim/Cargo.toml` with the generic crates as members); run `cargo test --workspace` *inside* `SIL/embsim/` to test the framework, and in `SIL/` to test the MaD-side crates.

There is a hard architectural split, called out in the Cargo comments and crate docs:

- **Generic, reusable `embsim` crates** (`embsim/*`) — know *nothing* about MaD. They simulate a generic MCU: clock, PTY serial, GPIO/encoder/pulse-out peripherals, the `Emulator` builder, DWARF introspection, trace/UI tooling.
- **MaD-specific consumer crates** — `protocol` (generated wire types, at `Protocol/rust/`), `models` (`SIL/models/`, gantry/sample/strain-gauge physics), and `MaDSim` (the `mad-emulator` binary that wires it all together).

**Do** keep MaD concepts (steps/mm, ADC calibration, MaD protocol) out of `embsim/*`. The `protocol` crate keeps the codec in its own crate next to the schema, never inside a generic embsim crate (`Protocol/rust/src/lib.rs:1-8`). The wiring header calls `MaDSim/src/wiring.rs` "the project-specific seam" where all MaD constants live (`wiring.rs:1-7`). The `embsim-models` / `models` split mirrors this: reusable device/IC models (e.g. the ADS122U04, `EdgeDetector`) live in `embsim/models`, while project mechanics (gantry/sample/strain gauge) live in `models` (`embsim/models/src/lib.rs:13-14`, `models/src/lib.rs:1-12`).

**Don't** add a dependency from an `embsim/*` crate onto `protocol` or `models`. Dependencies flow consumer → framework, never the reverse (verified: no `embsim/*` Cargo.toml lists either MaD crate).

### Crate dependency direction
Verified from the member `Cargo.toml` files. The `embsim-runtime` crate **defines** the `Platform`/`Machine` traits; the platform crate `embsim-p2` *depends on* `embsim-runtime` to implement `Platform` — the arrow points platform → runtime, not the reverse.

```
MaDSim (bin) ──► embsim-runtime ──► embsim-peripherals ──► embsim-core
   │          ──► embsim-p2 ──────► embsim-runtime (impls its Platform trait)
   │          ──► embsim-memory-inspect, embsim-trace, embsim-ui (tools)
   └──► models ──► embsim-models ──► embsim-core
```

> `protocol` is a workspace member but **no crate in the workspace depends on it** (not even `MaDSim`). It is a standalone leaf with an empty `[dependencies]` table, built/tested on its own so its generated roundtrip tests stay compiled (`Protocol/rust/Cargo.toml`, `Protocol/rust/src/lib.rs:3-7`). Don't draw a dependency edge into it that doesn't exist.

---

## 2. Cargo.toml conventions

- **Inherit shared metadata** from the workspace. Reusable crates use `version.workspace = true`, `edition.workspace = true`, `license.workspace = true`, `repository.workspace = true` (e.g. `embsim/core/Cargo.toml:3-6`).
- **MaD-specific / non-publishable crates set `publish = false`** and omit `license`/`repository` (see `MaDSim/Cargo.toml:6`, `Protocol/rust/Cargo.toml:6`, `models/Cargo.toml:6`).
- **All external dep versions live in `[workspace.dependencies]`** (`Cargo.toml:30-42`) and are referenced as `tracing.workspace = true` / `clap.workspace = true`. **Do not** pin a third-party version inline in a member crate — add it to the workspace table to prevent drift.
- **Intra-workspace deps use `path = "..."`** (e.g. `embsim-core = { path = "../core" }`).
- Reusable crates fill in `description`, `keywords`, and `categories` (they are packaged as if they could be published — `embsim/core/Cargo.toml:7-9`).
- **Optional/web features are gated.** The `web` feature pulls in axum/tokio/UI; the headless build drops them. The pattern, verbatim from `embsim/tools/trace/Cargo.toml:11-16`:
  ```toml
  [features]
  default = ["web"]
  web = ["dep:axum", "dep:tokio", "dep:embsim-ui"]
  ```
  The `mad-emulator` binary uses the same shape but a wider set — its `web` feature also forwards `embsim-trace/web` and pulls `serde_json` (`MaDSim/Cargo.toml:8-12`). Mirror this `default = ["web"]` / `dep:` pattern when adding optional web surface.

---

## 3. Module organization & doc comments

Every source file opens with a `//!` crate/module doc comment explaining *what it is and the design rationale* — not just a one-liner. Examples:

```rust
//! embsim-core — Core infrastructure for embedded MCU simulation.
//!
//! Provides MCU-agnostic primitives shared by all platform crates:
//! - `virtual_clock` — scalable time for deterministic emulation
//! - `serial_pty` — PTY pair creation for host ↔ firmware serial communication
//! - `event` — multi-subscriber callback primitive for model/peripheral events
```
(`embsim/core/src/lib.rs:1-6`)

**Conventions:**
- **`lib.rs` is a thin re-export / module-list hub.** `embsim/core/src/lib.rs` is just `pub mod event; pub mod serial_pty; pub mod virtual_clock;`. Platform crates re-export peripheral modules for convenience: `pub use embsim_peripherals::{encoder, filesystem, gpio, i2c, lock, pulse_out, serial, system, timer};` (`embsim/platforms/p2/src/lib.rs:17`).
- **Public items get `///` doc comments**, including `# Safety`, `# Panics`, and `# Usage` sections where relevant (see §5, §6). Constants are documented too: `/// Propeller 2 clock frequency (180 MHz).` (`platforms/p2/src/lib.rs:23`).
- **Banner comments** delimit sections within a module — a fixed `=` rule used consistently:
  ```rust
  // ============================================================
  // GPIO
  // ============================================================
  ```
  (`platforms/p2/src/ffi.rs:8-10`). Peripheral modules use the same banners for `Initialization`, `Core API`, `Wiring API`, etc. (`peripherals/src/gpio.rs:26-28, 65-67, 118-120`).
- **`mod` declarations and `use` blocks go at the top**, `cfg`-gated mods first where applicable (`MaDSim/src/main.rs:1-12` — the two `#[cfg(feature = "web")] mod ...` lines precede the `use` block).
- Unicode box-drawing (`──`, `├──`, `└──`) is used in doc comments to draw callback/data-flow diagrams (`MaDSim/src/wiring.rs:8-30`). This is idiomatic here — use it for non-trivial wiring.

---

## 4. Naming, types, derives, traits

- **Standard Rust casing**, applied uniformly: `snake_case` functions/modules/locals, `CamelCase` types/traits, `SCREAMING_SNAKE_CASE` consts/statics.
  - Consts: `const STEPS_PER_MM: f64 = (4 * 2048) as f64;` (`wiring.rs:45`), `pub const P2_CLOCK_FREQ: u32 = 180_000_000;` (`platforms/p2/src/lib.rs:24`) — note the digit separators.
  - Statics: `static CHANNEL_COUNT: AtomicUsize` (`peripherals/src/gpio.rs:11`), `static GPIO_STATE: [AtomicBool; MAX_CHANNELS]` (`gpio.rs:14-17`).
- **FFI functions keep the C name verbatim** — they are *not* renamed to snake_case, because they must match the firmware HAL symbol: `HAL_GPIO_setActive`, `HAL_serial_transmitData` (`platforms/p2/src/ffi.rs`). The firmware also names some functions in their original (mis)spelling — match them exactly, e.g. `HAL_serial_recieveByte` / `HAL_serial_recieveDataTimeout` (`ffi.rs:67,85`). These compile clean; add `#[allow]` only if a lint actually complains.
- **Zero-sized handle structs** for platforms: `pub struct P2;` with `#[derive(Debug, Clone, Copy, Default)]` (`platforms/p2/src/lib.rs:39-40`). The MaD machine handle is also zero-sized but carries **no derive** — it's a bare `pub struct MadMachine;` (`wiring.rs:48`). Derive only what a type actually needs (see next bullet); don't add derives reflexively.
- **Derive minimally and explicitly.** Plain data/config structs derive what they need, e.g. `#[derive(Debug, Clone, Default)]` for `PeripheralCounts` (`runtime/src/lib.rs:50`). Generated enums derive `#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]` + `#[repr(u8)]` (`Protocol/rust/src/generated/protoemb.rs:17-18`).
- **Traits define the consumer seam.** The framework exposes capability via traits the project implements: `Platform` (MCU constants) and `Machine` (project wiring), defined in `embsim/runtime/src/lib.rs:39` and `:69`. Trait methods that have a sane no-op default provide one (`required_symbols` returns `&[]`, `runtime/src/lib.rs:76-78`).
- **`impl Default` is written by hand when `new()` is `const`** so a type can back a `static`:
  ```rust
  pub const fn new() -> Self { Self { subs: Mutex::new(Vec::new()) } }
  // ...
  impl<T> Default for Observers<T> {
      fn default() -> Self { Self::new() }
  }
  ```
  (`embsim/core/src/event.rs:36-38, 72-76`). The `const fn new` pattern recurs (`models/src/edge.rs:17`) — prefer it for primitives that may live in statics.

---

## 5. FFI & `unsafe`

This is the heart of the SIL layer: the firmware is compiled to `libfirmware.a` and linked in; the platform crate provides the HAL symbols it calls, and the binary calls the firmware entry point.

### `extern "C"` trampolines (firmware → Rust)
HAL functions are `#[no_mangle] pub unsafe extern "C"` and **delegate immediately** to a safe generic peripheral function. The C side passes `i32` channels; the trampoline **guards the channel and any pointer before touching it**, then narrows to `usize`:

```rust
#[no_mangle]
pub unsafe extern "C" fn HAL_serial_transmitData(
    channel: i32,
    data: *const u8,
    len: u32,
) {
    if data.is_null() || len == 0 || channel < 0 {
        return;
    }
    let buf = std::slice::from_raw_parts(data, len as usize);
    serial::transmit_data(channel as usize, buf);
}
```
(`platforms/p2/src/ffi.rs:53-64`)

**Do:**
- Keep all `unsafe extern "C"` HAL glue in the platform crate (`embsim/platforms/p2/src/ffi.rs`, `stubs_p2.rs`, `stubs_flexc.rs`). The header of `ffi.rs:1-3` states the rule: "Each function delegates to the generic peripheral implementation in `embsim-peripherals`." Generic crates stay safe and free of `extern "C"`.
- Reject bad inputs at the boundary (`channel < 0`, null ptr, zero len) and return a safe default — every trampoline in `ffi.rs` does this (scalar-returning ones return `false`/`0`; `HAL_pulseOut_run` returns `true` = "done" on bad input, `ffi.rs:138-139`).
- Convert raw pointers to slices with `std::slice::from_raw_parts[_mut]` *only after* the null/len guard.
- Keep the firmware-facing name exact (`_clkset`, `_hubset`, `_reboot` for P2 intrinsics — `stubs_p2.rs:8,12,16`).

**Don't** spread `unsafe` into APP-equivalent logic — the trampoline is the only place the boundary is crossed; everything downstream (`gpio::set_active`, etc.) is safe.

### Calling firmware (Rust → C)
The entry point is declared and called in the binary:
```rust
extern "C" {
    fn mad_begin();
}
// ...
.entry(|| unsafe { mad_begin() })
```
(`MaDSim/src/main.rs:48-49, 77`)

### `# Safety` on public `unsafe fn`
Public `unsafe` functions that aren't `extern "C"` trampolines carry a `# Safety` doc section stating the caller's obligation:
```rust
/// Start a new thread. Returns the thread/core ID (>= 0) or -1 on failure.
///
/// # Safety
/// The function pointer and argument must be valid for the lifetime of the thread.
pub unsafe fn start_thread(...) -> i32 { ... }
```
(`embsim/peripherals/src/system.rs:58-62`). The other files that document `# Safety` are `peripherals/src/filesystem.rs` (`mount`/`umount`, `:20,39`) and `tools/memory-inspect/src/runtime.rs` (`read_bytes`/`read_field`/`read_field_as_f64`, `:123,151,205`) — these are the only three files in the tree that use `# Safety`.

> Note: the HAL `extern "C"` trampolines in `ffi.rs` are `unsafe` but do **not** carry `# Safety` docs — the safety contract is the HAL ABI itself, documented at the module level (`ffi.rs:1-3`). Match that existing pattern: `# Safety` on standalone `unsafe fn` APIs, module-doc justification for the ABI glue.

### Linking the firmware library
Every emulator binary's `build.rs` defers to `embsim-build`:
```rust
fn main() {
    embsim_build::link_firmware_static(
        "../../Firmware/MaDCore/.pio/build/native_emulator",
        "firmware",
    );
}
```
(`MaDSim/build.rs:14-19`). `link_firmware_static` honors `EMBSIM_FIRMWARE_LIB_DIR` / `EMBSIM_FIRMWARE_LIB_NAME` overrides and emits the `cargo:rustc-link-*` directives (`embsim/build-support/src/lib.rs:42-71`). **Do not** hand-write `cargo:rustc-link-lib` in a member crate — call the helper.

---

## 6. Error handling & panic policy

**No `anyhow`/`thiserror`** — verified absent from every `Cargo.toml` and `.rs` in the workspace. Error handling is std-only and hand-rolled. The runtime defines its own error enum with a manual `Display` impl and a marker `impl std::error::Error`:

```rust
#[derive(Debug)]
pub enum EmulatorError {
    Firmware(String),
    MissingFirmware,
    MissingMachine,
    MissingEntry,
    MissingSymbols(Vec<String>),
    TooManyChannels { peripheral: &'static str, requested: usize, max: usize },
    Pty(std::io::Error),
}

impl fmt::Display for EmulatorError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            EmulatorError::Firmware(e) => write!(f, "failed to parse firmware debug info: {e}"),
            // ...
        }
    }
}
impl std::error::Error for EmulatorError {}
```
(`embsim/runtime/src/lib.rs:93-143`)

**Conventions:**
- **Library/framework crates return `Result<T, ConcreteError>`** and propagate with `?`. Internal helpers return `Result<(), EmulatorError>` (`runtime/src/lib.rs:149`). I/O wrappers return `std::io::Result<T>` (`embsim/core/src/serial_pty.rs:26`).
- **`fn main` returns `Result<(), Box<dyn std::error::Error>>`** and uses `?` to bubble up; it does not `unwrap` the top-level flow (`MaDSim/src/main.rs:52, 61, 85-86`).
- **Use the bare `{var}` capture form** in format/`write!` strings (`write!(f, "... {e}")` at `runtime/src/lib.rs:122`; `warn!("MAD_SIM_BAUD={raw:?} ...")` at `main.rs:145`). Prefer this over positional `{}` + trailing args for new code. (Older modules like `gpio.rs`/`system.rs` still use positional `{}` in `assert!`/`trace!`; new code should use the capture form.)
- **`panic!` is reserved for unrecoverable build/setup misconfiguration**, and is documented with a `# Panics` section. `embsim-build` panics with an *actionable* message when the firmware lib is missing, explicitly because it "should fail loudly rather than produce a binary with unresolved HAL symbols" (`build-support/src/lib.rs:38-66`).
- **`.expect()` carries a descriptive message**, used for genuine invariants: `set_global_default(subscriber).expect("Failed to set tracing subscriber")` (`main.rs:129-130`), `PROCESS_ORIGIN.get().expect("Virtual clock not initialized")` (`core/src/virtual_clock.rs:54`).
- **`assert!` guards `init` invariants** with a message: `assert!(count <= MAX_CHANNELS, "GPIO count {} exceeds max {}", count, MAX_CHANNELS)` (`peripherals/src/gpio.rs:34`; same pattern in `system.rs:38`).
- **`.lock().unwrap()` on a `Mutex` is accepted** for poison propagation throughout peripheral/event code (`event.rs:42`, `gpio.rs:37`). Don't invent custom poison handling — match the existing `.lock().unwrap()` idiom.

**Don't** add `anyhow`/`thiserror` without a workspace-level decision — it would diverge from every existing crate.

---

## 7. Concurrency

The emulator runs firmware "cogs" as OS threads, so peripheral state is shared and must be thread-safe by construction.

- **Module-global peripheral state lives in `static`s** using atomics for hot scalars and `Mutex` for collections:
  ```rust
  static CHANNEL_COUNT: AtomicUsize = AtomicUsize::new(0);
  static GPIO_STATE: [AtomicBool; MAX_CHANNELS] = {
      const INIT: AtomicBool = AtomicBool::new(false);
      [INIT; MAX_CHANNELS]
  };
  static CALLBACKS: Mutex<Vec<Option<Box<dyn Fn(bool) + Send>>>> = Mutex::new(Vec::new());
  ```
  (`peripherals/src/gpio.rs:11-21`). The `Mutex::new(Vec::new())` / `AtomicX::new(..)` / array-of-`const INIT` const-init pattern is required because these are `static`.
- **Use `Ordering::Relaxed`** for the simple state flags throughout peripherals/models (`gpio.rs`, `models/src/edge.rs:24`). The codebase does not reach for stronger orderings on these single-value cells.
- **Callbacks are `Box<dyn Fn(T) + Send + 'static>`**; register with `impl Fn(...) + Send + 'static` (`gpio::on_change`, `gpio.rs:133`; `Observers::subscribe`, `event.rs:41`).
- **Prefer the `Observers<T>` event primitive over a bare callback slot** when more than one sink may listen — its whole reason for existing is that `subscribe` *appends* instead of overwriting, unlike `gpio::on_change` which keeps only one callback per channel (`event.rs:1-11`, `gpio.rs:131-142`). Note its documented contract: the lock is held across observer calls, so **observers must not re-enter the same `Observers`** (`event.rs:64-65`).
- In the wiring layer, share mutable state across closures via `Arc<Atomic*>` + `Arc::clone`, taking a fresh clone into each `move` closure scope:
  ```rust
  let enc_base = Arc::new(AtomicI32::new(0));
  { let enc_base = Arc::clone(&enc_base); pulse_out::on_start(servo_pulse_out, move |_, _| { enc_base.store(...); }); }
  ```
  (`MaDSim/src/wiring.rs:203-214`).
- **`std::sync::Mutex` is the default** in `embsim-core` and most of `embsim-peripherals` (`event.rs`, `gpio.rs`, `system.rs`). The one deliberate exception is the lock pool: `peripherals/src/lock.rs` uses `parking_lot::Mutex<()>` (`lock.rs:1-6,18-21`), and the `ui`/`trace` tools also use `parking_lot`. `parking_lot` is in `[workspace.dependencies]`; reach for it only where (like `lock.rs`) you need its behavior — otherwise use `std::sync`.

> Cross-reference the firmware locking rules in the root `CLAUDE.md` when modeling HAL locks — the emulator mirrors the firmware's cog/lock model (`P2_MAX_COGS = 8`, `P2_MAX_LOCKS = 32`, `platforms/p2/src/lib.rs:27-30`). The `lock.rs` pool is non-recursive on purpose, matching the firmware's non-reentrant HAL locks (`lock.rs:3-4`).

---

## 8. Generated code — do not edit

`Protocol/rust/src/generated/protoemb.rs` is produced by the ProtoEmb generator. Its header is unambiguous:

```rust
//! Auto-generated protocol definitions — DO NOT EDIT
//!
//! Generated by ProtoEmb code generator from YAML schema
//! Protocol version: 1

#![allow(dead_code, clippy::identity_op, clippy::excessive_precision)]
```
(`Protocol/rust/src/generated/protoemb.rs:1-6`)

**Rules:**
- **Never hand-edit `Protocol/rust/src/generated/`.** Change `Protocol/MaDProtocol.yaml` (or the templates) and regenerate with `make protocol`, which runs the Python generator with `--target rs --output ./Protocol/rust/src/generated` (`makefile:32-33`). (Note: the makefile and the actual tree put the Rust types in `Protocol/rust/src/generated/`; no `generated/` dir exists under `embsim/peripherals/src/`, despite what some older docs imply.)
- The crate-level `#![allow(dead_code, clippy::identity_op, clippy::excessive_precision)]` belongs to the generator output — **do not** copy these blanket allows into hand-written crates. Only generated code wears them.
- `Protocol/rust/src/lib.rs` re-exports the generated module (`#[path = "generated/protoemb.rs"] pub mod protoemb; pub use protoemb::*;`, `lib.rs:9-12`). Keep generated types behind this thin facade.

---

## 9. Tests

- **Unit tests live in an inline `#[cfg(test)] mod tests` block** at the bottom of the file under test, with `use super::*;`:
  ```rust
  #[cfg(test)]
  mod tests {
      use super::*;
      #[test]
      fn reports_only_on_transitions() {
          let e = EdgeDetector::new(false);
          assert_eq!(e.update(false), None);       // no change
          assert_eq!(e.update(true), Some(true));  // rising
          assert_eq!(e.update(true), None);        // held
          assert_eq!(e.update(false), Some(false));// falling
          assert!(!e.state());
      }
  }
  ```
  (`embsim/models/src/edge.rs:44-57`). Other inline test modules: `peripherals/src/pulse_out.rs`, `tools/memory-inspect/src/{runtime,types}.rs`.
- **Doctests double as documentation.** Public primitives carry a runnable ` ``` ` example in their `//!`/`///` docs (`event.rs:13-25`). Mark non-runnable examples ` ```rust,ignore ` (`build-support/src/lib.rs:10`, `runtime/src/lib.rs:16`).
- **End-to-end behavior is covered by Playwright**, not Rust integration tests — they drive the real Electron UI against the running emulator (`SIL/tests/`, run via `make test` → `npm test`). The emulator is single-instance; honor `workers: 1` (see root `CLAUDE.md`).
- Run Rust tests with `cargo test` from `SIL/` (MaD-side crates) or from `SIL/embsim/` (the framework submodule's own workspace). CI runs both: the `sil-rust` job gates `cargo test` on `SIL/`, and the embsim repo's own CI gates the submodule (see §10).

---

## 10. Linting & passing checks

> **CI reality check:**
> - The `sil-rust` job in `.github/workflows/ci.yml` builds `libfirmware.a` + `make protocol`, runs `cargo clippy` (advisory — a lint backlog remains) and **`cargo test --workspace --all-targets` (blocking)** on `SIL/`.
> - The `SIL/embsim` submodule is gated by [its own repo's CI](https://github.com/RileyMcCarthy/embsim): tests + doctests on Linux/macOS, **gating `cargo fmt --check`** (that tree is rustfmt-formatted), advisory clippy, and `cargo doc -D warnings`.
> - The MaD-side crates (`MaDSim`, `models`, `protocol`) have **no fmt gate**: there is no `rustfmt.toml` under `SIL/`, and running a blanket `cargo fmt` there still produces a large unrelated diff. Match the existing hand-maintained style (short struct literals and bodies on one line, ~100–110-column lines).

### What you must do
1. **Build clean, warning-free:**
   ```bash
   cd SIL
   cargo build            # builds the whole workspace (needs libfirmware.a — see below)
   cargo test             # runs unit + doctests
   ```
   The emulator binary links `libfirmware.a`; build it first or `cargo build` will fail at link time (the `build.rs` panics with an actionable message if the lib is missing):
   ```bash
   make emulator          # = pio firmware lib + make protocol + make bridge + cargo build
   ```
2. **Match the surrounding format by hand.** Mirror the existing file's indentation (4 spaces), brace style (short single-expression bodies on one line), import grouping (`std` first, then external/workspace crates — see `wiring.rs:32-42`, `runtime/src/lib.rs:29-36`), and ~100-col soft wrap. **Do not** run a blanket `cargo fmt` on the repo — it will produce a massive unrelated diff. If you do format, scope it tightly:
   ```bash
   cargo fmt -- src/your_new_file.rs   # format only what you added, then eyeball it
   ```
   *(Recommended, not yet adopted: the project would benefit from committing a `rustfmt.toml` and gating `cargo fmt --check` in CI. Until that exists, treat the existing nearby code as the format spec.)*
3. **Run clippy locally before sending a PR** and fix what it flags in code you touched:
   ```bash
   cargo clippy --workspace --all-targets
   ```
   *(CI runs clippy on `SIL/` as advisory only — the pre-existing backlog isn't cleared yet — but new code should be clippy-clean.)*

### Lint-suppression policy
- **Crate-level blanket allows are only for generated code** (`Protocol/rust/src/generated/protoemb.rs:6`). Do not add `#![allow(...)]` to hand-written crates.
- If you must silence a clippy lint locally, scope it to the smallest item and prefer fixing over allowing. The only blanket allows observed in the tree are the three the generator emits (`dead_code`, `clippy::identity_op`, `clippy::excessive_precision`).

### Do / Don't summary
- **Do** add new third-party deps to `[workspace.dependencies]`, then reference `dep.workspace = true`.
- **Do** keep `unsafe`/`extern "C"` confined to the platform crate's `ffi.rs`/stubs and guard every channel/pointer.
- **Do** give every public item a `///` doc, with `# Safety`/`# Panics` where applicable.
- **Do** run `cargo build`/`cargo test`/`clippy` locally before pushing — the `sil-rust` CI job gates `cargo test` on `SIL/`.
- **Don't** edit `Protocol/rust/src/generated/` — regenerate via `make protocol`.
- **Don't** introduce `anyhow`/`thiserror`; follow the hand-rolled `enum + Display + Error` pattern.
- **Don't** run repo-wide `cargo fmt` — format only your additions and match neighbors.
- **Don't** put MaD-specific logic in `embsim/*` generic crates, or add a dependency edge from `embsim/*` onto the MaD consumer crates. embsim changes land upstream (github.com/RileyMcCarthy/embsim) first, then the submodule pin is bumped here.
