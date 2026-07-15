---
applyTo: "Firmware/MaDCore/**"
---

# Firmware (C, Propeller 2) — Copilot review rules

Authoritative guide: `docs/coding-guidelines/c-firmware.md`.
Templates: `Firmware/MaDCore/src/template.cx`, `Firmware/MaDCore/src/template.ch`.

CI already gates MISRA/cppcheck, layering lint, and builds. **Do not re-report those.**
Flag judgment / style issues below, especially on **new modules** and non-trivial logic.

## File structure

- **New `.c` / `.h` files** must start from `template.cx` / `template.ch` (or match an existing
  peer module’s banner layout). Keep section banners in order; rename the include guard.
- Prefer `.c` / `.h` only — do not add new `.cx` / `.hx`.
- Layer prefixes: `app_`, `dev_`, `IO_`, `lib_`, `HAL_`. Public APIs: `module_action(...)`.
  File-private helpers: `static module_private_action(...)`.
- One module → one `static <module>_data` (or `_t`/`_S`) aggregate.
- Non-trivial modules need `// @brief` / `@details` (and Doxygen on public APIs).

## Boolean and control-flow style

- **Do not use `!` for booleans.** Compare explicitly:
  - `if (flag == false)`, `if (flag == true)`
  - `while (LOCK_REQ() == false)`
- Prefer explicit `true`/`false` over implicit truthiness of ints/pointers in new code
  (pointer NULL checks may still use `== NULL`).
- **State / transition helpers:** single exit — set a local result/`desiredState`, return once
  at the end (see `getDesiredState` helpers). Avoid multi-exit spaghetti in SM logic.
- **Early returns are OK** only as boundary guards (`NULL`, channel-out-of-range, invalid args)
  after log/`DEBUG_*`, matching `lib_staticQueue` / public API edges. Do not early-return deep
  inside state-machine tick bodies.

## State-machine module idiom (APP / DEV / multi-state IO)

New stateful modules should follow the existing pattern (see `watchdog`, `dev_nvram`,
`dev_stepper`, `IO_SDCard`, `app_motion`):

1. **`module_init`** — allocate lock, clear state, one-time setup.
2. **`module_run` (or cog tick)** each period:
   - **`processInputs`** — snapshot all external reads into `inputs` / channel state **once**.
     Do not re-call external getters from transition/output helpers later in the tick.
   - **`getDesiredState`** — pure-ish transition: compute next state from snapshot only.
   - On state change: **`exitAction(old)`** then **`entryAction(new)`** (when the module
     has side effects on enter/leave — match peer modules).
   - **`processOutputs`** / do-work in state — publish under the module lock as needed.
3. Public getters/setters: brief lock → copy → unlock. Never call other modules while locked.

Flag new “blob” modules that mix I/O, transitions, and side effects in one function without
this shape.

## Thread safety / locks (multi-cog)

- Each module that shares state across cogs owns a **HAL lock** and the usual macros:
  `LOCK_REQ` / `LOCK_REQ_BLOCK` (spin + `EMULATION_YIELD_LOCK`) / `LOCK_REL`.
- Locks are **non-reentrant**. Hold the shortest critical section; touch only own `*_data`.
- **ABBA rule:** never call another module’s API while holding your own lock.
- `lib_staticQueue` is unsynchronized — owner documents SPSC or wraps compound ops in its lock.
- New cog work must integrate with `dev_cogManager` + **watchdog kick** cadence.

## Layering

- Call only downward: `APP → DEV → IO → Library → HAL → HW`.
- No MCU/P2 headers above HAL (`IO_Debug.h` is the logging exception).
- No hand-edits under `Generated/` / `generated/`.

## Types / MISRA-shaped idioms (style review, not re-lint)

- Fixed-width `<stdint.h>`, `<stdbool.h>`; no bare `int` for sized data.
- Explicit casts on narrowing / 64-bit intermediate math.
- Every `switch` has `default:`; handle enum `_COUNT` where present.
- Discard ignored returns with `(void)`.
- No `malloc`/VLA/recursion in steady state; static fixed buffers.

## Testing (new / changed behaviour)

For new modules or non-trivial behaviour changes, **require or clearly suggest** coverage:

| Risk | Expected tests |
|------|----------------|
| Library / pure logic | Unity under `Firmware/MaDCore/test/` (`pio test -e native_test`) |
| APP/DEV state machines, faults, NVRAM | Unity + SIL scenarios where behaviour crosses hardware models |
| Motion / control / safety-adjacent | Unit + SIL; call out missing edge cases (limits, state transitions) |
| New file under test filter | Wire sources into `native_test` `platformio.ini` filters if needed |

Comment with **concrete** missing cases (inputs → expected state/return), not “add tests.”
Pure renames/docs need no test demand.

## Review tone

- Prefer must-fix on: layering, lock ABBA, missing SM structure on new stateful modules,
  `!` boolean style in new code, missing tests for behaviour.
- Prefer suggestion on: banner nits on tiny utilities, minor naming in legacy files.
