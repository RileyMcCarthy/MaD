# Motion backend certification

MaD firmware has one motion backend: the closed-loop servo, **`dev_servo`**,
driven by `app_motion` on the MOTOR cog. The open-loop `dev_stepper` path was
removed once nothing built it.

| Layer | Automated coverage |
|-------|--------------------|
| `dev_servo` | Unity `test_dev_servo`: enable, moveTo/atTarget, velocity mode, stop, setPosition, following error, waveforms, the profile's pulse scale, and the stall guard (following-error hard ceiling at once, soft band after persistence, and the travel check on the step pulses; frozen, buzzing, crawling, runaway, a dead encoder or a jam near the target, during a small waveform or at tensile speed, a frame redefined mid-tick, and no trip on lagging-drive stops, reversals or waveforms) against HAL doubles |
| `app_motion` | Unity `test_app_motion` against `dev_servo` doubles, including encoder-scaled moves and profile validation |
| The machine | SIL: the P2 image on the ISS with `mad-emulator`'s drive, encoder and jam (`make e2e-motion`, SERVO-stall on every PR) |

## PR checklist

When changing motion/HAL:

1. Run `test_dev_servo` and `test_app_motion` (`pio test -e native_test -f …`).
2. If the change touches how the carriage moves, run the motion e2e on
   `mad-emulator` (`make -C SIL e2e-motion`) or say why it was not needed.
3. Hardware the SIL cannot model (the real drive, its tuning) still needs a
   bench check; say in the PR what was and was not run there.
