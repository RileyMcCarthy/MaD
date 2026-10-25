# Machine configuration

The **machine configuration** is the calibration and limits stored on the machine
itself. It describes *this* machine — its mechanics and sensors — and rarely
changes. You read and edit it on the **Settings** screen.

![Settings, including machine configuration](../assets/screenshots/08-settings.png)

## Reading & writing

- The configuration loads from the device when you open **Settings** while
  connected.
- Edit a field, then **Write to device** to write it back to the machine, where it
  persists across power cycles.
- **Read from device** re-reads the configuration, discarding unsaved edits.

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

## Motor calibration

The **Motor calibration** panel on **Settings**, below the fields, checks that
**Encoder (step/mm)** and **Servo (step/mm)** match the hardware. It drives the
carriage a short distance forward and then back **open loop**, and compares how
far the encoder moved with what the two values predict.

Open loop means the servo runs its usual motion profile but ignores the
encoder: the drive gets exactly the pulses the move calls for, and the encoder
is only watched. The panel sends these moves as `G124`, a linear move with the
servo feedback off (`G91` first, so they are relative). It reads the encoder
from the live position after each move has come to rest.

It is **report only**. Nothing is written to the machine: the result tells you
what to fix, and you change the fields (and **Write to device**) yourself. The
fields don't need saving first. The panel judges the values you have typed, but
the machine needs *some* steps/mm saved, because it uses them to convert the
move and the position.

### Before you run it

- Enable motion and clear any fault.
- Leave the carriage clear of both end stops, with room to move the test
  distance in each direction.
- Don't start a test or jog while it runs.

**Distance each way** defaults to 5 mm and **Speed** to 1 mm/s, so a run takes
about 11 seconds. A shorter distance still gives a pass or fail, but each run
loses a few encoder counts at its ends, which matters more on a short run. The
moves obey the usual motion rules: the profile's maximum speed and acceleration,
and the restricted speed while the machine is restricted. The panel disables
motion if the encoder moves more than three times the distance the profile
expects, and allows at most 200 000 pulses each way.

### Reading the result

The run ends with a single result: a **pass**, **warning** or **error** with
what it means, then the one thing the run measures:

> Sent 6405 pulses each way (1 mm at 6400 servo steps/mm) → encoder moved **2398** counts (expected 2402)

The pulses are what the machine sent, and the counts are what the encoder saw
come back (averaged over both directions). *Expected* is what your two steps/mm
values predict for those pulses. When the calibration passes the two match. A
negative count means the encoder counts against the motion.

When they don't match, a **Fix** line gives the value to change. One run only
measures the ratio of the two values, so it gives both options: the servo
steps/mm to set if your encoder steps/mm is right, and the encoder steps/mm to
set if your servo steps/mm is right. Trust the one you can work out from
datasheets (usually the encoder: counts per revolution ÷ mm per revolution).

### What the findings mean

| Finding | What it means | What to do |
|---|---|---|
| Calibration passed | The encoder follows the motor in the right direction, and the two steps/mm values match the hardware (within 2%) | Nothing |
| The encoder did not count in either direction | No encoder counts at all | Check that the encoder is coupled to the motor, that A and B reach the board, that it shares a ground with the board, and that its outputs have pull-ups |
| The encoder counted only one way | One channel is missing, or the carriage did not move one way | Check the encoder wiring and that the carriage moves both ways |
| The encoder counts the opposite way to the motion | The encoder is reversed relative to the drive. The servo loop would run away as wired | Swap encoder A and B, or reverse the drive's direction setting |
| The encoder counted the same way whichever way the carriage was driven | The carriage did not reverse, or the direction signal is wrong | Check the drive direction wiring |
| The steps/mm entered don't match the hardware | The counts that came back differ from the expected counts by more than 2%, so one of the two steps/mm values is wrong | Use the **Fix** line: change the value you trust less |
| Forward and back differ by *n*% | The two directions disagree by more than 2% | Look for slip, backlash or lost pulses |

!!! warning "Encoder steps/mm must equal servo steps/mm in this firmware"
    The servo loop sends one drive pulse per encoder count. If the two values
    differ, the panel warns you even when the measurement matches. Set the
    drive's pulses per revolution to the encoder's counts per revolution, then
    set both fields to the same value.

### Runs that don't finish

| Message | Why | What to do |
|---|---|---|
| Not run: enable motion (and clear any fault) first | Motion was off or the machine was faulted | Enable motion, clear the fault |
| Not run: the machine is busy with a move or a test | A test was running, or the machine turned the move down | Wait for it to finish |
| Not run: no live position from the machine | No samples are arriving | Check the connection |
| Stopped: motion was disabled | Motion was turned off mid-run, or a fault disabled it | Clear the cause, run it again |
| Stopped: the carriage was still moving long after the pulses should have finished | It hadn't settled after twice the move's time plus 3 seconds | Check the drive and the mechanics |
| Stopped: the encoder moved over three times further than the profile expects | The drive is set much finer than servo steps/mm says, or encoder steps/mm is far too low | Check both values |
