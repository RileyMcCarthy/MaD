# C / Firmware Coding Guidelines (Propeller 2)

This governs all hand-written C under `Firmware/MaDCore/src/` (layers `APP/`, `DEV/`, `IO/`, `Library/`, `HAL/`, `HW/`, `Main/`). It is derived from the actual code and the `pio check` (cppcheck + MISRA; **medium + high only**) configuration in this repo. It does **not** govern `src/Generated/` or `src/IO/generated/` (see *Generated code*).

---

## TL;DR — write code that passes CI on the first try

- Start every new file from `src/template.cx` / `src/template.ch` and keep the section banners in order (rename the copied include guard).
- Name by layer prefix (`app_`, `dev_`, `IO_`, `lib_`, `HAL_`, `HW_`); functions are `module_action(...)`, file-private functions are `module_private_action(...)` and should be `static`.
- Use `<stdint.h>` fixed-width types and `<stdbool.h>` `bool`. No bare `int` for protocol/sized data; explicit casts for narrowing/64-bit math.
- Only call the layer below you. Never include a low-level MCU/P2 header above `HAL/`.
- One module owns one `static <module>_data` struct + one HAL lock. Never call another module's API while holding your own lock.
- Run `pio check` and fix **medium/high** findings (low is disabled). CI Gate fails on any medium/high defect.

---

## File layout & templates

New files are created from the canonical templates and keep the banner sections in order. From `src/template.cx:1`:

```c
//
// Created by <Name> on <date>.
//
/**********************************************************************
 * Includes
 **********************************************************************/
/**********************************************************************
 * Constants
 **********************************************************************/
/*********************************************************************
 * Macros
 **********************************************************************/
/**********************************************************************
 * Typedefs
 **********************************************************************/
/**********************************************************************
 * External Variables
 **********************************************************************/
/**********************************************************************
 * Private Variable Definitions
 **********************************************************************/
/**********************************************************************
 * Private Function Prototypes
 **********************************************************************/
/**********************************************************************
 * Private Function Definitions
 **********************************************************************/
/**********************************************************************
 * Public Function Definitions
 **********************************************************************/
/**********************************************************************
 * End of File
 **********************************************************************/
```

The literal template has **only** the `// Created by ...` line; real modules add an `// @brief`/`// @details` summary under it (e.g. `src/APP/app_motion.h:5`, `src/IO/IO_SDCard.h:5`). Do the same on non-trivial modules.

