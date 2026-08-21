# Live monitoring

The **Live** screen is the hub: real-time readouts, machine state, manual
controls, and live charts, all updating continuously while you're connected.

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

Forces are shown in **N**, positions in **mm**.

## Machine state

The **State** badges summarise what the machine is doing:

- **Motion** — whether motion is enabled.
- **Test** — whether a test is running.
- **Fault** — something needs attention. A fault stops motion and usually needs a
  machine reboot to clear.
- **Restriction** — something is currently *limiting* motion, such as an endstop
  or an open door. Restrictions clear on their own once the cause is resolved.

Hover any fault or restriction badge for a plain-language explanation of that
specific code. [States, faults & restrictions](machine-states.md) lists them all.

## Live charts

### Force & Position

A dual-axis, 60-second rolling chart plots **position** (left axis) and **force**
(right axis) together. You can:

- Toggle between **Machine** and **Sample** coordinates.
- See **limit reference lines** (max force / max position) drawn from the machine
  configuration and the loaded sample profile.
- **Pause** the sweep to inspect a moment without losing the connection.

When you connect, the chart is pre-filled with the machine's most recent
readings, so you see recent history straight away rather than an empty plot.

### Stress–strain

A live stress–strain scatter accumulates **only while a test is running** and
clears at the start of each test, with max-stress / max-strain limit lines from
the sample profile.

## Controls

The manual **controls** (Enable motion, Home, Zero, Jog) also live on this
screen — see [Manual control](manual-control.md).
