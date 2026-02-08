# MaD Tensile Testing Machine - AI Coding Instructions

## Project Overview
MaD is a low-cost (<$4k), portable, open-source uniaxial tensile testing machine for elastomeric/biologic materials. Three main components:

1. **Firmware** (`Firmware/MaDCore/`) - Embedded C for Propeller 2 microcontroller
2. **Software** (`Software/MaDControl/`) - Electron/React/TypeScript desktop UI
3. **SIL** (`SIL/`) - Software-in-the-Loop testing with Python emulator + Playwright tests

## Architecture: Firmware (Embedded C)

### Layered Architecture (Bottom-Up)
Strict separation enforced - higher layers may NOT call lower layers directly:

```
APP/      - Application logic, state machines (app_control, app_motion, app_monitor)
DEV/      - Device drivers combining HAL+IO (dev_stepper, dev_cogManager, dev_forceGauge, dev_nvram)
IO/       - I/O protocols & peripheral drivers (IO_protocol, IO_gcode, IO_ADS122U04)
Library/  - Pure utility code, no project dependencies (lib_timer, lib_staticQueue, JSON)
HAL/      - Hardware abstraction (GPIO, serial, I2C) - only layer calling HW
HW/       - Microcontroller-specific (propeller2.h registers)
```

**Key Pattern**: Configuration lives in `Config/` subdirectories (e.g., `DEV/Config/dev_cogManager_config.h`)

### COG Manager (Multi-Core Task System)
Propeller 2 has 8 cores ("cogs"). `dev_cogManager` allocates and monitors tasks across cores:
- Define channels in `dev_cogManager_config.h` (MONITOR, MOTOR, COMMUNICATION, etc.)
- Use macros: `DEV_COGMANAGER_CHANNEL_CREATE_INIT/RUN` to declare tasks
- Each cog has stack canaries, watchdog integration, and frequency targets
- Example: `DEV_COGMANAGER_CHANNEL_MOTOR` runs motor control at specific Hz

### JSON-Based Serial Protocol
Firmware ↔ UI communication via JSON messages over serial (`IO_protocol.c`):
- **Read Types**: SAMPLE, STATE, MACHINE_CONFIGURATION, FIRMWARE_VERSION, SAMPLE_PROFILE
- **Write Types**: MOTION_ENABLE, TEST_RUN, MANUAL_MOVE, GAUGE_LENGTH, etc.
- Use `JSON.h` helpers: `json_property_to_int`, `double_to_json`, etc.
- Protocol is NOT thread-safe - caller must handle locking

### State Machine Pattern
See `app_control.h`:
- States: DISABLED → RESTRICTED → MANUAL/TEST
- Faults: ESD, watchdog, servo communication, etc.
- Restrictions: sample length/tension, machine limits, door interlocks
- All motion gated through `app_control_motionEnabled()`

### File Headers
Use `template.ch` for headers - minimal Doxygen comments (`@brief`, `@details`). Avoid over-documentation.

## Build System: Firmware

### PlatformIO Environments
- **propeller2**: Real hardware build (FlexC compiler, Propeller 2 board)
- **propeller2_debug**: Hardware with `ENABLE_DEBUG_SERIAL=1`
- **native**: x86 emulation build for SIL testing (gcc, `-fsanitize=address`)
- **native_test**: Unity unit tests (run with `pio test -e native_test`)

**Key Flags**:
- `-D__EMULATION__` - Native build conditional compilation
- `-DSD_CARD_MOUNT_PATH` - Differs between real hardware (`"/sd"`) and native (`"./sd"`)

### Build Commands
```bash
cd Firmware/MaDCore
pio run -e propeller2        # Hardware build
pio run -e native            # Emulation build
pio test -e native_test      # Unit tests
pio check                    # MISRA C:2023 + CERT checks via cppcheck
```

### MISRA C Compliance
Code checked against MISRA C:2023 guidelines (`misra.json`, `misra-rules.txt`). Use `pio check` to validate.

## Architecture: Software (Electron/React)

### Tech Stack
- **Main Process**: Electron IPC handlers for serial communication (`main/handlers/SerialPortHandler.ts`)
- **Renderer**: React + TypeScript, hooks-based (`renderer/hooks/useDevice.tsx`)
- **Communication**: IPC channels like `'sample-data-updates'`, `'machine-state-updates'`

