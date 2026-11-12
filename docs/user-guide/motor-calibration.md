# Motor calibration

The **Motor calibration** box on **Settings**, below
[Machine configuration](machine-configuration.md), has two routines. Run them
in order:

![The Motor calibration panel](../assets/screenshots/motor-calibration.png)


1. **Drive and encoder check.** Checks that **Encoder (step/mm)** and
   **Servo (step/mm)** match the hardware and that the encoder counts the way
   the carriage moves. It drives the carriage 5 mm forward and back at 1 mm/s
   **open loop**: the servo runs its usual motion profile but ignores the
   encoder, so the drive gets exactly the pulses the move calls for, and the
   encoder is only watched. These moves are sent as `G124`, a linear move with
   the servo feedback off.
2. **Motion calibration.** Runs a short test program **closed loop**. It checks
   the machine can deliver **Acceleration Max**, measures how closely the servo
   follows its encoder, and **suggests servo gains** (Kp and Ki). It unlocks
   only once the check has passed in this session on the steps/mm **saved** on
   the machine, because it moves on those, and it uses the drive lag the check
   measured.

Both are **report only**. Nothing is written to the machine: you change the
fields (and **Write to device**) yourself.

!!! warning "The saved profile's motion limits must be right first"
    The motion calibration is built from the profile **saved on the machine**:
    **Velocity Max**, **Acceleration Max** and **Position Max**. Its longest
    move is a tenth of Position Max, swung half either side of where the
    carriage starts, at up to Velocity Max. The panel shows the distance and
    speeds before you run it. Leave that much room each way.

## Before you run it

- Enable motion and clear any fault.
- Leave the carriage clear of both end stops, with the room the panel asks for.
- Don't start a test or jog while it runs.

Before each measured leg of the check, a 0.5 mm move in the same direction
takes up any slack, so slack doesn't count against the ratio. The panel
disables motion if the encoder moves more than three times the distance the
profile expects.

The check judges the steps/mm you have **typed**. If those differ from the ones
saved on the machine, **Run motion calibration** stays locked and the panel
asks you to write them, restart the machine, and run the check again.

To restart the machine, power-cycle it: reconnecting the app does not restart
it.

While a routine runs, its button shows the step it is on and the other
routine is locked:

![The check while it runs](../assets/screenshots/motor-calibration-check-running.png)

## Reading the result

The **drive and encoder check** shows a **pass**, **warning** or **error**,
then what the run measured:

![A passing drive and encoder check](../assets/screenshots/motor-calibration-check-result.png)

> Sent 32000 pulses each way → encoder moved **12000** counts (expected 12000)

The pulses are what the machine sent, and the counts are what the encoder saw
come back (averaged over both directions). If the encoder counted only one way,
or counted the same way in both directions, an average would point at the wrong
fault, so the line shows each direction's counts instead (for example
"forward 2400 · back 2400"). *Expected* is what your two steps/mm values
predict. When they don't match, a **Fix** line gives the value to
change. One run only measures the ratio of the two values, so it gives both
options. Trust the one you can work out from datasheets (usually the encoder:
counts per revolution ÷ mm per revolution).

