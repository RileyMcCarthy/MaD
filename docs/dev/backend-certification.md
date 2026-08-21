# Motion backend certification

MaD firmware can drive motion through **stepper** or **servo** backends.
CI unit and SIL coverage default to the **stepper** path.

| Backend | Automated coverage | Status |
|---------|-------------------|--------|
| **Stepper** (`dev_stepper`) | Unity `test_dev_stepper`, `test_app_motion` (stepper-pinned), SIL/WASM e2e | **Certified for CI** |
| **Servo** (`dev_servo`) | Unity `test_dev_servo` (enable/move/velocity/stop/stall contracts) | **Unit-certified** — SIL still links stepper; HIL for plant fidelity |

## PR checklist

When changing motion/HAL:

1. Prefer tests against the stepper backend (what SIL links).
2. If the change is servo-only, say so in the PR template “Backend certification”
   section and describe manual/HIL verification.
3. Do not claim “motion covered” in CI unless the stepper suite still passes.

## Servo unit suite

- `test_dev_servo` covers enable, moveTo/atTarget, velocity mode, stop, setPosition,
  following-error readout, and stall detection against HAL doubles.
- SIL/WASM e2e still exercise the **stepper** backend (default plant). Plant-model
  servo fidelity remains HIL / future SIL flag work.