### Key IPC Patterns
```typescript
// Renderer → Main (invoke)
await window.electron.ipcRenderer.invoke('device-connected');
await window.electron.ipcRenderer.invoke('run-test', { profileId });

// Main → Renderer (on/emit)
window.electron.ipcRenderer.on('sample-data-updates', handler);
window.electron.ipcRenderer.on('machine-state-updates', handler);
```

### Development Commands
```bash
cd Software/MaDControl
npm install
npm start                    # Dev mode with hot reload
npm run package              # Build production app
npm run lint:fix             # ESLint auto-fix
```

## Testing: SIL (Software-in-the-Loop)

### Purpose
Test complete firmware ↔ UI integration using:
- **Emulator**: Native firmware build + Python virtual serial ports (`MaDSim/`)
- **Playwright**: E2E tests against real Electron UI (`tests/*.spec.ts`)

### Running SIL Tests
```bash
cd SIL
make setup                   # First time: install deps
make run                     # Build firmware, start emulator, run Playwright tests
make playground              # Start emulator + UI without tests (dev mode)
```

**Artifacts**: `test-results/` contains screenshots, traces, HTML reports

### Virtual Serial Ports
Python creates `/tmp/tty.rpi_client` ↔ `/tmp/tty.rpi` pairs. UI connects to `_client`, emulator reads from base port.

### Test Helpers
Use `tests/helpers.ts`:
```typescript
const { app, window } = await launchMaDControl();
await connectToEmulator(window, '/tmp/tty.rpi');
const state = await getMachineState(window);
```

## Critical Workflows

### Adding New Firmware Features
1. Determine layer (APP/DEV/IO/Library based on dependencies)
2. Create `.h` header with typedefs, public functions
3. Implement `.c` with static functions for internals
4. Add to `platformio.ini` include paths if new directory
5. If multi-core, integrate with `dev_cogManager` channel
6. Update `IO_protocol` if UI needs to communicate with it
7. Add native emulation code in `HAL/Native/` or `HW/Native/` for SIL compatibility

### Debugging Serial Protocol Issues
1. Enable debug serial: Build with `propeller2_debug` environment
2. Check JSON encoding: Use `get_json_buffer()` to inspect messages
3. SIL mode: See emulator logs in terminal, Playwright traces in `test-results/`
4. UI: Open DevTools, watch IPC events in `useDevice.tsx` hook

### Multi-Workspace Context
This repo has TWO workspace roots:
- `/Users/rileymccarthy/Documents/MaD/Firmware/MaDCore` (PlatformIO project)
- `/Users/rileymccarthy/Documents/MaD` (monorepo root)

When working with firmware, use the MaDCore subfolder. For cross-component changes, use monorepo root.

## Common Pitfalls

1. **Layer Violations**: Don't call `propeller2.h` directly from APP/DEV/IO - go through HAL
2. **Thread Safety**: `IO_protocol` and JSON buffer are NOT thread-safe - use locks if calling from multiple cogs
3. **Native Build Differences**: Always test native builds - pointer sizes, endianness may differ
4. **Watchdog**: All long-running cogs must kick watchdog via `dev_cogManager` channel config
5. **macOS Security**: For unsigned Electron builds, users must run `xattr -dr com.apple.quarantine "MaD Control.app"`

## MCP Integration (AI-Assisted Development)

### Available MCP Servers
- **Playwright MCP** (`.vscode/mcp.json`): Browser automation for E2E testing the Electron app

### AI Development Workflow
The MCP + terminal tools enable full-stack autonomous development:

| Task | Command |
|------|---------|
| Build firmware (native) | `cd Firmware/MaDCore && pio run -e native` |
| Build firmware (hardware) | `cd Firmware/MaDCore && pio run -e propeller2` |
| Run firmware unit tests | `cd Firmware/MaDCore && pio test -e native_test` |
| MISRA compliance check | `cd Firmware/MaDCore && pio check` |
| Start Electron dev | `cd Software/MaDControl && npm start` |
| Build Electron app | `cd Software/MaDControl && npm run package` |
| Run SIL tests | `cd SIL && make run` |
| SIL playground mode | `cd SIL && make playground` |

### Starting Playwright MCP Server
```bash
cd SIL && npx @playwright/mcp@latest
# Or from MaDControl:
cd Software/MaDControl && npm run mcp:server
```

