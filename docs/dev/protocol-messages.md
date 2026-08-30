# Protocol messages

The MaD message map, generated from
[`Protocol/MaDProtocol.yaml`](https://github.com/RileyMcCarthy/MaD/blob/main/Protocol/MaDProtocol.yaml).
For the wire framing and encoding rules, see
[Communication protocol](../how-it-works/protocol.md) and the
[wire-format spec](https://github.com/RileyMcCarthy/protoemb/blob/main/docs/wire-format.md).

`protocol_version: 1`. Nodes: `ui`, `madcore`.

## Reads (host requests, device responds with DATA)

| Message | CMD | Period | Priority | Response struct |
|---|---|---|---|---|
| `sample` | 0 | ~10 ms | low | `Sample` |
| `state` | 1 | ~1 s | low | `MachineState` |
| `machine_configuration` | 2 | on demand | high | `MachineConfiguration` |
| `firmware_version` | 3 | on demand | high | `FirmwareVersion` |
| `sample_profile` | 4 | on demand | high | `SampleProfile` |

## Writes (host commands, device ACK/NACKs)

| Message | CMD | Priority | Request |
|---|---|---|---|
| `machine_configuration_write` | 0 | high | `MachineConfiguration` |
| `motion_enable` | 1 | high | `bool` |
| `test_run` | 2 | high | `TestRun` |
| `manual_move` | 3 | high | `Move` |
| `test_move` | 4 | high | `Move` (empty payload opens the gcode channel; packed moves are appended) |
| `sample_profile_write` | 5 | high | `SampleProfile` |
| `gauge_length` | 6 | high | none |
| `gauge_force` | 7 | high | none |
| `test_waveform` | 8 | high | `WaveformMove` — appends a `G123` waveform record to the open gcode channel |
| `file_download` | 9 | high | raw → `StoredSample` |

`file_download` sends a binary request (`testName(16) + sampleIndex(u32) +
sampleCount(u32)`) and the device streams `StoredSample` records.

## Async (device transmits unsolicited)

| Message | Priority | Payload |
|---|---|---|
| `notification` | high | `Notification` (type + message) |

## Structs & wire sizes

| Struct | Encoding | Wire size | Purpose |
|---|---|---|---|
| `Sample` | packed | 12 B | Live force/position/setpoint at ~100 Hz |
| `MachineState` | packed | 2 B | Fault, restriction, motion enabled, test running |
| `Move` | packed | 8 B | A G-code move (position/velocity/dwell) |
| `WaveformMove` | packed | 9 B | A `G123` waveform canned cycle (shape, amplitude, frequency, cycles) |
| `StoredSample` | packed | 11 B | A logged sample data point |
| `MachineConfiguration` | aligned | 64 B | Calibration & limits (NVRAM) |
| `SampleProfile` | aligned | 20 B | Per-test material limits |
| `TestRun` | aligned | 14 B | gcodeId + testDataId references |
| `FirmwareVersion` | aligned | 16 B | Version string |
| `Notification` | aligned | 101 B | Type + message string |

## Enums

- **`FaultedReason`** — `NONE, COG, WATCHDOG, ESD_POWER, ESD_SWITCH, ESD_UPPER,
  ESD_LOWER, SERVO_COMMUNICATION, FORCE_GAUGE_COMMUNICATION`
- **`RestrictedReason`** — `NONE, SAMPLE_LENGTH, SAMPLE_TENSION, MACHINE_TENSION,
  UPPER_ENDSTOP, LOWER_ENDSTOP, DOOR`
- **`MotionState`** — `DISABLED, WAITING, MOVING`
- **`GCode`** — `RAPID_MOVE(0), LINEAR_MOVE(1), CW_ARC(2), CCW_ARC(3), DWELL(4),
  HOME(28), ABSOLUTE(90), INCREMENTAL(91), STOP(122), WAVEFORM(123)` (the values
  are the G-code numbers; `STOP` is the test-complete `G122`, `WAVEFORM` is the
  firmware-native `G123` canned cycle)
- **`WaveformShape`** — `SINE, TRIANGLE` (firmware-native `G123` is SINE-only in
  v1; the app pins triangle to sine)
- **`NotificationType`**, **`LoggingState`**

See [States, faults & restrictions](../user-guide/machine-states.md) for what each
fault and restriction means.
