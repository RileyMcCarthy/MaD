# Live monitoring

The **Live** screen is the hub: real-time readouts, machine state, manual
controls, and live charts, all updating from the ~100 Hz sample stream.

![The Live screen](../assets/screenshots/02-live.png)

## Readouts

The top row shows live numeric values. Each has a tooltip explaining it (hover to
read):

| Readout | Meaning |
|---|---|
| **Machine Force** | Force measured at the gauge, in machine coordinates |
| **Machine Position** | Gantry position from the encoder |
| **Machine Setpoint** | The position the motion controller is targeting |
| **Sample Force** | Force in sample coordinates (zeroed at the gauge) |
| **Sample Position** | Extension of the sample relative to its gauge length |

Forces are shown in **N**, positions in **mm**. (On the wire these are
firmware-native mN and µm; the app converts them — see the
[unit conventions](../how-it-works/protocol.md#units).)

## Machine state

The **State** badges summarise what the firmware reports:

- **Motion** — whether motion is enabled.
- **Test** — whether a test is running (`idle` / running).
- **Fault** — a latched fault that requires attention (e.g. `COG`, `WATCHDOG`,
  `ESD_*`, `SERVO_COMMUNICATION`). Faults generally require a reboot.
- **Restriction** — a condition currently *limiting* motion (e.g.
  `UPPER_ENDSTOP`, `DOOR`, `SAMPLE_TENSION`). Restrictions clear on their own
  when the condition resolves.

Hover any fault or restriction badge for an explanation. The full list is in the
[states, faults & restrictions reference](../reference/machine-states.md).

## Live charts

### Force & Position

A dual-axis, 60-second rolling chart plots **position** (left axis) and **force**
(right axis) together. You can:

- Toggle between **Machine** and **Sample** coordinates.
- See **limit reference lines** (max force / max position) drawn from the machine
  configuration and the loaded sample profile.
- **Pause** the sweep to inspect a moment without losing the connection.

When you connect, the chart is **seeded** from the device's on-board sample ring
buffer, so you immediately see recent history rather than an empty plot.

### Stress–strain

A live stress–strain scatter accumulates **only while a test is running** and
clears at the start of each test, with max-stress / max-strain limit lines from
the sample profile.

## Controls

The manual **controls** (Enable motion, Home, Zero, Jog) also live on this
screen — see [Manual control](manual-control.md).
