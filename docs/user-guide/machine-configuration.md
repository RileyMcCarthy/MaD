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
carriage a short distance forward and then back **open loop** (the servo loop is
out of the path), and compares how far the encoder moved with what the two
values predict.

It is **report only**. Nothing is written to the machine: the findings tell you
what to fix, and you change the fields (and **Write to device**) yourself.

### Before you run it

- Enable motion and clear any fault.
- Leave the carriage clear of both end stops, with room to move the test
  distance in each direction.
- Close the door, and make sure the frame isn't loaded past its tension limit.
  The calibration does not run while the machine is speed-restricted (see
  below).
- Don't start a test. A test can't start while a calibration is running.

**Distance each way** defaults to 1 mm and **Speed** to 1 mm/s. The panel shows
the pulses and rate it will send, and the encoder bound at which it gives up
(three times the distance the profile expects). The machine allows at most
200 000 pulses each way and 20 000 pulses/s.

### What the findings mean

| Finding | What it means | What to do |
|---|---|---|
| The encoder counts the way the carriage moves, at the rate the profile expects | The two steps/mm values match the hardware (within 2%) | Nothing |
| The encoder did not count in either direction | No encoder counts at all | Check that the encoder is coupled to the motor, that A and B reach the board, that it shares a ground with the board, and that its outputs have pull-ups |
| The encoder counted only one way | One channel is missing, or the carriage did not move one way | Check the encoder wiring and that the carriage moves both ways |
| The encoder counts the opposite way to the motion | The encoder is reversed relative to the drive. The servo loop would run away as wired | Swap encoder A and B, or reverse the drive's direction setting |
| The encoder counted the same way whichever way the carriage was driven | The carriage did not reverse, or the direction signal is wrong | Check the drive direction wiring |
| Measured *x* counts per pulse; the profile implies *y* | One of the two steps/mm values is wrong. The report shows both implied values: the **servo** steps/mm if encoder steps/mm is right, and the **encoder** steps/mm if servo steps/mm is right | Work out which value you trust and correct the other |
| Forward and back differ by *n*% | The two directions disagree by more than 2% | Look for slip, backlash or lost pulses |

!!! warning "Encoder steps/mm must equal servo steps/mm in this firmware"
    The servo loop sends one drive pulse per encoder count. If the two values
    differ, the panel warns you even when the measurement matches. Set the
    drive's pulses per revolution to the encoder's counts per revolution, then
    set both fields to the same value.

### Refusals and stops

A **refusal** means the calibration never started and no pulses were sent. A
**stop** means it was abandoned part way. The carriage is then held closed loop
where it stopped, except when a jog has taken over the drive (below).

| Message | Why | What to do |
|---|---|---|
| Refused: enable motion (and clear any fault) first | Motion was off or the machine was faulted | Enable motion, clear the fault |
| Refused: a move or a test is running | The carriage was already moving | Wait for it to finish |
| Refused: the carriage is on an end stop | One of the two legs would push into the stop | Jog it clear first |
| Refused: the machine is speed-restricted | The door is open or the frame is over its tension limit. The calibration can't honour the restricted-speed cap, so it does not run | Close the door, or take the load off the frame |
| Stopped: motion was disabled | Motion was turned off mid-run | Run it again |
| Stopped: the machine faulted | A fault mid-run | Clear the fault, run it again |
| Stopped: the carriage reached an end stop | An end stop was hit mid-run | Jog clear, shorten the distance |
| Stopped: the machine became speed-restricted | The door was opened or a tension limit tripped mid-run | Clear the restriction, run it again |
| Stopped: a jog took the drive | You jogged during the run. Jogs are never refused for a calibration, but while one runs they move at the **restricted speed** (the profile's **Restricted Velocity (mm/s)**), or at 2 mm/s if that is 0. The jog carries on and the calibration gives way. **Home** is refused while a calibration runs | Run it again |
| Stopped: the drive took far longer than expected | The pulses didn't go out in twice their nominal time plus a second | Check the drive |
| Stopped: the encoder moved over three times further than the profile expects | The drive is set much finer than servo steps/mm says, or encoder steps/mm is far too low | Check both values |