### E2E Testing with MCP
Use Playwright MCP to interact with the running Electron app:
1. Start SIL playground: `cd SIL && make playground`
2. MCP can then navigate UI, click buttons, verify state
3. Test results saved to `SIL/test-results/`

## Key Files Reference
- `Firmware/MaDCore/platformio.ini` - Build configuration
- `Firmware/MaDCore/src/APP/app_control.h` - Main state machine
- `Firmware/MaDCore/src/DEV/Config/dev_cogManager_config.h` - COG assignments
- `Firmware/MaDCore/src/IO/IO_protocol.h` - Serial protocol definitions
- `Software/MaDControl/src/main/handlers/SerialPortHandler.ts` - Serial communication
- `Software/MaDControl/src/main/handlers/DeviceInterface.ts` - IPC handler implementations
- `Software/MaDControl/src/renderer/hooks/useDevice.tsx` - UI device state management
- `Software/MaDControl/src/renderer/components/GCodeGenerator.tsx` - Motion profile to G-code conversion
- `Software/MaDControl/src/renderer/components/TestRunner.tsx` - Test execution UI component
- `SIL/Server.py` - Test orchestration entry point
- `SIL/tests/helpers.ts` - Common test utilities

## G-Code Protocol

### Supported G-Code Commands
The firmware interprets these G-code commands for motion control:

| Code | Description | Parameters |
|------|-------------|------------|
| `G0` | Rapid move | `X<position> F<feedrate>` |
| `G1` | Linear move | `X<position> F<feedrate>` |
| `G4` | Dwell (pause) | `P<milliseconds>` |
| `G28` | Home axis | None |
| `G90` | Absolute positioning mode | None |
| `G91` | Relative/incremental positioning mode | None |
| `G122` | **STOP** - Signal test complete | None |

### G-Code Generation Flow
1. User creates Motion Profile in UI (`TestProfileForm.tsx`)
2. Motion Profile is a JSON structure with sets, executions, and moves
3. `GCodeGenerator.tsx` converts profile to G-code array
4. **IMPORTANT**: G-code must end with `G122` to signal test completion
5. G-code is streamed line-by-line via `stream-gcode` IPC channel
6. Firmware parses via `IO_gcode.c` and executes via `app_motion.c`

### Test Execution IPC Flow
```
UI (TestRunner)          Main Process              Firmware
     │                        │                        │
     ├── run-test ───────────>│                        │
     │   {sampleProfile,      │── TEST_RUN(1) ────────>│
     │    gcode[], testName}  │                        │
     │                        │                        │
     │                        │<─ testRunning:true ────│
     │<─ machine-state-updates│                        │
     │                        │                        │
     │                   [for each G-code line]        │
     │                        │── G-code line ────────>│
     │                        │<─ ACK ─────────────────│
     │                        │                        │
     │                   [G122 STOP received]          │
     │                        │<─ testRunning:false ───│
     │<─ machine-state-updates│                        │
```

## Profile File Formats

### Sample Profile (`.sp`)
Defines material properties and test limits:
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

### Motion Profile (`.mp`)
Defines test execution pattern with sets, executions, and moves:
```json
{
  "name": "Tension Test",
  "description": "Multi-cycle tension test",
  "sets": [
    {
      "name": "Conditioning Cycles",
      "executions": 3,
      "moves": [
        {
          "moveType": "linear",
          "absoluteOrRelative": "absolute",
          "moveParameters": {
            "position": 20,
            "velocity": 10,
            "distance": 0,
            "time": 0,
            "circularOffset": 0
          }
        }
      ]
    }
  ]
}
```

### Move Types
- `linear` - Linear move to position at velocity
- `dwell` - Pause for specified time (milliseconds in `time` parameter)
- `circular-cw` / `circular-ccw` - Circular arc moves
- `math` - Mathematical function moves (not fully implemented)

## SIL Test Architecture

### Test File Organization
```
SIL/tests/
├── helpers.ts                    # Common utilities (launchMaDControl, connectToEmulator, etc.)
├── global-setup.ts               # Pre-test: build firmware, start emulator
├── global-teardown.ts            # Post-test: cleanup processes
├── basic-connection.spec.ts      # App launch and serial connection tests
├── connect-serial.spec.ts        # Serial port management tests
├── dashboard-motion.spec.ts      # Dashboard UI and motion control tests
└── profile-test-execution.spec.ts # Profile creation and test execution tests
```

