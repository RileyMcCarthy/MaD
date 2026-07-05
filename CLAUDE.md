# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

MaD is a low-cost open-source uniaxial tensile testing machine. The monorepo has these main parts:

- **Firmware** (`Firmware/MaDCore/`) — Embedded C for the Parallax Propeller 2
- **Software** (`Software/MaDWasmControl/`) — the **shipped, deployed** control app: a frontend-only browser PWA (React + Vite, Web Serial + WebAssembly). A legacy Electron app at `Software/MaDControl/` is **frozen** and retained only as the current SIL Playwright E2E driver (see [Software Architecture](#software-madwasmcontrol-architecture)).
- **SIL** (`SIL/`) — Software-in-the-loop: Rust workspace (`MaDSim` + `embsim`) + Playwright E2E tests
- **Protocol** (`Protocol/ProtoEmb/`) — YAML schema (`MaDProtocol.yaml`) → generated C / TypeScript / Rust. The shipped app runs the protocol logic as **WebAssembly** (compiled from `Protocol/ProtoEmb/runtime`); the legacy Electron app spoke to a Rust **protoemb-bridge** child process.
- **Hardware** (`Hardware/`) — KiCad PCB designs

## Coding Guidelines

Per-language coding standards (grounded in this codebase, with the exact lint/check rules) live in [`docs/coding-guidelines/`](docs/coding-guidelines/README.md). Read the guide for whatever you're touching before writing code:

- [C / Firmware](docs/coding-guidelines/c-firmware.md) — naming, template/banner layout, MISRA C:2023 + CERT idioms, HAL locking discipline
- [TypeScript / React](docs/coding-guidelines/typescript.md) — TS/React conventions, ESLint, strict `tsconfig`. (Currently documents the legacy Electron app; the shipped `MaDWasmControl` uses the same TS/React conventions with a flat ESLint config and a Web Worker + WASM boundary instead of Electron IPC.)
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
pio check                       # MISRA C:2023 + CERT compliance check
```

### Software (from `Software/MaDWasmControl/`) — the shipped app
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
> **Legacy Electron app** (`Software/MaDControl/`, frozen): `npm install` (postinstall: check-native-dep + electron-builder + build:dll), `npm start` (hot reload), `npm run package` (→ release/build/), `npm run lint:fix`, `npm test` (Jest). Only touch it for SIL Playwright E2E upkeep until that suite is ported to the WASM app.

### SIL Testing (from `SIL/`)
```bash
make setup        # First-time: npm deps
make firmware     # Firmware static library only
make protocol     # Regenerate Rust protocol types into mad-protocol/src/generated
make bridge       # Build protoemb-bridge (Protocol/ProtoEmb/runtime) — used by the legacy Electron app / its E2E
make emulator     # firmware + protocol + bridge, then cargo build workspace
make test         # emulator + Playwright (`npm test`)
make playground   # `cargo run --bin mad-emulator` + SD path ./sd, PTY /tmp/tty.rpi (see makefile for flags)
make clean        # Remove build artifacts
```

### Protocol Code Generation
```bash
# From repo root:
python3 ./Protocol/ProtoEmb/core/generate.py --schema ./Protocol/MaDProtocol.yaml --target c  --output ./Firmware/MaDCore/src/Generated --templates ./Protocol/ProtoEmb/core/templates
python3 ./Protocol/ProtoEmb/core/generate.py --schema ./Protocol/MaDProtocol.yaml --target ts --output ./Software/MaDWasmControl/src/protocol/generated --templates ./Protocol/ProtoEmb/core/templates
python3 ./Protocol/ProtoEmb/core/generate.py --schema ./Protocol/MaDProtocol.yaml --target rs --output ./SIL/mad-protocol/src/generated --templates ./Protocol/ProtoEmb/core/templates
# The shipped app regenerates its TS target via `npm run generate:proto`; the firmware regenerates its C target via the `platformio.ini` pre-hook (`extra_scripts/generate_protocol.py`).
# (The legacy Electron app's TS target was ./Software/MaDControl/src/main/generated.)
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

### Software (MaDWasmControl) Architecture
Frontend-only browser PWA — **no backend, no Electron**. The browser talks straight to the Propeller 2 over the **Web Serial API**; protocol logic runs as **WebAssembly** compiled from the same Rust core (`Protocol/ProtoEmb/runtime`) used by the firmware tooling and SIL.

- **Web Worker** (`src/device/DeviceSession.worker.ts`): owns the serial read loop and all protocol work so the ~100 Hz sample stream never blocks rendering. Reads `port.readable` → `wasm.feed_bytes()`; `wasm.poll()` → decode → events → store; `wasm.take_outgoing()` → `port.writable`. The port is opened on the main thread (user gesture required) and its streams are transferred to the worker.
- **Main-thread client** (`src/device/session.ts`) ↔ worker via **Comlink**.
- **State**: **Zustand** store (`src/store/`) + an out-of-React `liveBuffer`; uPlot live charts in `src/ui/`.
- **Pure logic** (`src/domain/`): G-code build/transform, sample→CSV, proto↔display mapping.
- **Persistence** (`src/storage/`): `DataStore` over the **File System Access API** (mirrors the desktop data-folder layout).
- **Protocol**: generated TS codec in `src/protocol/generated/`; `wasm-pack` output in `src/wasm/`.
- **Purity rule**: `src/` uses only Web Serial + File System Access. Test-only fakes (SIL serial, OPFS) live in `e2e/`, **never** in `src/`.
- **Chromium-only**: Web Serial + File System Access are Chrome/Edge desktop only.

> **Legacy Electron app** (`Software/MaDControl/`, frozen): Electron main process (`src/main/handlers/`: `BridgeHandler.ts` ran the `protoemb-bridge` child process; `DeviceInterface.ts` wired bridge events → renderer) + React renderer (`src/renderer/hooks/useDevice.tsx`) over `ipcRenderer.invoke()`. Retained only as the current SIL Playwright E2E driver until that suite is ported to the WASM app.

### SIL Emulator Architecture
Rust **Cargo workspace** under `SIL/` (see `SIL/Cargo.toml`):

- **`MaDSim/`** — `mad-emulator` binary: links **`libfirmware.a`** from `pio run -e native_emulator`, calls `mad_begin()`, wires PTY serial, SD path, optional trace HTTP port.
- **`embsim/core`** — PTY, timing, shared plumbing.
- **`embsim/peripherals`** — HAL stand-ins (serial, GPIO, pulse trains, encoder, etc.).
- **`mad-protocol`** — **generated** Rust protocol types under `src/generated/` (do not hand-edit; `make protocol`).
- **`embsim/platforms/p2`** — FFI / stubs linking firmware into the emulator.
- **`embsim/models`** — Physics-style models (e.g. gantry, force path, sampling).
- **`embsim/tools/*`** — trace viewer, memory inspect, UI shell helpers.

Playwright tests in `SIL/tests/` currently drive the legacy **Electron** UI against the emulator (config uses a single worker where the emulator is single-instance) — porting them to the shipped WASM app is the open decommission task. The WASM app also has its own emulator-driven harness in `Software/MaDWasmControl/e2e/`.

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
git tag software-v1.0.0 && git push --tags   # Legacy: package the Electron desktop app
```

## Key Constraints

- **Firmware layer violations**: Do not include or call low-level MCU headers from APP/DEV/IO — go through HAL (and appropriate HW headers only where HAL already depends on them).
- **Thread safety**: `IO_protocol` and shared protocol/JSON buffers are not casually thread-safe from multiple cogs — use the project locking patterns where applicable.
- **Locking rules**: `lib_staticQueue` (and Library data structures generally) are unsynchronized — the owning module wraps ops in its own HAL lock when its topology needs one (SPSC use is lock-free by contract). HAL locks are **not reentrant**, and a module must **never call another module's API while holding its own lock** (prevents both self-deadlock and cross-cog ABBA deadlocks).
- **Native vs P2**: Always exercise `native_emulator` / `native_test`; pointer sizes and timing differ from the Propeller 2.
- **SIL concurrency**: Treat the emulator as single-instance; Playwright uses `workers: 1` where required.
- **G-code**: Profiles/tests that must signal completion to firmware should end appropriately (e.g. **`G122`** where the firmware contract requires it).
- **Generated code**: Do not hand-edit `Firmware/MaDCore/src/Generated/`, `Software/MaDWasmControl/src/protocol/generated/`, or `SIL/mad-protocol/src/generated/` (nor the legacy `Software/MaDControl/src/main/generated/`) — change `Protocol/MaDProtocol.yaml` (or templates) and regenerate.
