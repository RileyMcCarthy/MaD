# MaD — Low-Cost Open-Source Tensile Testing Machine

A relatively low-cost (**< $4,000**), portable, spray-resistant, user-modifiable, open-source uniaxial tensile testing machine designed for low-modulus elastomeric and biologic materials.

## Specifications

| Parameter | Range |
|---|---|
| Strain Rate | 0 – 2 m/s |
| Force Measurement | 1 – 10 N |
| Gauge Length | 10 – 150 mm |
| Strain Length | 0 – 500 mm |
| Data Rate | 1000 samples/sec |

## Repository Structure

```
MaD/
├── Firmware/MaDCore/       Embedded C for Propeller 2 microcontroller
├── Software/MaDControl/    Electron + React desktop control application
├── Protocol/ProtoEmb/      Binary serial protocol (schema, codegen, Rust runtime)
├── SIL/                    Software-in-the-Loop testing (Rust emulator + Playwright)
│   ├── embsim/             Reusable embedded simulation framework (Rust)
│   ├── MaDSim/             MaD-specific emulator wiring & entry point
│   ├── tests/              Playwright E2E test specs
│   └── test-fixtures/      Sample/motion profiles used by tests
└── Hardware/               KiCad PCB designs (EdgeBoard, DS2Addon)
```

---

## Prerequisites

