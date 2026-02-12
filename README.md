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
├── Firmware/MaDCore/    Embedded C for Propeller 2 microcontroller
├── Software/MaDControl/ Electron + React desktop control application
├── SIL/                 Software-in-the-Loop testing (Rust emulator + Playwright)
└── Hardware/            KiCad PCB designs (EdgeBoard, DS2Addon)
```

---

## Prerequisites

| Tool | Version | Install |
|---|---|---|
| [PlatformIO](https://platformio.org/) | 6.x+ | `pip install platformio` |
| [Propeller Platform](https://github.com/RileyMcCarthy/platform-propeller) | latest | See [Firmware Setup](#firmware) |
| [Node.js](https://nodejs.org/) | 20+ | [nodejs.org](https://nodejs.org/) |
| [Rust](https://www.rust-lang.org/) | 1.70+ | [rustup.rs](https://rustup.rs/) |

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
```

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
│           (JSON, timer, queue, motion planning)  │
├──────────────────────────────────────────────────┤
│  HAL   Hardware abstraction (GPIO, serial, I2C)  │
├──────────────────────────────────────────────────┤
│  HW    Microcontroller registers (propeller2.h)  │
└──────────────────────────────────────────────────┘
```

### Machine State Machine

The firmware operates through these states:

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

### Communication Protocol

The firmware communicates with the desktop UI over **serial (230400 baud)** using a JSON-based protocol. Supported message types include sample data, machine state, motion commands, and test control.

### G-Code Support

Motion profiles are converted to G-code and streamed to the firmware:

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
npm run package
```

This produces platform-specific installers in `Software/MaDControl/release/build/`.

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
| **Test Profile** | Create and manage sample profiles (`.sp`) and motion profiles (`.mp`) |
| **Machine Config** | View and modify machine configuration |
| **Firmware Update** | Update firmware on the connected machine |

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

The SIL system lets you test the **complete firmware ↔ UI integration** without physical hardware. It compiles the real firmware C code into a Rust-based emulator that simulates the Propeller 2, servo motor, force gauge, and material physics.

### How It Works

```
┌──────────────────────────────────────────┐
│     Firmware C code (libfirmware.a)       │
│  Compiled from real source with gcc       │
├──────────────────────────────────────────┤
│     Rust HAL implementations              │
│  GPIO, serial, encoder, I2C, timers       │
├──────────────────────────────────────────┤
│     Physics simulation                    │
│  Servo motor, force gauge, sample model   │
├──────────────────────────────────────────┤
│     Virtual serial port (PTY)             │
│  /tmp/tty.rpi → Electron UI connects      │
└──────────────────────────────────────────┘
         │
    Electron UI (MaD Control)
         │
    Playwright E2E Tests
```

The emulator creates a virtual serial port that the Electron app connects to, just as it would with real hardware. Playwright tests then drive the UI and verify end-to-end behavior.

### First-Time Setup

```bash
cd SIL
make setup      # Install npm dependencies
```

> You also need PlatformIO and Rust installed (see [Prerequisites](#prerequisites)).

### Running Tests

```bash
cd SIL
make test       # Build firmware + emulator, run all Playwright tests
```

This will:
1. Build the firmware as a static library (`libfirmware.a`) using PlatformIO
2. Build the Rust emulator (which links `libfirmware.a`)
3. Run all Playwright E2E tests against the Electron app

### Interactive Development (Playground)

To start the emulator and UI without running tests:

```bash
cd SIL
make playground
```

This starts the emulator with a virtual serial port at `/tmp/tty.rpi` and a trace server at `http://localhost:3000`. You can then start the Electron app separately and connect to the emulator.

### Viewing Test Results

```bash
cd SIL

# Open HTML test report
npm run report

# View trace for a failed test
npx playwright show-trace test-results/artifacts/<trace-file>.zip
```

Test artifacts (screenshots, videos, traces) are saved to `SIL/test-results/`.

### SIL Makefile Reference

| Command | Description |
|---|---|
| `make setup` | First-time setup (install npm dependencies) |
| `make firmware` | Build firmware as static library |
| `make emulator` | Build Rust emulator (builds firmware if needed) |
| `make test` | Build everything and run Playwright tests |
| `make playground` | Start emulator + app for manual testing |
| `make clean` | Remove build artifacts |

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
3. Run the test — G-code is streamed to the firmware automatically
4. Data is recorded in real-time (force, position, stress, strain)

---

## License

MIT
