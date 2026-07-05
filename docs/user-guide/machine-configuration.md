# Machine configuration

The **machine configuration** is the calibration and limits stored in the
machine's non-volatile memory (NVRAM). It describes *this* machine — its
mechanics and sensors — and rarely changes. You read and edit it on the
**Settings** screen.

![Settings, including machine configuration](../assets/screenshots/08-settings.png)

## Reading & writing

- The configuration loads from the device when you open **Settings** while
  connected.
- Edit a field, then **Save to device** to write it back to the machine's NVRAM.
- **Reload from device** re-reads the configuration, discarding unsaved edits.

!!! warning "These values calibrate the machine"
    Getting the steps-per-mm or force calibration wrong will make every
    measurement wrong (and could drive the gantry past safe limits). Change these
    only if you know the machine's mechanics.

## Fields

| Field | Unit | What it sets |
|---|---|---|
| `name` | — | A label for this machine profile |
| `encoderStepsPerMM` | steps/mm | Encoder counts per millimetre of travel |
| `servoStepsPerMM` | steps/mm | Stepper pulses per millimetre of travel |
| `forceGaugeNPerStep` | N/step | Force-gauge ADC calibration |
| `forceGaugeZeroOffset` | steps | Force-gauge zero offset |
| `maxPosition` | mm | Soft travel limit |
| `maxVelocity` | mm/s | Maximum commanded velocity |
| `maxAcceleration` | mm/s² | Maximum commanded acceleration |
| `maxForceTensile` | N | Machine-protection tensile force limit |
| `homingVelocity` | mm/s | Speed used when homing |
| `homingOffset` | mm | Offset applied after homing |
| `jawOffset` | mm | Distance from the home reference to the jaw |

These limits are *machine* limits — distinct from the per-test limits you set in
a [sample profile](sample-profiles.md). Both are enforced; whichever is more
conservative wins.

The configuration is part of the [communication protocol](../how-it-works/protocol.md)
as the `MachineConfiguration` struct — see the
[protocol reference](../reference/protocol-messages.md).
