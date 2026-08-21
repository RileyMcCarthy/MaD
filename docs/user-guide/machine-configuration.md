# Machine configuration

The **machine configuration** is the calibration and limits stored on the machine
itself. It describes *this* machine — its mechanics and sensors — and rarely
changes. You read and edit it on the **Settings** screen.

![Settings, including machine configuration](../assets/screenshots/08-settings.png)

## Reading & writing

- The configuration loads from the device when you open **Settings** while
  connected.
- Edit a field, then **Save to device** to write it back to the machine, where it
  persists across power cycles.
- **Reload from device** re-reads the configuration, discarding unsaved edits.

!!! warning "These values calibrate the machine"
    Getting the steps-per-mm or force calibration wrong will make every
    measurement wrong (and could drive the gantry past safe limits). Change these
    only if you know the machine's mechanics.

## Fields

These are the fields as they appear on the Settings screen, in order.

| Field | What it sets |
|---|---|
| **Name** | A label for this machine |
| **Encoder (step/mm)** | Encoder counts per millimetre of travel |
| **Servo (step/mm)** | Motor pulses per millimetre of travel |
| **Force Gauge (N/step)** | How much force one gauge reading step represents |
| **Force Gauge Zero Offset (steps)** | The gauge's zero point |
| **Position Max (mm)** | How far the jaw is allowed to travel |
| **Velocity Max (mm/s)** | Fastest the machine will move |
| **Acceleration Max (mm/s²)** | How hard the machine is allowed to accelerate |
| **Tensile Force Max (N)** | Force at which the machine protects itself |
| **Homing Velocity (mm/s)** | Speed used when homing |
| **Homing Offset (mm)** | Offset applied after homing |
| **Jaw Offset (mm)** | Distance from the home reference to the jaw |

These are *machine* limits — distinct from the per-test limits you set in a
[sample profile](sample-profiles.md). Both are enforced, and whichever is more
conservative wins.