![A check that found the steps/mm don't match](../assets/screenshots/motor-calibration-check-mismatch.png)

It also reports:

- **Lost motion on reversal**: how far the carriage falls short on the move
  straight after a change of direction. This is slack, backlash or the motor
  settling against friction. Harsh reversals (a high Acceleration Max) make it
  larger.
- **Drive lag**: how far behind the pulses the encoder runs at a steady speed.

The **motion calibration** program ramps at Acceleration Max up to a quarter,
half, three quarters and all of Velocity Max, each speed out, back and out again
so both directions are covered. Every move the firmware runs accelerates at
Acceleration Max, so ramping to rising speeds is how it tests that one value:
a motor has less torque the faster it turns. Then come 1 mm, 0.1 mm and 0.01 mm
moves in both directions.

![Motion calibration results](../assets/screenshots/motor-calibration-motion-result.png)

**Acceleration** says whether the carriage kept up:

- **pass**: it delivered Acceleration Max at every speed up to the one shown.
  If a tenth of Position Max is too short to reach Velocity Max at that
  acceleration, the report shows the speed it did reach, and ramps to higher
  speeds are untested.
- **too high**: on at least one ramp the carriage delivered under 80% of
  Acceleration Max. A carriage that can't accelerate as fast as its trajectory
  falls behind it through the ramp, so the following error beyond what the
  drive lag explains, divided by the ramp's length, is the share it fell short
  by. Lower **Acceleration Max** (or **Velocity Max**), write, restart and run
  it again.
- **not judged**: the run stopped before every speed had been measured.

The table gives each speed's peak following error and the share of
Acceleration Max delivered. The servo's corrections during a ramp hide part of
a shortfall, so treat a marginal pass with care; a carriage that stalls fails
clearly.

**Tracking** sums up the program: the largest stop error, the peak following
error (the gap between where the trajectory is and where the encoder is), the
largest overshoot, and the longest settle time. **Each move** expands to the
per-move numbers. These are measured against the machine's **own encoder**:
they show how well the servo follows it, not the carriage's true position, which
needs an external reference.

**Suggested servo gains** gives a starting Kp and Ki, with the reasons:

- **Kp** is the largest that is still safe: at most 0.5 ÷ the drive lag (above
  that, corrections arrive too late and the carriage rings), and at most
  Acceleration Max ÷ Velocity Max (above that, an ordinary error asks for more
  than the acceleration limit).
- **Ki** is only suggested when moves end consistently short (or past) in their
  direction of travel, at Kp² ÷ 8. Otherwise it stays 0, because an integral
  with nothing to correct only adds overshoot.

To try them, enter **Servo Kp (1/s)** and **Servo Ki (1/s^2)**, **Write to
device**, restart the machine, and run the motion calibration again to compare.

## What the findings mean

| Finding | What it means | What to do |
|---|---|---|
| Calibration passed | The encoder follows the motor in the right direction, and the two steps/mm values match the hardware (within 2%) | Nothing |
| The encoder did not count in either direction | No encoder counts at all | Check that the encoder is coupled to the motor, that A and B reach the board, that it shares a ground with the board, and that its outputs have pull-ups |
| The encoder counted only one way | One channel is missing, or the carriage did not move one way | Check the encoder wiring and that the carriage moves both ways |
| The encoder counts the opposite way to the motion | The encoder is reversed relative to the drive. The servo loop would run away as wired | Swap encoder A and B, or reverse the drive's direction setting |
| The encoder counted the same way whichever way the carriage was driven | The carriage did not reverse, or the direction signal is wrong | Check the drive direction wiring |
| The steps/mm entered don't match the hardware | The counts that came back differ from the expected counts by more than 2%, so one of the two steps/mm values is wrong | Use the **Fix** line: change the value you trust less |
| Forward and back differ by *n*% | The two directions disagree by more than 2% | Look for slip, backlash or lost pulses |

## Runs that don't finish

These are for the drive and encoder check. The motion calibration stops with
"the carriage went further than a move asked for", "motion was disabled",
"a move never finished" or "the machine turned a move down".

| Message | Why | What to do |
|---|---|---|
| Not run: enable motion (and clear any fault) first | Motion was off or the machine was faulted | Enable motion, clear the fault |
| Not run: the machine is busy with a move or a test | A test was running, or the machine turned the move down | Wait for it to finish |
| Not run: no live position from the machine | No samples are arriving | Check the connection |
| Stopped: motion was disabled | Motion was turned off mid-run, or a fault disabled it | Clear the cause, run it again |
| Stopped: the carriage was still moving long after the pulses should have finished | It hadn't settled after twice the move's time plus 3 seconds | Check the drive and the mechanics |
| Stopped: the encoder moved over three times further than the profile expects | The drive is set much finer than servo steps/mm says, or encoder steps/mm is far too low | Check both values |

