# Motion backend certification

MaD firmware can drive motion through **stepper** or **servo** backends.
CI unit and SIL coverage default to the **stepper** path.

| Backend | Automated coverage | Status |
|---------|-------------------|--------|
| **Stepper** (`dev_stepper`) | Unity `test_dev_stepper`, `test_app_motion` (stepper-pinned), SIL/WASM e2e | **Certified for CI** |
| **Servo** (`dev_servo`) | No dedicated Unity suite yet | **Not CI-certified** — hardware/HIL or future unit suite |

## PR checklist

When changing motion/HAL:

1. Prefer tests against the stepper backend (what SIL links).
2. If the change is servo-only, say so in the PR template “Backend certification”
   section and describe manual/HIL verification.
3. Do not claim “motion covered” in CI unless the stepper suite still passes.

## Adding servo certification later

- Add `test_dev_servo` with the same move/queue/home contracts as stepper where
  the public API is shared.
- Optionally add a SIL feature flag for servo models.
- Promote this table when those gates are green.
