# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

MaD is a low-cost open-source uniaxial tensile testing machine. The monorepo has these main parts:

- **Firmware** (`Firmware/MaDCore/`) — Embedded C for the Parallax Propeller 2
- **Software** (`Software/Control/`) — the **shipped, deployed** control app: a frontend-only browser PWA (React + Vite, Web Serial + WebAssembly).
- **SIL** (`SIL/`) — Software-in-the-loop: a Rust workspace (`MaDSim`, `models`, and the out-of-tree `protocol` crate at `Protocol/rust/`). The reusable emulator framework at `SIL/embsim/` is a **git submodule** → [RileyMcCarthy/embsim](https://github.com/RileyMcCarthy/embsim).
- **Protocol** (`Protocol/`) — YAML schema (`MaDProtocol.yaml`) → generated C / TypeScript / Rust. The toolchain at `Protocol/ProtoEmb/` is a **git submodule** → [RileyMcCarthy/protoemb](https://github.com/RileyMcCarthy/protoemb). The shipped app runs the protocol logic as **WebAssembly** (compiled from `Protocol/ProtoEmb/runtime`).
- **Hardware** (`Hardware/`) — KiCad PCB designs

Submodules must be initialized before building: `git submodule update --init --recursive` (or clone with `--recurse-submodules`).

## Coding Guidelines

Per-language coding standards (grounded in this codebase, with the exact lint/check rules) live in [`docs/coding-guidelines/`](docs/coding-guidelines/README.md). Read the guide for whatever you're touching before writing code:

- [C / Firmware](docs/coding-guidelines/c-firmware.md) — naming, template/banner layout, MISRA C:2023 + CERT idioms, HAL locking discipline
- [TypeScript / React](docs/coding-guidelines/typescript.md) — TS/React conventions, ESLint, strict `tsconfig`, and the Web Worker + WASM boundary.
- [Rust / SIL](docs/coding-guidelines/rust.md) — workspace layout, FFI/`unsafe` HAL boundary, error handling
- [Python (protocol generator)](docs/coding-guidelines/python.md) — `generate.py` conventions, Jinja2 templates
- [Protocol YAML](docs/coding-guidelines/protocol-yaml.md) — `MaDProtocol.yaml` authoring + the regenerate-all-three-targets workflow

## Build & Development Commands

### Firmware (from `Firmware/MaDCore/`)
```bash
pio run -e propeller2           # Build for hardware
pio run -e propeller2_debug     # Build with debug serial
pio run -e propeller2 -t upload # Upload to board
pio run -e native_emulator      # Build libfirmware.a for SIL (no main.c; Rust is entry + HAL)
pio test -e native_test         # Run Unity unit tests
pio check -e propeller2 --fail-on-defect=medium --fail-on-defect=high  # MISRA/cppcheck (low disabled)
```

### Software (from `Software/Control/`) — the shipped app
```bash
npm install            # First-time setup
npm run build:wasm     # Compile the Rust protocol core → src/wasm/ (needs wasm-pack + wasm32-unknown-unknown)
npm run generate:proto # Generate the TS codec → src/protocol/generated/ from the YAML schema
npm run dev            # Dev server on http://localhost:5174
npm run app            # Dev server + open your real browser (real Web Serial → hardware)
npm run build          # Typecheck + production PWA bundle → dist/
npm run lint           # ESLint (flat config)
npm test               # Vitest unit tests (codec + domain + diagnostics)
npm run verify         # tsc + eslint + tests + build — the offline CI gate
npm run e2e            # node e2e/run-all.mjs — drives the SIL emulator (fakes live in e2e/, never src/)
```

### SIL Testing (from `SIL/`)
```bash
make firmware     # Firmware static library only
make protocol     # Regenerate the Rust codec into ../Protocol/rust/src/generated
make emulator     # firmware + protocol, then cargo build workspace
make test         # emulator + `cargo test`
make playground   # `cargo run --bin mad-emulator` + SD path ./sd, PTY /tmp/tty.rpi (see makefile for flags)
make clean        # Remove build artifacts
```

### Protocol Code Generation
```bash
# From repo root:
python3 ./Protocol/ProtoEmb/core/generate.py --schema ./Protocol/MaDProtocol.yaml --target c  --output ./Firmware/MaDCore/src/Generated --templates ./Protocol/ProtoEmb/core/templates
python3 ./Protocol/ProtoEmb/core/generate.py --schema ./Protocol/MaDProtocol.yaml --target ts --output ./Software/Control/src/protocol/generated --templates ./Protocol/ProtoEmb/core/templates
python3 ./Protocol/ProtoEmb/core/generate.py --schema ./Protocol/MaDProtocol.yaml --target rs --output ./Protocol/rust/src/generated --templates ./Protocol/ProtoEmb/core/templates
# The shipped app regenerates its TS target via `npm run generate:proto`; the firmware regenerates its C target via the `platformio.ini` pre-hook (`extra_scripts/generate_protocol.py`).
```

## Architecture

### Firmware Layered Architecture (strict — each layer only calls the layer below)
```
APP/      — Application logic, state machines (control, motion, monitor, notifications)
DEV/      — Device drivers (stepper, force gauge, cog manager, NVRAM, watchdog)
IO/       — Protocols & peripheral drivers (serial protocol, G-code, ADS122U04)
Library/  — Small shared utilities (e.g. timer, static queue) — no upward deps
HAL/      — Hardware abstraction — `HAL/P2/` on device; headers in `HAL/Include/`
HW/       — Board / MCU helpers (e.g. `HW/P2/` for production builds)
Generated/— Code-generated protocol encode/decode (from YAML — do not hand-edit)
```

Configuration lives in `Config/` subfolders (e.g. `DEV/Config/dev_cogManager_config.h`).

### Machine State Machine
```
DISABLED → RESTRICTED → MANUAL
               │           │
               └─────────→ TEST
```
All motion is gated through `app_control_motionEnabled()`. States, faults, and restrictions are defined in `APP/app_control.h`.

### Propeller 2 Multi-Core (COGs)
The P2 has 8 cores. `dev_cogManager` allocates tasks across cores with watchdog integration. Channels are defined in `DEV/Config/dev_cogManager_config.h` using `DEV_COGMANAGER_CHANNEL_CREATE_INIT/RUN` macros.

### Software (Control) Architecture
Frontend-only browser PWA — the browser talks straight to the Propeller 2 over the **Web Serial API**; protocol logic runs as **WebAssembly** compiled from the same Rust core (`Protocol/ProtoEmb/runtime`) used by the firmware tooling and SIL.

- **Web Worker** (`src/device/DeviceSession.worker.ts`): owns the serial read loop and all protocol work so the ~100 Hz sample stream never blocks rendering. Reads `port.readable` → `wasm.feed_bytes()`; `wasm.poll()` → decode → events → store; `wasm.take_outgoing()` → `port.writable`. The port is opened on the main thread (user gesture required) and its streams are transferred to the worker.
- **Main-thread client** (`src/device/session.ts`) ↔ worker via **Comlink**.
- **State**: **Zustand** store (`src/store/`) + an out-of-React `liveBuffer`; uPlot live charts in `src/ui/`.
- **Pure logic** (`src/domain/`): G-code build/transform, sample→CSV, proto↔display mapping.
- **Persistence** (`src/storage/`): `DataStore` over the **File System Access API** (mirrors the desktop data-folder layout).
- **Protocol**: generated TS codec in `src/protocol/generated/`; `wasm-pack` output in `src/wasm/`.
- **Purity rule**: `src/` uses only Web Serial + File System Access. Test-only fakes (SIL serial, OPFS) live in `e2e/`, **never** in `src/`.
- **Chromium-only**: Web Serial + File System Access are Chrome/Edge desktop only.


### SIL Emulator Architecture
Rust **Cargo workspace** under `SIL/` (see `SIL/Cargo.toml`; members are the MaD-side crates — `MaDSim`, `models`, and `protocol` (an out-of-tree member living at `Protocol/rust/`, next to its schema). The `embsim/*` crates below live in the `SIL/embsim` submodule, which is its own workspace, and are consumed as path deps):

- **`MaDSim/`** — `mad-emulator` binary: links **`libfirmware.a`** from `pio run -e native_emulator`, calls `mad_begin()`, wires PTY serial, SD path, optional trace HTTP port.
- **`embsim/core`** — PTY, timing, shared plumbing.
- **`embsim/peripherals`** — HAL stand-ins (serial, GPIO, pulse trains, encoder, etc.).
- **`protocol`** (at `Protocol/rust/`, next to the schema) — **generated** Rust codec under `src/generated/` (do not hand-edit; `make protocol`). Imported by nothing; exists so the generated code + roundtrip tests stay compiled in `cargo test`.
- **`embsim/platforms/p2`** — FFI / stubs linking firmware into the emulator.
- **`embsim/models`** — Physics-style models (e.g. gantry, force path, sampling).
- **`embsim/tools/*`** — trace viewer, memory inspect, UI shell helpers.

End-to-end coverage lives with the app it exercises: `Software/Control/e2e/` drives the shipped app against this emulator.

### Communication Protocol
Firmware ↔ UI communicates over serial (2,000,000 baud on hardware) using the generated protocol from `Protocol/MaDProtocol.yaml`. Motion profiles become G-code (`G0`, `G1`, `G4`, `G28`, `G90`, `G91`, `G122`) and are streamed line-by-line.

## Firmware Naming & File Conventions

Files are prefixed with their layer: `IO_protocol.c`, `dev_stepper.c`, `app_control.c`, `lib_timer.c`. Use `src/template.ch` / `src/template.cx` for new files — standard section layout (includes, constants, typedefs, APIs, etc.).

## CI/CD & Releases

Releases are triggered by pushing version tags:
```bash
git tag webapp-v1.0.0   && git push --tags   # Deploy the shipped app + docs to GitHub Pages
git tag firmware-v1.0.0 && git push --tags   # Firmware release
git tag hardware-v1.0.0 && git push --tags   # Hardware release
```

## Key Constraints

- **Firmware layer violations**: Do not include or call low-level MCU headers from APP/DEV/IO — go through HAL (and appropriate HW headers only where HAL already depends on them).
- **Thread safety**: `IO_protocol` and shared protocol/JSON buffers are not casually thread-safe from multiple cogs — use the project locking patterns where applicable.
- **Locking rules**: `lib_staticQueue` (and Library data structures generally) are unsynchronized — the owning module wraps ops in its own HAL lock when its topology needs one (SPSC use is lock-free by contract). HAL locks are **not reentrant**, and a module must **never call another module's API while holding its own lock** (prevents both self-deadlock and cross-cog ABBA deadlocks).
- **Native vs P2**: Always exercise `native_emulator` / `native_test`; pointer sizes and timing differ from the Propeller 2.
- **SIL concurrency**: Treat the emulator as single-instance — don't run two emulator-backed suites at once.
- **G-code**: Profiles/tests that must signal completion to firmware should end appropriately (e.g. **`G122`** where the firmware contract requires it).
- **Generated code**: Do not hand-edit `Firmware/MaDCore/src/Generated/`, `Software/Control/src/protocol/generated/`, or `Protocol/rust/src/generated/` — change `Protocol/MaDProtocol.yaml` (or templates) and regenerate.
- **Submodules** (`SIL/embsim`, `Protocol/ProtoEmb`): library changes land upstream ([embsim](https://github.com/RileyMcCarthy/embsim), [protoemb](https://github.com/RileyMcCarthy/protoemb)) — commit + push there (their own CI gates them), then bump the pinned commit here in a MaD PR. Don't leave a MaD PR pointing at an unpushed submodule commit. `SIL/Cargo.toml` `exclude`s `embsim` (the submodule is its own Cargo workspace); its crates are consumed as path deps.
