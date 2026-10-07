# Rust / SIL Coding Guidelines

This document governs the Rust code in `SIL/` — the `mad-emulator` binary (`MaDSim/`), the reusable **embsim** emulator framework (`embsim/*`, a git submodule of [RileyMcCarthy/embsim](https://github.com/RileyMcCarthy/embsim) with its own workspace and CI), and the MaD-specific consumer crates (`protocol` — at `Protocol/rust/` — and `models`). It reflects the conventions actually used in the workspace as of this writing; follow it to write code that fits in and builds on the first try.

> Scope note: this is **not** the firmware (that's C under `Firmware/`, governed by MISRA/CERT) nor the control app (TypeScript). This is the host-side Software-in-the-Loop emulator.

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

- **Generic `embsim` crates** (`SIL/embsim`, its own workspace) — a board engine. A part is a node. Pins publish `Drive` and receive `Sense`. Host serial is `HostPty`. The crates know nothing about MaD's protocol or mechanics.
- **MaD-specific crates** — `protocol` (generated wire types, at `Protocol/rust/`), `models` (`SIL/models/`, gantry/sample/strain-gauge physics), `p2core` / `p2iss` (the instruction-set simulator as a board component), and `MaDSim` (the `mad-emulator` binary that wires the ISS, the bench, and the host PTY).

**Do** keep MaD concepts (steps/mm, ADC calibration, MaD protocol) out of `embsim/*`. The `protocol` crate keeps the codec in its own crate next to the schema, never inside a generic embsim crate (`Protocol/rust/src/lib.rs:1-8`). The `embsim-models` / `models` split mirrors this: reusable device models (the ADS122U04, the stepper, the end switch) live in `embsim/models`, while project mechanics (gantry/sample/strain gauge) live in `models` (`models/src/lib.rs:1-12`).

**Don't** add a dependency from an `embsim/*` crate onto `protocol`, `models`, `p2core`, or `p2iss`. Dependencies flow consumer → framework, never the reverse.

### Crate dependency direction

```
MaDSim (bin) ──► p2iss ──► p2core
   │          ──► embsim-board ──► embsim-core
   │          ──► embsim-models
   └──► models ──► embsim-models ──► embsim-core
```

The emulator executes the `propeller2_debug` image on the ISS. It does not link a host-compiled firmware library.

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
- **`lib.rs` is a thin re-export / module-list hub.** `embsim/core/src/lib.rs` is `pub mod event; pub mod serial_pty; pub mod virtual_clock;`. `embsim/board/src/lib.rs` re-exports the drive, sense, and `HostPty` types callers use.
- **Public items get `///` doc comments**, including `# Safety`, `# Panics`, and `# Usage` sections where relevant (see §5, §6).
- **Banner comments** delimit sections within a module — a fixed `=` rule:
  ```rust
  // ============================================================
  // Load-cell bridge
  // ============================================================
  ```
  (`MaDSim/src/system_description.rs`).
- **`mod` declarations and `use` blocks go at the top** (`MaDSim/src/main.rs`).
- Unicode box-drawing (`──`, `├──`, `└──`) is used in doc comments to draw data-flow diagrams (`p2iss/src/lib.rs`). Use it for a non-trivial seam.

---

## 4. Naming, types, derives, traits

- **Standard Rust casing**, applied uniformly: `snake_case` functions/modules/locals, `CamelCase` types/traits, `SCREAMING_SNAKE_CASE` consts/statics.
  - Consts: `pub const SLICE_NS: u64 = 100_000;` (`p2iss/src/lib.rs`) — note the digit separators.
- **Derive minimally and explicitly.** Generated enums derive `#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]` + `#[repr(u8)]` (`Protocol/rust/src/generated/protoemb.rs`). Derive only what a type uses.
- **Traits define the consumer seam.** A board part implements `embsim_board::Component` (`pins`, `attach`). The P2 package's core implements `P2Core` (`attach`, `start`, `reset`) when it sits inside `P2Package`. Trait methods that have a sane no-op default provide one.
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

## 5. `unsafe`

The emulator does not link host-compiled firmware and does not provide HAL trampolines. The firmware under test is the P2 image, executed by `p2core`. `unsafe` in the MaD crates is the edge where Rust talks to the OS: the shutdown signal handler in `MaDSim/src/main.rs`, and PTY file descriptors inside embsim's `HostPty`.

**Do:**
- Keep `unsafe` at that OS edge. A signal handler may only touch async-signal-safe operations (the shutdown handler stores to an atomic) and says so in a `// SAFETY:` comment.
- Put a `# Safety` section on a public `unsafe fn`, stating the caller's obligation.

**Don't** add an `extern "C"` entry point for `mad_begin`, and don't link `libfirmware.a`. A new peripheral is a board component with pins, not a HAL symbol.

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

A component's `on_sense` callback runs on the engine thread. Anything that callback shares with another thread is `Arc` plus an atomic or a `Mutex`.

- **Use `Ordering::Relaxed`** for monotonic counters and flags (`p2iss`'s edge-drop counter, `models/src/edge.rs`). Don't reach for a stronger ordering on a single cell that nothing else synchronizes with.
- **Callbacks are `impl Fn(...) + Send + 'static`.** `ComponentNetIo::on_sense` and `on_wake_ns` take that shape. `Observers<T>::subscribe` appends (`embsim/core/src/event.rs`). The lock is held across observer calls, so an observer must not re-enter the same `Observers`.
- Share state into a `move` closure with `Arc::clone` taken before the closure, not by moving the only handle.
- **`std::sync::Mutex` is the default** (`embsim-core`'s `Observers`, a component's wire state). `parking_lot` stays in the tools that already use it. Reach for it only where that behavior is the point; otherwise use `std::sync`.

> HAL locks in the firmware are not reentrant, and a module must not call another module while holding its own lock (root `CLAUDE.md`). A board component follows the same rule: don't call back into the engine in a way that re-enters the callback that is running.

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
- **MaDSim has a Chrome-free PTY smoke** at `MaDSim/tests/pty_protocol.rs`: spawn `mad-emulator` on a unique PTY, send a `firmware_version` READ, expect a DATA frame. It skips when the `propeller2_debug` image is absent. Product behaviour still lives in `Software/Control/e2e/`.
- The playground PTY (`/tmp/tty.rpi`) is single-instance — don't run `make playground` / `make e2e-emulator` / `npm run e2e` at the same time. The PTY smoke uses a temp path and can run beside other `cargo test`s.
- Run Rust tests with `cargo test` from `SIL/` (MaD-side crates) or from `SIL/embsim/` (the framework submodule's own workspace). CI runs both: the `sil-rust` job gates fmt + clippy `-D warnings` + `cargo test` on `SIL/`; the embsim repo's own CI (mirrored by `embsim-ci` / `embsim-pin-ci`) gates the submodule (see §10).

---

## 10. Linting & passing checks

> **CI reality check:**
> - The `sil-rust` job in `.github/workflows/ci.yml` builds the `propeller2_debug` image + `make protocol`, then **gates** `cargo fmt -p mad-emulator -p models --check`, `cargo clippy --workspace --all-targets -- -D warnings`, and `cargo test --workspace --all-targets`.
> - The generated `protocol` crate is **excluded from rustfmt** (`make protocol` rewrites it every build). Clippy allows for template-style lints are scoped to `Protocol/rust/src/lib.rs`, never crate-wide.
> - The `SIL/embsim` submodule is re-tested here by `embsim-ci` (build/test/doc). Pin bumps also run `embsim-pin-ci`: rustfmt, clippy `-D warnings`, `cargo doc -D warnings`, 5× determinism goldens, cargo-deny, MSRV. Upstream: [RileyMcCarthy/embsim](https://github.com/RileyMcCarthy/embsim).

### What you must do
1. **Build clean, warning-free:**
   ```bash
   cd SIL
   cargo build            # the workspace. The P2 image is a runtime input, not a link input.
   cargo test             # runs unit + doctests; ISS tests skip when the image is absent
   ```
   `make test` builds the image first (`pio run -e propeller2_debug`) so those tests actually run:
   ```bash
   make test              # = make p2image + make protocol + cargo test
   ```
2. **Format the crates CI checks** before pushing:
   ```bash
   cargo fmt -p mad-emulator -p models
   cargo fmt -p mad-emulator -p models --check
   ```
   **Do not** `cargo fmt --all` / `cargo fmt --workspace` — that would rewrite the generated `protocol` crate, which `make protocol` immediately clobbers. Match neighbors for anything those two packages do not cover (4 spaces, ~100-col wrap, `std` imports first).
3. **Run clippy locally before sending a PR** — it **gates** with `-D warnings`:
   ```bash
   cargo clippy --workspace --all-targets -- -D warnings
   ```

### Lint-suppression policy
- **Crate-level blanket allows are only for generated code** (`Protocol/rust/src/generated/protoemb.rs:6`). Do not add `#![allow(...)]` to hand-written crates.
- If you must silence a clippy lint locally, scope it to the smallest item and prefer fixing over allowing. The only blanket allows observed in the tree are the three the generator emits (`dead_code`, `clippy::identity_op`, `clippy::excessive_precision`).

### Do / Don't summary
- **Do** add new third-party deps to `[workspace.dependencies]`, then reference `dep.workspace = true`.
- **Do** keep `unsafe`/`extern "C"` confined to the platform crate's `ffi.rs`/stubs and guard every channel/pointer.
- **Do** give every public item a `///` doc, with `# Safety`/`# Panics` where applicable.
- **Do** run `cargo fmt -p mad-emulator -p models --check`, `cargo clippy --workspace --all-targets -- -D warnings`, and `cargo test` locally before pushing — `sil-rust` gates all three.
- **Don't** edit `Protocol/rust/src/generated/` — regenerate via `make protocol`.
- **Don't** introduce `anyhow`/`thiserror`; follow the hand-rolled `enum + Display + Error` pattern.
- **Don't** run repo-wide `cargo fmt --all` — it fights generated protocol code. Format `mad-emulator` and `models` only.
- **Don't** put MaD-specific logic in `embsim/*` generic crates, or add a dependency edge from `embsim/*` onto the MaD consumer crates. embsim changes land upstream (github.com/RileyMcCarthy/embsim) first, then the submodule pin is bumped here.
