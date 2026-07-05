# Protocol messages

The MaD message map, generated from
[`Protocol/MaDProtocol.yaml`](https://github.com/RileyMcCarthy/MaD/blob/main/Protocol/MaDProtocol.yaml).
For the wire framing and encoding rules, see
[Communication protocol](../how-it-works/protocol.md) and the
[wire-format spec](https://github.com/RileyMcCarthy/MaD/blob/main/Protocol/ProtoEmb/docs/wire-format.md).

`protocol_version: 1`. Nodes: `ui`, `madcore`.

## Reads (host requests, device responds with DATA)

| Message | CMD | Period | Response struct |
|---|---|---|---|
| `sample` | 0 | ~10 ms | `Sample` |
| `state` | 1 | ~1 s | `MachineState` |
| `machine_configuration` | 2 | on demand | `MachineConfiguration` |
| `firmware_version` | 3 | on demand | `FirmwareVersion` |
| `sample_profile` | 4 | on demand | `SampleProfile` |

## Writes (host commands, device ACK/NACKs)

| Message | CMD | Priority | Request |
|---|---|---|---|
| `machine_configuration_write` | 0 | — | `MachineConfiguration` |
| `motion_enable` | 1 | — | `bool` |
| `test_run` | 2 | — | `TestRun` |
| `manual_move` | 3 | — | `Move` |
| `test_move` | 4 | — | `Move` |
| `sample_profile_write` | 5 | — | `SampleProfile` |
| `gauge_length` | 6 | high | none |
| `gauge_force` | 7 | high | none |
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
| `Move` | packed | 7 B | A G-code move (position/velocity/dwell) |
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
  HOME(28), ABSOLUTE(90), INCREMENTAL(91), STOP(122)` (the values are the G-code
  numbers; `STOP` is the test-complete `G122`)
- **`NotificationType`**, **`LoggingState`**

See [States, faults & restrictions](machine-states.md) for what each fault and
restriction means.
