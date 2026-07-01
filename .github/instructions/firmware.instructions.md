---
applyTo: "Firmware/MaDCore/src/**"
---

Firmware (C, Propeller 2). Full conventions: `docs/coding-guidelines/c-firmware.md`
(MISRA C idioms, naming, template/banner layout, HAL locking discipline).

Enforce especially the rules no linter checks:
- the downward-only layer rule (`APP → DEV → IO → Library → HAL → HW`) and no MCU headers
  above the HAL (`IO_Debug.h` is the sanctioned upward-logging exception);
- HAL lock **non-reentrancy** and **never call another module's API while holding your own
  lock** (self- and ABBA deadlocks);
- the state-machine idiom (`init` / `processInputs` / `getDesiredState` / `processOutputs`,
  snapshot inputs once, publish under lock);
- one canonical `_data` struct per module, and clear `@brief` / `@details` intent.

Don't re-report MISRA/cppcheck findings or build errors — those gate separately in CI.
