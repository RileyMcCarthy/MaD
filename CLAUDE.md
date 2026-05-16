# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

MaD is a low-cost open-source uniaxial tensile testing machine. The monorepo has these main parts:

- **Firmware** (`Firmware/MaDCore/`) — Embedded C for the Parallax Propeller 2
- **Software** (`Software/MaDControl/`) — Electron + React + TypeScript desktop app
- **SIL** (`SIL/`) — Software-in-the-loop: Rust workspace (`MaDSim` + `embsim`) + Playwright E2E tests
- **Protocol** (`Protocol/ProtoEmb/`) — YAML schema (`MaDProtocol.yaml`) → generated C / TypeScript / Rust, plus a Rust **protoemb-bridge** binary used by the desktop app
- **Hardware** (`Hardware/`) — KiCad PCB designs

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

### Software (from `Software/MaDControl/`)
```bash
npm install       # First-time setup (runs postinstall: check-native-dep, electron-builder install-app-deps, build:dll)
npm start         # Dev mode with hot reload
npm run package   # Production build → release/build/
npm run lint:fix  # ESLint auto-fix
npm test          # Jest unit tests
```

### SIL Testing (from `SIL/`)
```bash
make setup        # First-time: npm deps
make firmware     # Firmware static library only
make protocol     # Regenerate Rust protocol types into embsim/peripherals
make bridge       # Build protoemb-bridge (Protocol/ProtoEmb/runtime)
make emulator     # firmware + protocol + bridge, then cargo build workspace
make test         # emulator + Playwright (`npm test`)
make playground   # `cargo run --bin mad-emulator` + SD path ./sd, PTY /tmp/tty.rpi (see makefile for flags)
make clean        # Remove build artifacts
```

### Protocol Code Generation
```bash
# From repo root:
python3 ./Protocol/ProtoEmb/core/generate.py --schema ./Protocol/MaDProtocol.yaml --target c  --output ./Firmware/MaDCore/src/Generated --templates ./Protocol/ProtoEmb/core/templates
python3 ./Protocol/ProtoEmb/core/generate.py --schema ./Protocol/MaDProtocol.yaml --target ts --output ./Software/MaDControl/src/main/generated --templates ./Protocol/ProtoEmb/core/templates
python3 ./Protocol/ProtoEmb/core/generate.py --schema ./Protocol/MaDProtocol.yaml --target rs --output ./SIL/embsim/peripherals/src/generated --templates ./Protocol/ProtoEmb/core/templates
# Firmware also runs `extra_scripts/generate_protocol.py` via `platformio.ini` pre-hook.
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

### Software (Electron) Architecture
- **Main process**: IPC handlers in `src/main/handlers/`
  - **`BridgeHandler.ts`** — runs and speaks to the **`protoemb-bridge`** Rust child process (typed protocol framing).
  - **`DeviceInterface.ts`** — device/session IPC, wires bridge events → renderer (`webContents.send`).
- **Renderer**: React + TypeScript; `src/renderer/hooks/useDevice.tsx` centralizes device state.
- **IPC**: Renderer uses `window.electron.ipcRenderer.invoke()`; main pushes on channels such as `sample-data-updates` and `machine-state-updates`.
- **Protocol**: Generated TypeScript in `src/main/generated/` from `Protocol/MaDProtocol.yaml`.

### SIL Emulator Architecture
Rust **Cargo workspace** under `SIL/` (see `SIL/Cargo.toml`):

- **`MaDSim/`** — `mad-emulator` binary: links **`libfirmware.a`** from `pio run -e native_emulator`, calls `mad_begin()`, wires PTY serial, SD path, optional trace HTTP port.
- **`embsim/core`** — PTY, timing, shared plumbing.
- **`embsim/peripherals`** — HAL stand-ins (serial, GPIO, pulse trains, encoder, etc.) plus **generated** protocol types under `src/generated/`.
- **`embsim/platforms/p2`** — FFI / stubs linking firmware into the emulator.
- **`embsim/models`** — Physics-style models (e.g. gantry, force path, sampling).
- **`embsim/tools/*`** — trace viewer, memory inspect, UI shell helpers.

**Behavior specs** for coverage live in `SIL/specs/` (indexed in `SIL/specs/README.md` and `COVERAGE_MAPPING.md`).

Playwright tests in `SIL/tests/` drive the real Electron UI against the emulator; config uses a single worker where the emulator is single-instance.

### Communication Protocol
Firmware ↔ UI communicates over serial (230400 baud on hardware) using the generated protocol from `Protocol/MaDProtocol.yaml`. Motion profiles become G-code (`G0`, `G1`, `G4`, `G28`, `G90`, `G91`, `G122`) and are streamed line-by-line.

## Firmware Naming & File Conventions

Files are prefixed with their layer: `IO_protocol.c`, `dev_stepper.c`, `app_control.c`, `lib_timer.c`. Use `src/template.ch` / `src/template.cx` for new files — standard section layout (includes, constants, typedefs, APIs, etc.).

## CI/CD & Releases

Releases are triggered by pushing version tags:
```bash
git tag software-v1.0.0 && git push --tags   # Software release
git tag firmware-v1.0.0 && git push --tags   # Firmware release
git tag hardware-v1.0.0 && git push --tags   # Hardware release
```

## Key Constraints

- **Firmware layer violations**: Do not include or call low-level MCU headers from APP/DEV/IO — go through HAL (and appropriate HW headers only where HAL already depends on them).
- **Thread safety**: `IO_protocol` and shared protocol/JSON buffers are not casually thread-safe from multiple cogs — use the project locking patterns where applicable.
- **Native vs P2**: Always exercise `native_emulator` / `native_test`; pointer sizes and timing differ from the Propeller 2.
- **SIL concurrency**: Treat the emulator as single-instance; Playwright uses `workers: 1` where required.
- **G-code**: Profiles/tests that must signal completion to firmware should end appropriately (e.g. **`G122`** where the firmware contract requires it).
- **Generated code**: Do not hand-edit `Firmware/MaDCore/src/Generated/`, `Software/MaDControl/src/main/generated/`, or `SIL/embsim/peripherals/src/generated/` — change `Protocol/MaDProtocol.yaml` (or templates) and regenerate.