> Section banners are a strong convention, not a byte-exact rule. The wording drifts between files (e.g. `src/APP/app_motion.c` uses `Variable Definitions` / `Private Functions` / `Function Definitions`, while `src/APP/app_control.c` uses the template's `Private Variable Definitions` / `Private Function Definitions` / `Public Function Definitions`). Small `Library/` and utility files are lighter still — `src/Library/lib_staticQueue.h` and `src/IO/IO_Debug.h` carry no `// Created by` block and no banners at all. Keep the canonical sections in order for `APP/`/`DEV/`/`IO/` modules; don't bother padding tiny headers.

Header template (`src/template.ch:1`) is the same minus the External Variables / Private Variable / Private Function sections, **wrapped in an include guard** and ending with `#endif /* GUARD */`. Note the template ships with a stale `DEV_COGMANAGER_H` guard — **rename it** to match your new file. Real example `src/APP/app_motion.h:1`:

```c
#ifndef APP_MOTION_H
#define APP_MOTION_H
//
// Created by Riley McCarthy on 25/04/24.
// @brief Pure motion executor: pops moves from a queue and drives the stepper.
//
/**********************************************************************
 * Includes
 **********************************************************************/
#include <stdbool.h>
#include <stdint.h>
...
#endif /* APP_MOTION_H */
```

**Do**
- Use `#ifndef <FILE>_H` / `#define <FILE>_H` ... `#endif /* <FILE>_H */` guards. The name is uppercase and file-derived for almost every file (`APP_MOTION_H`, `IO_SDCARD_H`, `HAL_LOCK_H`; see `src/IO/IO_SDCard.h:1`, `src/HAL/Include/HAL_lock.h:1`). A couple of older files differ — e.g. `src/IO/IO_Debug.h:1` guards on `DEBUG_H`. Prefer the file-derived form for new files.
- Keep the `// Created by ... // @brief ...` banner. Modules document intent in `@brief`/`@details` (e.g. `src/IO/IO_SDCard.h:3`).
- Use Doxygen `@brief/@param/@return` on non-trivial public header functions (`src/IO/IO_SDCard.h:88`, `src/HAL/Include/HAL_lock.h:16`).

**Don't**
- Don't add new `.cx`/`.hx` files. Those are legacy (`src/DEV/i2cNavKey.cx`, `src/DEV/i2cNavKey.hx`, `src/DEV/Config/dev_nvram_machineProfile.cx`); use `.c`/`.h`.
- Don't reorder or drop the section banners in `APP/`/`DEV/`/`IO/` modules — they are how reviewers navigate every file.

### Include ordering (as practiced)

Includes are grouped: HAL first, then C stdlib, then `IO_Debug.h`, a blank line, then this module's own header, then sibling-layer headers. From `src/IO/IO_SDCard.c:8`:

```c
#include "HAL_lock.h"
#include <string.h>
#include "IO_Debug.h"

#include "IO_SDCard.h"
#include "lib_staticQueue.h"
```

Headers are found via per-layer `-Isrc/...` flags in `platformio.ini` (`build_flags`, lines 24-33), so include by **bare filename** (`"app_control.h"`), never by relative path.

---

## Naming

### File prefixes by layer

| Layer | Prefix | Example |
|------|--------|---------|
| `APP/` | `app_` | `app_motion.c`, `app_control.c` |
| `DEV/` | `dev_` (also `watchdog.c`) | `dev_stepper.c`, `dev_cogManager.c` |
| `IO/` | `IO_` | `IO_SDCard.c`, `IO_protocol.c` |
| `Library/` | `lib_` | `lib_staticQueue.c`, `lib_timer.c` |
| `HAL/Include/` | `HAL_` (also `HW_` for board pin headers) | `HAL_lock.h`, `HAL_GPIO.h`, `HW_pins.h` |
| Config | as-parent in a `Config/` subfolder | `dev_cogManager_config.c`, `IO_SDCard_config.c` |

> Note: the `HW_` prefix exists, but `HW_pins.h` actually lives in `src/HAL/Include/`. Native SIL leaves the HAL undefined (Rust trampolines); P2 HAL lives in `src/HAL/P2/`.

### Functions: `module_action`, lowerCamel action

- Public: `app_motion_init`, `app_motion_addMove`, `IO_SDCard_open`, `watchdog_kick`, `HAL_lock_try` (`src/APP/app_motion.h:71`, `src/IO/IO_SDCard.h:95`, `src/HAL/Include/HAL_lock.h:27`).
- File-private functions take a `_private_` infix and **should** be `static`. From `src/APP/app_control.c:88`:

```c
static void app_control_private_processRequests(void);
static app_control_fault_E app_control_private_processFaults(void);
static app_control_restriction_E app_control_private_processRestrictions(void);
static app_control_state_E app_control_private_getDesiredState(void);
```

> Caveat: some older modules declare `_private_` functions **non-static** even though they aren't in any header — e.g. all `watchdog_private_*` in `src/DEV/watchdog.c:78`. That's a MISRA 8.7/8.8 smell; make new private functions `static`.

### Types, enums, structs

- **Enums** end `_E`; members are `SCREAMING_SNAKE` prefixed with the module, and the last member is `..._COUNT` for iteration/bounds. `src/APP/app_control.h:25`:

```c
typedef enum
{
    APP_CONTROL_STATE_DISABLED,
    APP_CONTROL_STATE_RESTRICTED,
    APP_CONTROL_STATE_MANUAL,
    APP_CONTROL_STATE_TEST,
    APP_CONTROL_STATE_COUNT,
} app_control_state_E;
```

- **Structs**: `_S` and `_t` both appear. Config/data aggregates use either (`app_control_data_S` and `IO_SDCard_data_S` use `_S`; `app_motion_data_t` and `watchdog_data_t` use `_t`). Wire/packed structs use `_t` with `__attribute__((packed))`. `src/APP/app_motion.h:56`:

```c
typedef struct __attribute__((packed))
{
    uint8_t g;  // Gcode command
    int32_t x;  // Position in um
    int32_t f;  // Feedrate in um/s
    uint32_t p; // ms to pause motion
} app_motion_move_t;
```

> Roughly half the modules use `_S` and half `_t` for their state struct (verified across `src/APP`, `src/DEV`, `src/IO`). Prefer `_S` for new config/state aggregates and `_t` for fixed-layout/value types — and match the file you're editing.

- **Macros / compile-time constants**: `SCREAMING_SNAKE`, module-prefixed. `#define MOTION_QUEUE_SIZE 100` (`src/APP/app_motion.c:35`), `#define DEV_COGMANAGER_STACK_CANARY_SIZE (100U)` (`src/DEV/dev_cogManager.h:20`). Use `U`/`LL` suffixes on literals where width/signedness matters (MISRA).
- **File-scope state**: exactly one `static <module>_data` instance per module. `static app_motion_data_t app_motion_data;` (`src/APP/app_motion.c:93`), `static watchdog_data_t watchdog_data;` (`src/DEV/watchdog.c:70`).

---

## Types & MISRA-friendly idioms

**Do**
- Use `<stdint.h>` widths (`int32_t`, `uint32_t`, `uint8_t`) and `<stdbool.h>` `bool`/`true`/`false` for all sized data and flags (`src/Library/lib_staticQueue.h:3`).
- Make 64-bit intermediate math explicit to avoid 32-bit overflow, then cast back. `src/APP/app_motion.c:243`:

```c
int32_t steps = (int32_t)(((int64_t)moveTargetUm * app_motion_data.stepsPerMM) / 1000LL);
```

- Compare booleans explicitly against `false`/`true` rather than relying on implicit truthiness or `!` in loop/guard conditions (project style): `if (app_motion_data.inputs.motionEnabled == false)` (`src/APP/app_motion.c:133`), `while (APP_MOTION_LOCK_REQ() == false)` (`src/APP/app_motion.c:39`). **Do not write `if (!flag)` for booleans in new code** — use `== false` / `== true`. Pointer checks may still use `== NULL` / `!= NULL`.
- `const`-qualify pointer-to-input parameters and locals that don't change: `bool app_motion_addMove(const app_motion_move_t *move)` (`src/APP/app_motion.h:71`), `const int32_t jawOffsetSteps = ...` (`src/APP/app_motion.c:200`).
- Make file-private functions and the module state struct `static` (MISRA 8.7/8.8). New private helpers should be `static` even if older files aren't.
- Always give `switch` a `default:` and handle the `_COUNT` sentinel explicitly where the enum has one, even if it's a no-op (`src/APP/app_motion.c:161`, `:221`):

```c
case APP_MOTION_COUNT:
default:
    break;
```

**Single-exit vs early-return**: the codebase uses **both**, with a clear split:

| Context | Style |
|---------|--------|
| State-machine helpers (`getDesiredState`, tick bodies, transition logic) | **Single exit** — assign `desiredState` / result, return once at the end (`src/APP/app_motion.c:130-167`, `src/DEV/watchdog.c:108-133`) |
| Public API / library boundary guards | **Early return** after `DEBUG_*` for `NULL`, invalid channel, full queue, etc. (`src/Library/lib_staticQueue.c:23`) |

Do **not** ban early returns project-wide; do **not** sprinkle early returns through the middle of a state tick.

**Don't**
- Don't introduce implicit narrowing or signed/unsigned mixing without a cast (MISRA Rule 10.x). Note `native_emulator` adds `-Wno-sign-compare` (`platformio.ini:84`) — don't rely on that; cppcheck/MISRA still flags it.
- Don't use VLAs, `malloc`/`free` in steady state, or recursion — all buffers are static fixed-size (`app_motion_move_t queueBuffer[MOTION_QUEUE_SIZE];`, `src/APP/app_motion.c:88`).

---

## Layered architecture

Strict downward dependency: `APP → DEV → IO → Library → HAL → HW`. Each layer calls only the layer(s) below it.

**Do**
- Reach hardware **only** through `HAL/Include/` headers (`HAL_lock.h`, `HAL_GPIO.h`, `HAL_time.h`, `HAL_serial.h`). App code reads inputs via HAL/DEV getters: `HAL_GPIO_getActive(HAL_GPIO_ENDSTOP_UPPER)` (`src/APP/app_motion.c:115`).
- Put per-module configuration (channel tables, buffer sizes, paths) in a `Config/` subfolder file that defines the data the module declares `extern`. Pattern: `src/IO/Config/IO_SDCard_config.c:31` defines buffers via `IO_SDCARD_CHANNEL_DATA_DEFINE(...)`, and `src/IO/IO_SDCard.c:74` consumes it via `extern IO_SDCard_config_S IO_SDCard_config;`.

**Don't**
- **Never** include a low-level MCU / P2 / `flexcc` framework header from `APP/`, `DEV/`, or `IO/`. The HAL is the only thing that touches `HAL/P2/`. Build filters compile `HAL/P2/` only in `propeller2`; `native_emulator` leaves HAL symbols undefined for the SIL trampolines (`platformio.ini`).
- Don't call "upward" across layers. The one tolerated exception is logging: `Library/` and lower files may include `IO_Debug.h` for `DEBUG_*` (`src/Library/lib_staticQueue.c:4` includes `IO_Debug.h` plus `<string.h>`/`<stdio.h>`). Don't add other upward calls.

---

## Concurrency & locking

The P2 has 8 cogs; modules run on different cogs (`src/DEV/Config/dev_cogManager_config.h:22`). The rules below are load-bearing for correctness.

### HAL locks are non-reentrant, try-acquire only

`HAL_lock_try` is **try-acquire** and returns `false` if already held (`src/HAL/Include/HAL_lock.h:27`). Each module wraps it in three macros and spins:

```c
#define APP_MOTION_LOCK_REQ()       HAL_lock_try(app_motion_data.lock)
#define APP_MOTION_LOCK_REQ_BLOCK() while (APP_MOTION_LOCK_REQ() == false) {}
#define APP_MOTION_LOCK_REL()       HAL_lock_release(app_motion_data.lock)
```
(`src/APP/app_motion.c`. Same shape — different macro names — in `src/IO/IO_SDCard.c` (`IO_SDCARD_LOCK_*`) and `src/DEV/watchdog.c` (`SM_LOCK_*`).) On P2 this is `LOCKTRY`. Native SIL preempts at the HAL trampoline after a quantum of work, so these spins need no emulator yield macros.

**Do**
- Hold the lock for the **shortest critical section** — copy a value out under lock, then return it. `src/APP/app_motion.c:367`:

```c
int32_t app_motion_getSetpoint(void)
{
    APP_MOTION_LOCK_REQ_BLOCK();
    int32_t setpoint = app_motion_data.output.setpoint;
    APP_MOTION_LOCK_REL();
    return setpoint;
}
```

- Use the staged/internal "request"/"output" double-buffer pattern so cross-cog data crosses the lock boundary exactly once (`watchdog_private_stageRequest`/`stageOutput`, `src/DEV/watchdog.c:78`/`:85`; `externalInput`/`input` in `src/IO/IO_SDCard.c:46`).

**Don't (the ABBA rule)**
- **Never call another module's API while holding your own lock.** This prevents self-deadlock (non-reentrant locks) and cross-cog ABBA deadlocks. Acquire → touch only your own `static *_data` → release → then call out.

### `lib_staticQueue` is unsynchronized by contract

`lib_staticQueue` does **no** locking. Its SPSC (single-producer / single-consumer) use is lock-free *by construction*; anything else is the owner's responsibility. From `src/Library/lib_staticQueue.h:7`:

```c
/* Unsynchronized ring-buffer queue — the OWNING MODULE decides how to lock.
 *  - SPSC is safe lock-free BY CONSTRUCTION ...
 *  - Anything more (multiple producers, multiple consumers, or compound
 *    operations like check-then-push) requires the CALLER to wrap calls in its
 *    own lock. Never call into another module while holding that lock. */
```

- The push/pop indices are `volatile int` because they're read cross-cog, and each is published as a **single store after** the slot is written so a lock-free consumer never sees a transient bad index (`src/Library/lib_staticQueue.h:26`, `src/Library/lib_staticQueue.c:35-43`).
- When you use a queue, document **who** the single producer/consumer is, like `app_motion` does (`src/APP/app_motion.c:325`): "touched ONLY by the CONTROL cog ... Single-cog access ⇒ within the queue's SPSC contract."

### Cog manager channels

Cogs are declared with paired macros, not hand-written boilerplate. `src/DEV/dev_cogManager.h:49`/`:56`:

```c
#define DEV_COGMANAGER_CHANNEL_CREATE_INIT(channel, stacksize) ...   /* :49 */
#define DEV_COGMANAGER_CHANNEL_CREATE_RUN(channel) \
    void dev_cogManager_taskRun##channel(void *arg)                  /* :56 */
```

Used in `src/DEV/Config/dev_cogManager_config.c:41`. Two ordering rules to honor:
- **`*_init` order = startup dependency order** (e.g. the CONTROL cog inits `app_motion` → `app_testManagement` → `app_control`, `dev_cogManager_config.c:82-88`).
- **`*_run` order = data-flow order**, documented inline: "testManagement feeds motion's queue, then motion executes, then control evaluates state" (`dev_cogManager_config.c:92`). Match the run order when adding a step.

Every cog carries a `watchdog_channel_t` and must be kicked; new channels add a `WATCHDOG_CHANNEL_##channel` and a `DEV_COGMANAGER_CHANNEL_*` enum member before `_COUNT` (`src/DEV/Config/dev_cogManager_config.h:22`, `dev_cogManager.h:70`/`:83`).

---

## State-machine module idiom

Stateful `APP/` / `DEV/` / multi-state `IO/` modules follow a strict **`init` → `run`** shape. The tick body is:

`processInputs` → `getDesiredState` → (on change: `exitAction` → `entryAction`) → do-work / `processOutputs`.

Inputs are **snapshotted once per tick** so the rest of the tick sees one consistent view. Do not re-call external getters from transition helpers or output paths. Example snapshot rule, `src/APP/app_motion.c:48`:

```c
/* All external state read by this module must be cached here by
 * app_motion_private_processInputs() ... Do not call external getters from
 * helpers, state-machine handlers, or processOutputs. */
```

**Full pattern** (entry/exit on transition) — `src/DEV/watchdog.c`, `src/DEV/dev_nvram.c`, `src/DEV/dev_stepper.c`, `src/IO/IO_SDCard.c`:

```c
void module_run(/* channel if multi-instance */)
{
    module_private_processInputs(ch);                 /* snapshot external state once */
    state_t desired = module_private_getDesiredState(ch); /* pure-ish transition */
    if (desired != current)
    {
        module_private_exitAction(ch, current);       /* leave old state */
        current = desired;
        module_private_entryAction(ch, desired);      /* enter new state */
    }
    /* in-state work / processOutputs; publish under module lock as needed */
}
```

**Simpler modules** may omit entry/exit when there are no enter/leave side effects and only need `processInputs` → `getDesiredState` → `processOutputs` (e.g. `src/APP/app_motion.c:334`). Prefer the full entry/exit form for anything with non-trivial state-dependent setup/teardown.

**Public surface:** `module_init` once at startup; `module_run` (or cog-wired equivalent) every period; brief lock → copy → unlock on getters/setters.

---

## Error handling, logging & watchdog

- **Return conventions**: command/action functions return `bool` for accept/reject (`IO_SDCard_open`, `app_motion_addMove`, `watchdog_isAlive`). Operations with multiple failure modes return a status enum via an out-param: `IO_SDCard_readDirectEx(..., IO_SDCard_readDirectStatus_E *outStatus)` with `IO_SDCARD_READDIRECT_STATUS_OK = 0` (`src/IO/IO_SDCard.h:75`). `0`/`OK` is success.
- **Validate inputs at the boundary**, then log + return early. `src/Library/lib_staticQueue.c:23`:

```c
if (data == NULL)
{
    DEBUG_ERROR("%s", "lib_staticQueue_push: data is NULL\n");
    return false;
}
```

- **Bounds-check channel indices** with a `*_VALID` macro before use: `#define WATCHDOG_CHANNEL_VALID(channel) (...)` then guard every public entry (`src/DEV/watchdog.c:27`, `:229`).
- **Discard intentional ignored returns with `(void)`** to satisfy MISRA Rule 17.7: `(void)lib_staticQueue_init(...)` (`src/APP/app_motion.c:330`), `(void)IO_positionFeedback_setValue(...)` (`src/APP/app_motion.c:202`).
- **Logging** uses the `DEBUG_*` macros, never bare `printf`. They are compiled out unless `ENABLE_DEBUG_SERIAL` (`src/IO/IO_Debug.h:19`) and take a format + at least one arg — for a constant string pass `"%s"`:

```c
DEBUG_ERROR("%s", "lib_staticQueue_push: data is FULL\n");   // constant string
DEBUG_INFO("G4 command pausing for %u ms", app_motion_data.currentMove.p);
```

Levels (all defined in `src/IO/IO_Debug.h`): `DEBUG_WARNING` yellow (`:33`), `DEBUG_INFO` green (`:35`), `DEBUG_ERROR` red (`:37`).
- **Watchdog**: each cog `watchdog_kick(channel)`s within its loop; `watchdog_isAlive` / `watchdog_isAllAlive` feed `APP_CONTROL_FAULT_WATCHDOG` (`src/APP/app_control.h:38`). Don't add a long-running cog step without keeping the kick cadence under `TIMEOUT_ERROR` (2000 ms, `src/DEV/watchdog.c:19`).

---

## Testing new firmware behaviour

New modules and non-trivial behaviour changes need tests — not only “builds on hardware.”

**Do**
- Add or extend **Unity** tests under `Firmware/MaDCore/test/` and run `pio test -e native_test` from `Firmware/MaDCore/`.
- When the module is not already in the `native_test` source filter (`platformio.ini`), **add it** so ASan actually links the code under test.
- Cover state transitions, fault/restriction paths, invalid inputs, and lock-free/SPSC contracts where relevant.
- For behaviour that depends on motion, force, NVRAM, or multi-cog timing, add or extend **SIL** coverage (`SIL/`) in addition to unit tests.

**Don't**
- Ship new APP/DEV state machines or public control-path APIs with zero automated coverage.
- Rely solely on `pio run -e propeller2` as proof of correctness (pointer size / timing differ on native).

Suggested local loop for a firmware change:

```bash
# from Firmware/MaDCore/
pio check -e propeller2 --fail-on-defect=medium --fail-on-defect=high
pio run -e native_emulator
pio test -e native_test
# from SIL/ when behaviour crosses the emulator
make test
```

---

## Generated code

`src/Generated/` is produced from `Protocol/MaDProtocol.yaml`. Header banner (`src/Generated/protoemb_runtime.h:1`):

```c
/**
 * @file protoemb_runtime.h
 * @brief Auto-generated ProtoEmb C runtime callbacks + framing — DO NOT EDIT
 */
```

**Don't** hand-edit anything in `src/Generated/` (or `src/IO/generated/`). Change `Protocol/MaDProtocol.yaml` or the templates and regenerate (the firmware build runs `extra_scripts/generate_protocol.py` as a pre-hook, `platformio.ini:2`). `pio check` excludes generated/HAL/HW paths via `check_src_filters` (`platformio.ini:4-9`) and the build excludes `IO/generated/` (`platformio.ini:20`).

---

## Linting / passing checks (MISRA + cppcheck)

### Commands

```bash
# from Firmware/MaDCore/
pio check -e propeller2 --fail-on-defect=medium --fail-on-defect=high
pio run -e native_emulator      # must also build clean for the SIL emulator (libfirmware.a)
pio test -e native_test         # Unity unit tests (ASan + stack-protector)
```

Always build/test **native** as well as P2 — pointer sizes and timing differ (`native_emulator` builds C99 with `-Wall`; `native_test` adds `-fsanitize=address -fstack-protector-all`).

### Exactly how `pio check` is configured

From `platformio.ini` (`[env]`):

```ini
check_tool = cppcheck
check_src_filters =
  +<src/APP/*>
  +<src/DEV/*>
  +<src/IO/*>
  +<src/Library/*>
  +<src/Main/*>
check_severity = medium, high
check_flags =
  cppcheck: --addon=misra.json
```

- **`check_severity = medium, high`** — **low is not reported and not enforced.** Hundreds of low findings were style / cross-TU false positives (unused macros, unused public APIs, unused tags/typedefs, macro paste). They are not a useful gate for this tree.
- **CI Gate (`firmware-misra`)** runs `pio check -e propeller2 --skip-packages --fail-on-defect=medium --fail-on-defect=high` and **blocks merge** if any medium or high defect remains.
- `misra.json` points cppcheck's MISRA addon at `misra-rules.txt` (rule descriptions only; does not turn rules on/off).
- CERT is **not** enforced (no `cert.py` with the bundled cppcheck). To enforce CERT later, vendor an addon and add it to `check_flags`.
- `check_src_filters` scopes analysis to hand-written layers (`APP/`, `DEV/`, `IO/`, `Library/`, `Main/`) — `HAL/`, `HW/`, `IO/generated/`, and `Generated/` are not in the filter (headers may still appear when included from checked `.c` files).

### How the code is already MISRA-shaped (do these to pass)

The existing code passes medium/high by following these; new code should too:
- Fixed-width `stdint`/`bool` types; suffixed literals (`100U`, `1000LL`).
- Explicit casts for every narrowing/64-bit conversion (`src/APP/app_motion.c:243`).
- Every `switch` has `default:`; enum `_COUNT` sentinels handled where present (Rule 16.x; `src/APP/app_motion.c:161`).
- Unused/ignored return values cast to `(void)` (Rule 17.7, `src/APP/app_motion.c:330`).
- Single `static` definition per file-scope object; internal functions `static` (Rule 8.x) — with the known `watchdog.c` exception you should not copy.
- No dynamic allocation in steady state; no recursion; bounded static buffers.
- Divisors checked on the **actual** unsigned magnitude used in the divide (see `lib_utility_muldiv64_signed`).
- `DEBUG_*` / printf format strings match argument types (`%u` for `uint32_t`, etc.).

> `native_test` currently compiles only a subset under ASan (Library + selected modules). Other modules don't yet have Unity tests wired here; add to this filter when you add tests.

### Suppression policy

**Default: fix medium/high findings; do not suppress them.** Low findings are already filtered out globally via `check_severity` — do not re-enable low just to paper over style.

If a medium/high suppression is ever genuinely unavoidable (verified false positive), prefer a line- or block-scoped comment with a reason:

```c
/* cppcheck-suppress misra-c2012-21.6 ; <reason: why this is safe / a false positive> */
some_line_that_trips_the_rule();
```

or block-scoped:

```c
// cppcheck-suppress-begin misra-c2012-8.7
...
// cppcheck-suppress-end misra-c2012-8.7
```

Rules:
- **Every suppression must carry a one-line justification** and name the exact rule id.
- Prefer fixing the code or moving the offending construct behind the HAL over suppressing.
- Do not widen `check_severity` or remove `--fail-on-defect` to make CI green.

---

## Quick "Do / Don't" recap

**Do**
- Copy `template.cx`/`template.ch`; rename the include guard; keep banner sections in order.
- `module_action` public, `module_private_action` `static`; one `static module_data`.
- Stateful modules: `init` / `run` with `processInputs` → `getDesiredState` → `exit`/`entry` on change → outputs.
- `stdint`/`bool`, explicit `== false`/`== true` (no `!` on bools), explicit casts, `(void)` ignored returns, `default:` on every switch.
- Single-exit for SM helpers; early-return only at API/library boundaries.
- Lock briefly around your own data only; document SPSC ownership for queues.
- Log with `DEBUG_*("%s", ...)`; kick the watchdog in every cog loop.
- Add Unity (`native_test`) and, when needed, SIL coverage for new behaviour.

**Don't**
- Don't include MCU/P2 headers above HAL, or call upward across layers (except `IO_Debug.h` for logging).
- Don't call another module's API while holding your lock (ABBA).
- Don't hand-edit `src/Generated/` or `src/IO/generated/`.
- Don't suppress medium/high MISRA/cppcheck findings to pass `pio check` — fix them. Low is already off.
- Don't ship new stateful control-path code without automated tests.