### Test Fixtures
```
SIL/test-fixtures/
├── sample-profile.sp             # Test sample profile
├── motion-profile-simple.mp      # Simple 3-move test profile
└── motion-profile-complex.mp     # Multi-set complex profile
```

### Writing SIL Tests
```typescript
import { test, expect } from '@playwright/test';
import { launchMaDControl, connectToEmulator, getMachineState } from './helpers';

test.describe('Feature Tests', () => {
  let app: ElectronApplication;
  let window: Page;

  test.beforeAll(async () => {
    const launched = await launchMaDControl();
    app = launched.app;
    window = launched.window;
    await connectToEmulator(window, '/tmp/tty.rpi');
  });

  test.afterAll(async () => {
    await app?.close();
  });

  test('should do something', async () => {
    // Navigate
    await window.getByRole('link', { name: 'Dashboard' }).click();
    
    // Interact
    await window.getByRole('button', { name: 'Enable Motion' }).click();
    
    // Assert
    await expect(window.getByText('Enabled')).toBeVisible();
  });
});
```

### Key Test Selectors
| Element | Selector |
|---------|----------|
| Navigation links | `getByRole('link', { name: 'Dashboard' })` |
| Buttons | `getByRole('button', { name: 'Enable Motion' })` |
| Headings | `getByRole('heading', { name: 'Sample Profile' })` |
| File inputs | `locator('input[type="file"][accept=".sp"]')` |
| Text (exact) | `getByText('Force (N)', { exact: true })` |

## State Machine Details

### Machine States (`app_control.h`)
```
DISABLED ──> RESTRICTED ──> MANUAL
                │              │
                │              v
                └──────────> TEST
```

- **DISABLED**: Motion not enabled, safe state
- **RESTRICTED**: Motion enabled but limited by restrictions
- **MANUAL**: Free motion control via UI buttons
- **TEST**: Automated test execution via G-code

### Restrictions (`app_control_restriction_E`)
- `UPPER_ENDSTOP` / `LOWER_ENDSTOP` - Physical limits
- `MAX_FORCE` / `MAX_TENSION` - Force limits
- `MAX_POSITION` - Position limits
- `GAUGE_LENGTH` - Sample gauge length issues

### Faults (`app_control_fault_E`)
- `COG` - Cog manager failure
- `WATCHDOG` - Watchdog timeout
- `STEPPER` - Stepper driver communication error
- `FORCE_GAUGE` - Force gauge communication error

## Common Test Debugging

### View Test Traces
```bash
cd SIL
npx playwright show-trace test-results/artifacts/<trace-file>.zip
```

### View Test Videos
Videos are saved to `SIL/test-results/artifacts/<test-name>/video.webm`

### Common Issues
1. **Stale processes**: Kill with `pkill -f 'Server.py|mad-firmware-native|socat'`
2. **Serial port busy**: Check `/tmp/tty.rpi*` exists and no other process using it
3. **Element not found**: Use `{ exact: true }` for text that matches multiple elements
4. **Test timeout**: Increase timeout or check firmware is responding
5. **Dialog handling**: Use `.last()` to select dialog buttons vs main page buttons

## IPC Channel Reference

### Renderer → Main (invoke)
| Channel | Parameters | Description |
|---------|------------|-------------|
| `connect-serial` | `{port, baudRate}` | Connect to serial port |
| `disconnect-serial` | None | Disconnect from serial |
| `device-connected` | None | Check if device connected |
| `run-test` | `{sampleProfile, gcode[], testName}` | Start test execution |
| `stream-gcode` | `{line}` | Stream single G-code line |
| `save-sample-profile` | `{profile}` | Save sample profile |

### Main → Renderer (events)
| Channel | Data | Description |
|---------|------|-------------|
| `sample-data-updates` | `SampleData` | Real-time sample measurements |
| `machine-state-updates` | `MachineState` | Machine state changes |
| `device-status-changed` | `{connected, error}` | Connection status |
| `test-progress` | `{current, total}` | G-code execution progress |
- `SIL/MaDSim/VirtualSerialPort.py` - Serial emulation
- `.vscode/mcp.json` - MCP server configuration