| Tool | Version | Install |
|---|---|---|
| [PlatformIO](https://platformio.org/) | 6.x+ | `pip install platformio` |
| [Propeller Platform](https://github.com/RileyMcCarthy/platform-propeller) | latest | See [Firmware Setup](#firmware) |
| [Node.js](https://nodejs.org/) | 20+ | [nodejs.org](https://nodejs.org/) |
| [Rust](https://www.rust-lang.org/) | 1.70+ | [rustup.rs](https://rustup.rs/) |
| [Python](https://www.python.org/) | 3.8+ | For ProtoEmb code generation (runs automatically during builds) |

> **Note:** Rust is only required if you plan to run Software-in-the-Loop (SIL) testing.

---

## Firmware

The firmware runs on a **Parallax Propeller 2** microcontroller and is written in C, compiled with the FlexC compiler via PlatformIO.

### First-Time Setup

1. Install [PlatformIO IDE for VS Code](https://docs.platformio.org/en/latest/integration/ide/vscode.html#installation)
2. Install the custom Propeller platform:
   ```bash
   cd Firmware/MaDCore
   pio pkg install --platform https://github.com/RileyMcCarthy/platform-propeller.git
   ```

### Building

```bash
cd Firmware/MaDCore

# Build for hardware (upload to Propeller 2)
pio run -e propeller2

# Build with debug serial output
pio run -e propeller2_debug

# Upload to connected board
pio run -e propeller2 -t upload

# Build as static library for the SIL emulator (gcc, native target)
pio run -e native_emulator

# Run unit tests
pio test -e native_test

# Run MISRA C:2023 + CERT static analysis
pio check
```

### PlatformIO Environments

| Environment | Purpose |
|---|---|
| `propeller2` | Production hardware build (FlexC compiler) |
| `propeller2_debug` | Hardware build with `ENABLE_DEBUG_SERIAL=1` |
| `native_emulator` | Compiles firmware as `libfirmware.a` for the SIL emulator (gcc) |
| `native_test` | Unity unit tests (native gcc) |

The `native_emulator` build excludes `HAL/` and `HW/` layers — the Rust emulator provides its own HAL implementations. It also excludes `Main/main.c` since the emulator calls `mad_begin()` from `Main/MaD.c` directly.

### Firmware Architecture

The firmware uses a strict layered architecture. Each layer may only call the layer directly below it:

```
┌──────────────────────────────────────────────────┐
│  APP   Application logic & state machines        │
│        (control, motion, monitor, notifications) │
├──────────────────────────────────────────────────┤
│  DEV   Device drivers (stepper, force gauge,     │
│        cog manager, NVRAM, watchdog)             │
├──────────────────────────────────────────────────┤
│  IO    Protocols & peripheral drivers            │
│        (serial protocol, G-code, ADS122U04)      │
├──────────────────────────────────────────────────┤
│  Library  Pure utilities, no project deps        │
│           (timer, queue, motion planning)         │
├──────────────────────────────────────────────────┤
│  HAL   Hardware abstraction (GPIO, serial, I2C)  │
├──────────────────────────────────────────────────┤
│  HW    Microcontroller registers (propeller2.h)  │
└──────────────────────────────────────────────────┘

  Generated/   Auto-generated ProtoEmb C code (protoemb.h, protoemb.c)
               DO NOT EDIT — regenerated on every build
```

### Multi-Core (COG) System

The Propeller 2 has 8 independent cores ("cogs"). `dev_cogManager` allocates tasks across them:

| Cog | Task | Frequency |
|---|---|---|
| 0 | Main (control state machine, communication) | — |
| 1 | Motor control (motion planning, stepper) | High |
| 2 | Force gauge (ADC sampling) | 1000 Hz |
| 3 | Monitor (data aggregation, logging) | 1000 Hz |

Each cog has stack canary protection and watchdog integration.

### Machine State Machine

```
DISABLED ──→ RESTRICTED ──→ MANUAL
                 │              │
                 │              ▼
                 └───────────→ TEST
```

- **Disabled** — Motion not enabled, safe state
- **Restricted** — Motion enabled but limited by safety restrictions (endstops, force limits, door interlocks)
- **Manual** — Free motion control via the UI
- **Test** — Automated test execution via G-code motion profiles

**Faults** (require reboot): ESD power/switch/upper/lower, cog failure, watchdog timeout, servo/force-gauge communication loss.

**Restrictions** (cleared when condition resolves): sample length, sample tension, machine tension, upper/lower endstop, door interlock.

---

## Communication Protocol (ProtoEmb)

Firmware ↔ UI communication uses the **ProtoEmb** binary protocol. A single YAML schema defines all messages, and code generators produce type-safe encode/decode functions for C (firmware), TypeScript (UI), and Rust (bridge).

### Protocol Schema

The schema lives at `Protocol/MaDProtocol.yaml` and defines:
- **Enums**: FaultedReason, RestrictedReason, MotionState, GCode, NotificationType
- **Structs**: Sample, MachineState, MachineConfiguration, FirmwareVersion, SampleProfile, Notification, Move, StoredSample
- **Messages**: Read requests (sample, state, config, version, profile) and write commands (config, motion enable, test run, move, profile, zero, file download)

### Wire Frame Format

Every message uses this framing (handled by `IO_protocol.c` on firmware, `protoemb-framing` crate on Rust side):

```
┌──────┬──────┬─────┬──────────┬────────┬──────┐
│ SYNC │ TYPE │ CMD │ LEN (LE) │ DATA   │ CRC8 │
│ 0x55 │ 1B   │ 1B  │ 2B       │ N      │ 1B   │
└──────┴──────┴─────┴──────────┴────────┴──────┘
```

- **TYPE**: Read request, write request, ACK, NACK, data response, notification
- **CMD**: Message-specific command ID
- **DATA**: ProtoEmb binary payload (compact bit-packed or byte-aligned)

### Struct Wire Sizes

| Struct | Encoding | Wire Size | Description |
|---|---|---|---|
| Sample | packed (bit-level) | 16 bytes | Live force/position/setpoint data at ~100 Hz |
| MachineState | packed | 2 bytes | Fault, restriction, motion enabled, test running |
| Move | packed | 7 bytes | G-code command with position/velocity/dwell |
| MachineConfiguration | aligned (byte-level) | 64 bytes | Machine calibration and limits |
| SampleProfile | aligned | 20 bytes | Material test limits |
| FirmwareVersion | aligned | 16 bytes | Version string |
| Notification | aligned | 101 bytes | Type + message string |
| StoredSample | packed | 15 bytes | Logged sample data point |

### Unit Conventions

All values cross the wire in **firmware-native units**. The TypeScript codegen automatically converts to/from UI units:

| Field | Wire Unit | UI Unit | Scale Factor |
|---|---|---|---|
| Force | mN | N | ÷ 1000 |
| Position | µm | mm | ÷ 1000 |
| Velocity | µm/s | mm/s | ÷ 1000 |
| Time (dwell) | ms | ms | 1 |

### Code Generation

Code is auto-generated during builds — you should never edit generated files:

| Target | Output | Triggered By |
|---|---|---|
| C | `Firmware/MaDCore/src/Generated/protoemb.{h,c}` | PlatformIO pre-build script (`extra_scripts/generate_protocol.py`) |
| TypeScript | `Software/MaDControl/src/main/generated/protoemb.ts` | `Software/MaDControl` npm scripts (`generate:proto`) |
| Rust (SIL) | `SIL/embsim/peripherals/src/generated/protoemb.rs` | `SIL/makefile` `protocol` target |

To regenerate manually:
```bash
python3 ./Protocol/ProtoEmb/core/generate.py --schema ./Protocol/MaDProtocol.yaml --target c  --output ./Firmware/MaDCore/src/Generated --templates ./Protocol/ProtoEmb/core/templates
python3 ./Protocol/ProtoEmb/core/generate.py --schema ./Protocol/MaDProtocol.yaml --target ts --output ./Software/MaDControl/src/main/generated --templates ./Protocol/ProtoEmb/core/templates
python3 ./Protocol/ProtoEmb/core/generate.py --schema ./Protocol/MaDProtocol.yaml --target rs --output ./SIL/embsim/peripherals/src/generated --templates ./Protocol/ProtoEmb/core/templates
```

### G-Code Commands

Motion profiles are compiled to G-code moves and streamed to firmware:

| Code | Description | Parameters |
|---|---|---|
| `G0` | Rapid move | `X<pos> F<feedrate>` |
| `G1` | Linear move | `X<pos> F<feedrate>` |
| `G4` | Dwell (pause) | `P<milliseconds>` |
| `G28` | Home axis | — |
| `G90` | Absolute positioning | — |
| `G91` | Relative positioning | — |
| `G122` | Stop (test complete) | — |

---

## Software (MaD Control)

The desktop control application is built with **Electron + React + TypeScript**.

### Architecture

```
┌──────────────────────────────────────────────────┐
│  Renderer Process (React UI)                      │
│  Pages: Dashboard, Tests, Create, Connect, Config │
│  Hooks: useDevice (state), useProfiles            │
├─────────── IPC channels ─────────────────────────┤
│  Main Process (Electron)                          │
│  DeviceInterface.ts → BridgeHandler.ts            │
│     Spawns protoemb-bridge as child process       │
├─────────── NDJSON over stdio ────────────────────┤
│  protoemb-bridge (Rust binary)                    │
│  Client → PriorityQueue → Frame builder/parser    │
│  Periodic polling: sample @ ~100Hz, state @ 10Hz  │
│  Transport: SerialTransport or PtyTransport       │
├─────────── Binary serial (USB or PTY) ───────────┤
│  Firmware / Emulator                              │
└──────────────────────────────────────────────────┘
```

The **Rust bridge** (`protoemb-bridge`) sits between Electron and the serial port. It:
- Manages a priority queue of read/write requests
- Polls sample data and machine state on a schedule
- Handles request/response matching with timeouts
- Emits NDJSON events to Electron over stdout
- Accepts NDJSON commands from Electron over stdin
- Auto-detects PTY vs USB serial ports (PTYs use raw POSIX I/O on macOS)

### First-Time Setup

```bash
cd Software/MaDControl
npm install
```

### Running in Development

```bash
cd Software/MaDControl
npm start
```

This starts the app with hot-reload enabled for the renderer process.

### Building for Production

```bash
cd Software/MaDControl
npm run build      # Compile main + renderer
npm run package    # Build distributable app
```

Production builds go to `Software/MaDControl/release/build/`.

### macOS Security Notice

If you downloaded a pre-built app from GitHub Releases, macOS may block it because it is not code-signed. To fix this:

```bash
xattr -dr com.apple.quarantine "MaD Control.app"
```

Or: right-click the app → Open → click "Open" in the security dialog.

### Application Pages

| Page | Description |
|---|---|
| **Connect** | Select and connect to a serial port |
| **Dashboard** | Real-time force/position data, charts, and motion controls |
| **Create** | Create and manage sample profiles (`.sp`) and motion profiles (`.mp`) |
| **Tests** | View recorded test data |
| **Device Configuration** | View and modify machine configuration |
| **Firmware Update** | Update firmware on the connected machine |

### Key IPC Channels

| Direction | Channel | Description |
|---|---|---|
| Renderer → Main | `device-connect` | Connect to serial port |
| Renderer → Main | `device-disconnect` | Disconnect |
| Renderer → Main | `device-connected` | Check connection status |
| Renderer → Main | `device-responding` | Check if firmware is communicating |
| Renderer → Main | `manual-move` | Send manual move command |
| Renderer → Main | `run-test` | Start test execution |
| Renderer → Main | `home-axis` | Home the motion axis |
| Renderer → Main | `zero-force` / `zero-length` | Zero force gauge / encoder |
| Main → Renderer | `sample-data-updates` | Real-time sample measurements |
| Main → Renderer | `machine-state-updates` | Machine state changes |
| Main → Renderer | `device-status-changed` | Connection status events |

### File Formats

**Sample Profile (`.sp`)** — Defines material properties and test limits:
```json
{
  "maxForce": 50,
  "maxVelocity": 25,
  "maxDisplacement": 100,
  "sampleWidth": 10,
  "sampleThickness": 2,
  "serial": "SAMPLE001"
}
```

**Motion Profile (`.mp`)** — Defines test execution with sets of moves:
```json
{
  "name": "Tension Test",
  "description": "Simple tension test",
  "sets": [
    {
      "name": "Cycle",
      "executions": 3,
      "moves": [
        {
          "moveType": "linear",
          "absoluteOrRelative": "absolute",
          "moveParameters": { "position": 20, "velocity": 10 }
        },
        {
          "moveType": "dwell",
          "absoluteOrRelative": "absolute",
          "moveParameters": { "time": 500 }
        }
      ]
    }
  ]
}
```

---

## Software-in-the-Loop (SIL) Testing

The SIL system tests the **complete firmware ↔ UI integration** without physical hardware. It compiles the real firmware C code into a Rust-based emulator that simulates the Propeller 2, servo motor, force gauge, and material physics. Playwright E2E tests then drive the real Electron UI connected to the emulator.

### System Architecture

```
┌──────────────────────────────────────────────────┐
│  Firmware C code (libfirmware.a)                  │
│  APP / DEV / IO / Library / Main layers           │
│  Compiled from real source with gcc (native)      │
├──────────────────────────────────────────────────┤
│  embsim-p2 — Propeller 2 HAL implementations     │
│  GPIO, serial, encoder, pulse_out, I2C, locks     │
│  System: thread-per-cog, virtual clock            │
├──────────────────────────────────────────────────┤
│  embsim-models — Physics simulation               │
│  Stepper motor (position over time)               │
│  Strain gauge → ADC (ADS122U04 emulation)         │
│  Sample material model (force = f(displacement))  │
│  Limit switches (position thresholds)             │
├──────────────────────────────────────────────────┤
│  MaDSim/wiring.rs — Machine-specific wiring       │
│  Connects peripheral callbacks to model inputs    │
│  Sets GPIO initial states, configures channels    │
├──────────────────────────────────────────────────┤
│  Virtual serial port (PTY pair)                   │
│  Symlinked to /tmp/tty.rpi                        │
│  Electron UI connects here (via protoemb-bridge)  │
└──────────────────────────────────────────────────┘
         │ PTY
    Electron UI (MaD Control)
         │ CDP (Chrome DevTools Protocol)
    Playwright E2E Tests
```

### Emulator Simulation Chain

When the firmware commands the motor, this chain of callbacks fires:

```
pulse_out ──on_start───────> stepper::start_motion(pulses, freq)
                                │ (stepper thread steps at 10ms period)
stepper::on_change(pos_mm) ──>  ├──> encoder::set_value(steps)
                                ├──> limit_switch::update(pos_mm)
                                └──> sample::on_position(pos_mm)
                                       └──> strain_gauge::set_force(force_n)
                                              └──> ads122u04::set_voltage(mv)
                                                     (ADC sends data over serial at 100Hz)

gpio SERVO_ENA ──on_change──> stepper::set_enabled()
gpio SERVO_DIR ──on_change──> stepper::set_direction()
limit_switch ──on_change────> gpio::set_state(ENDSTOP_UPPER/LOWER)
```

All GPIO pin assignments, encoder channels, and peripheral indices are resolved at runtime from the firmware's DWARF debug info — so the emulator automatically adapts if firmware enums change.

### Emulator Crate Structure

```
SIL/
├── embsim/
│   ├── core/           Virtual clock, PTY creation, base traits
│   ├── peripherals/    Generic peripheral drivers (GPIO, serial, encoder, pulse_out, lock, filesystem)
│   ├── models/         Physics models (stepper, strain_gauge, ads122u04, limit_switch, sample)
│   ├── platforms/p2/   Propeller 2 HAL (C FFI exports that firmware calls)
│   └── tools/
│       ├── memory-inspect/  DWARF debug info parser (reads enums/structs from libfirmware.a)
│       ├── trace/           Signal recording and trace viewer backend
│       └── ui/              Axum web server for trace viewer
└── MaDSim/
    ├── build.rs        Links libfirmware.a
    ├── src/main.rs     CLI args, peripheral init, calls mad_begin()
    └── src/wiring.rs   MaD-specific callback wiring and constants
```

### First-Time Setup

```bash
# Install Playwright test dependencies
cd SIL
make setup

# Ensure MaDControl is built (tests launch the production Electron app)
cd ../Software/MaDControl
npm install
npm run build
```

### Running Tests

```bash
cd SIL

# Full pipeline: build firmware → build emulator → run all Playwright tests
make test
```

`make test` executes three steps:
1. **`make firmware`** — Runs `pio run -e native_emulator` to compile firmware C code into `libfirmware.a`
2. **`make emulator`** — Runs `cargo build` to compile the Rust emulator (links `libfirmware.a`)
3. **`npm test`** — Runs `npx playwright test` which:
   - **Global setup** (`global-setup.ts`): Verifies emulator and MaDControl are built
   - **Per-test fixture** (`fixtures.ts`): Starts a fresh emulator, launches Electron via CDP, connects to emulator
   - **Test specs**: Drive the UI with Playwright, assert behavior
   - **Per-test teardown**: Stops emulator and Electron

### Running Specific Tests

```bash
cd SIL

# Run a single test file
npx playwright test tests/dashboard-motion.spec.ts

# Run tests matching a name pattern
npx playwright test -g "Move Up 5mm"

# Run with visible Electron window
npm run test:headed

# Run with Playwright Inspector (step through)
npm run test:debug

# Run with Playwright UI mode
npm run test:ui
```

### Test Configuration

Key settings in `playwright.config.ts`:

| Setting | Value | Why |
|---|---|---|
| `timeout` | 90s | Includes emulator startup (~2s) + firmware init + test actions |
| `expect.timeout` | 10s | Assertions may need to wait for firmware response |
| `workers` | 1 | Emulator is single-instance (one PTY) |
| `fullyParallel` | false | Sequential execution required |
| `maxFailures` | 1 | Stop on first failure for faster feedback |
| `video` | always | All tests record video |
| `trace` | retain-on-failure | Playwright traces saved for failed tests |
| `screenshot` | only-on-failure | Screenshots on failure |

### Test File Organization

```
SIL/tests/
├── fixtures.ts                     Per-test Electron + emulator lifecycle
├── helpers.ts                      Utility functions (launchMaDControl, etc.)
├── global-setup.ts                 Pre-run: verify builds exist
├── global-teardown.ts              Post-run: kill orphaned processes
├── dashboard-motion.spec.ts        Dashboard UI, motion enable/disable, manual moves, zeroing, homing
├── e2e-full-lifecycle.spec.ts      Full end-to-end lifecycle test
├── firmware-connection.spec.ts     Firmware connection and communication
├── firmware-update.spec.ts         Firmware update flow
├── machine-config.spec.ts          Machine configuration read/write
├── navigation.spec.ts              Page navigation
├── profile-operations.spec.ts      Profile file management
└── profile-test-execution.spec.ts  Profile creation and test execution
```

### Test Fixture Lifecycle (Per Test)

Each test gets a **completely fresh** emulator and Electron instance:

```
1. Kill stale emulator/Electron processes
2. Remove stale PTY symlink (/tmp/tty.rpi)
3. Start Rust emulator → waits for PTY to appear
4. Launch Electron with ELECTRON_CDP_PORT=9222
5. Connect Playwright to Electron via CDP
6. [Test fixture] connectToEmulator():
   a. Wait for IPC to be ready
   b. Wait for emulator port in device-list-ports
   c. Call device-connect
   d. Poll device-responding until firmware communicates
7. ── Run test ──
8. Close Electron (kill process)
9. Stop emulator (SIGTERM + pkill safety net)
```

### Test Fixtures Available

Tests import from `fixtures.ts` and get these fixtures automatically:

| Fixture | Type | Description |
|---|---|---|
| `app` | `AppHandle` | The running Electron app (with `.close()`) |
| `window` | `Page` | The main Electron window (Playwright Page) |
| `emulator` | `ChildProcess` | The running emulator process |
| `emulatorPort` | `string` | PTY path (`/tmp/tty.rpi`) |
| `connectToEmulator` | `() => Promise<void>` | Connect UI to emulator and wait for firmware response |
| `waitForIPC` | `() => Promise<void>` | Wait for `window.electron.ipcRenderer` to be available |
| `listPorts` | `() => Promise<string[]>` | List available serial ports via IPC |

### Writing a New Test

```typescript
import { test, expect } from './fixtures';

test.describe('My Feature', () => {
  test.beforeEach(async ({ connectToEmulator, window }) => {
    // Connect to the emulator (starts fresh per-test)
    await connectToEmulator();
    // Navigate to the page you want to test
    await window.getByRole('link', { name: 'Dashboard' }).click();
  });

  test('should do something', async ({ window }) => {
    // Enable motion
    await window.getByRole('button', { name: 'Enable Motion' }).click();
    await expect(window.getByRole('button', { name: 'Disable Motion' }))
      .toBeVisible({ timeout: 5000 });

    // Interact with the UI
    await window.getByLabel('Move Distance (mm)').fill('5');
    await window.getByRole('button', { name: 'Move Up' }).click();
    await window.waitForTimeout(1000);

    // Assert results
    const text = await window.locator('text=Machine Position (mm):')
      .locator('..').textContent();
    expect(text).toContain('5');
  });
});
```

### Common Test Selectors

| Element | Selector |
|---|---|
| Navigation links | `getByRole('link', { name: 'Dashboard' })` |
| Buttons | `getByRole('button', { name: 'Enable Motion' })` |
| Headings | `getByRole('heading', { name: 'Machine State' })` |
| Labeled inputs | `getByLabel('Move Distance (mm)')` |
| Text content | `locator('text=Machine Position (mm):')` |
| File inputs | `locator('input[type="file"][accept=".sp"]')` |

### Viewing Test Results

```bash
cd SIL

# Open the HTML test report in a browser
npm run report
# or: npx playwright show-report test-results/html

# View a Playwright trace for a failed test
npx playwright show-trace test-results/artifacts/<test-folder>/trace.zip

# Videos are at:
# test-results/artifacts/<test-folder>/video.webm
```

### Interactive Development (Playground Mode)

Start the emulator with a trace viewer for manual testing:

```bash
cd SIL
make playground
```

This starts the emulator at `/tmp/tty.rpi` with a **trace viewer** at `http://localhost:3000` showing real-time signals (stepper position, force, GPIO states, encoder, etc.).

Then start the Electron app separately:
```bash
cd Software/MaDControl
npm start
```

Connect to `/tmp/tty.rpi` from the Connect page.

### Debugging

```bash
# See emulator stdout/stderr during tests
DEBUG_EMULATOR=1 npx playwright test tests/dashboard-motion.spec.ts

# See Electron app stdout/stderr during tests
DEBUG_APP=1 npx playwright test tests/dashboard-motion.spec.ts

# Both
DEBUG_EMULATOR=1 DEBUG_APP=1 npx playwright test tests/dashboard-motion.spec.ts
```

### Troubleshooting

| Problem | Solution |
|---|---|
| `Emulator port not found` | Kill stale processes: `pkill -f 'mad-emulator\|Electron'` |
| `libfirmware.a not found` | Build firmware first: `cd Firmware/MaDCore && pio run -e native_emulator` |
| `MaDControl not built` | Build the app: `cd Software/MaDControl && npm run build` |
| `CDP not available on port 9222` | Kill stale Electron: `pkill -f Electron` |
| `Serial port busy` | Check if another process uses `/tmp/tty.rpi`: `lsof /tmp/tty.rpi*` |
| `Test timeout` | Increase timeout or check firmware is responding; try `DEBUG_EMULATOR=1` |
| `Element not found` | Use `{ exact: true }` for text that matches multiple elements |
| Tests hang after failure | `pkill -f 'mad-emulator\|Electron'` then re-run |

### Test Fixture Files

Test profiles in `SIL/test-fixtures/`:

| File | Description |
|---|---|
| `sample-profile.sp` | Standard test sample profile |
| `motion-profile-simple.mp` | Simple 3-move test profile |
| `motion-profile-complex.mp` | Multi-set complex profile |
| `motion-profile-e2e.mp` | End-to-end lifecycle test profile |

### SIL Makefile Reference

| Command | Description |
|---|---|
| `make setup` | First-time setup (install npm dependencies) |
| `make firmware` | Build firmware as `libfirmware.a` via PlatformIO |
| `make emulator` | Build Rust emulator (builds firmware first if needed) |
| `make test` | Build everything and run all Playwright tests |
| `make playground` | Start emulator with trace viewer for manual testing |
| `make clean` | Remove test results, cargo clean, PlatformIO clean |

---

## Hardware

PCB designs are in [KiCad](https://www.kicad.org/) format under `Hardware/`.

| Board | Description |
|---|---|
| **EdgeBoard** | Main controller PCB — hosts the Propeller 2, servo driver interface, and all I/O connections |
| **DS2Addon** | Piggyback board for the DS2 force gauge — provides analog voltage readings from the strain gauge |

---

## CI/CD

GitHub Actions (`.github/workflows/ci.yml`) automatically builds and tests on pushes and pull requests:

- **Software** — Builds Electron app for macOS, Windows, and Linux
- **Firmware** — Builds debug, release, and native (SIL) firmware binaries
- **Hardware** — Generates manufacturing files (Gerbers, BOM, interactive BOM) via KiBot
- **SIL Tests** — Runs full integration tests when software or firmware changes

### Releases

Releases are triggered by pushing version tags:

```bash
# Software release
git tag software-v1.0.0 && git push --tags

# Firmware release
git tag firmware-v1.0.0 && git push --tags

# Hardware release
git tag hardware-v1.0.0 && git push --tags
```

---

## Power-Up Sequence

1. Turn on the mains inlet power switch (powers motion control electronics)
2. Press the momentary **ON** button (applies DC power to status switches and ESD chain)
3. Release the ESD switch (applies AC power to the servo controller)
4. When all safety criteria are met, enable motion from the control software
5. Power down in reverse order — press the **OFF** button to remove DC power

---

## Operating Modes

### Manual Mode

Control the motor directly from the UI:
- Incremental / continuous jog
- Move to position
- Home axis
- Set / move to gauge length
- Set / move to force level and hold

### Test Mode

Automated test execution using motion profiles:
1. Load a **sample profile** (`.sp`) defining material limits
2. Load a **motion profile** (`.mp`) defining the test pattern
3. Run the test — moves are streamed to the firmware automatically
4. Data is recorded in real-time (force, position, stress, strain)

---

## Quick Reference

### Build Everything

```bash
# Firmware (hardware)
cd Firmware/MaDCore && pio run -e propeller2

# Firmware (for emulator)
cd Firmware/MaDCore && pio run -e native_emulator

# Rust bridge
cd Protocol/ProtoEmb/runtime && cargo build --bin protoemb-bridge

# SIL emulator
cd SIL && cargo build

# Electron app (dev)
cd Software/MaDControl && npm start

# Electron app (production build)
cd Software/MaDControl && npm run build

# Run all SIL tests
cd SIL && make test

# Run firmware unit tests
cd Firmware/MaDCore && pio test -e native_test
```

---

## License

MIT
