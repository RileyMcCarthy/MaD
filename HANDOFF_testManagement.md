# Handoff — app_testManagement extraction

## What this refactor did

Split the test session lifecycle out of `app_motion` and `app_control` into a new
APP-layer module, `app_testManagement`. Motion became a pure executor; control
no longer owns the `testRunning` bit or its triggers.

## Files changed

**New**
- `Firmware/MaDCore/src/APP/app_testManagement.h`
- `Firmware/MaDCore/src/APP/app_testManagement.c`

**Modified**
- `Firmware/MaDCore/src/APP/app_motion.h` / `.c` — single queue; dropped SD/staged/gcodeId logic; `addMove()` + `abortAndClear()` replace `addManualMove()`/`clearMoveQueue()`/`setGcodeId()`. G122 kept as defensive no-op-complete in the executor.
- `Firmware/MaDCore/src/APP/app_control.h` / `.c` — dropped `testRunning`, `triggerTestStart`, `triggerTestEnd` from public API. Internal `testRunning` field kept as a per-tick snapshot of `app_testManagement_isRunning()` so SIL DWARF reader still works.
- `Firmware/MaDCore/src/APP/app_messageSlave.c` — `test_run` and `manual_move` routed through `app_testManagement`. Wait loop simplified to `while (app_testManagement_isBusy())` (SD close is now part of testManagement's ENDING).
- `Firmware/MaDCore/src/APP/app_monitor.c` — reads `app_testManagement_isRunning()` instead of `app_control_testRunning()`.
- `Firmware/MaDCore/src/DEV/Config/dev_cogManager_config.c` — CONTROL cog now runs `testManagement → motion → control` in that order.

## Architecture summary

`app_testManagement` state machine: `IDLE → STARTING → RUNNING → ENDING → IDLE`.

- **IDLE**: accepts `triggerTestStart` if motion is enabled.
- **STARTING**: retries `IO_SDCard_open(GCODE, …, READ)` until either the channel transitions out of CLOSED (→ RUNNING) or `lastOpenFailed` (→ ENDING with notification).
- **RUNNING**: each tick refills its staged buffer from `IO_SDCard_popMultiple(GCODE, …)` and pushes moves to `app_motion_addMove()`. Intercepts G122 (does **not** push it to motion). EOF + empty queue → ENDING with "Test Complete!".
- **ENDING**: stops motion (`app_motion_abortAndClear`), closes SD GCODE, waits for `IO_SDCard_isClosed(GCODE)`, → IDLE.

Two getters:
- `isRunning()` — true only in RUNNING. Read by `app_control` (state machine), `app_monitor` (logging), `app_messageSlave` (telemetry).
- `isBusy()` — true in any non-IDLE state. Used to gate manual moves and to wait for a clean state before launching a new test.

End reasons enum drives notifications: COMPLETE → "Test Complete!", MOTION_DISABLED → "Test aborted: motion disabled", OPEN_FAILED → "Failed to open test gcode 'X'", USER → silent (host knows).

## Build status

Verified at handoff time:
- `pio run -e native_emulator` — SUCCESS
- `pio test -e native_test` — 7/7 PASSED
- `cargo build` in `SIL/` — links cleanly against new `libfirmware.a`

## Not yet verified

- **Hardware build** (`pio run -e propeller2`) — not attempted in this session.
- **SIL Playwright E2E** (`make test` from `SIL/`) — not run. The protocol regen step (`make protocol`) failed on a missing `yaml` Python module in the env; pre-existing, unrelated to the refactor. To run E2E, fix the Python env or skip regen.
- **`make playground`** end-to-end test of start/abort/finish flow.
- **MISRA check** (`pio check`).

## Things worth double-checking

1. **Run order on CONTROL cog**: testManagement runs *before* motion, so a move pushed this tick is consumed next tick. If this introduces a latency regression for a tight feedback path, swap order — but you'll add a tick of latency for SD-fed moves. Current order chosen because the SD-fed path is the higher-volume one.

2. **`app_motion_addMove` not gated by `testRunning`**: gating lives in `app_testManagement_addManualMove`, which is the only entry point from `app_messageSlave`. If any future caller bypasses testManagement and calls `app_motion_addMove` directly during a test, you'd interleave manual + test moves. Today there's no such caller.

3. **G122 stripped at testManagement**: motion's `G122_STOP` case is a defensive no-op-complete. If you intentionally want G122 to flow through motion for some other reason (e.g., synchronization), you'd need to re-route.

4. **`app_control_data.testRunning` field kept**: it's a per-tick snapshot, not the source of truth. The SIL DWARF reader at `SIL/MaDSim/src/machine_view.rs:102` reads this field. If you want a single source of truth, move that DWARF read to `app_testManagement_data.output.isRunning` and drop the snapshot field from `app_control`.

5. **Manual move during test = NACK**: `app_testManagement_addManualMove` returns false during STARTING/RUNNING/ENDING. The UI should already disable manual jog controls during a test; if not, this will surface as NACK responses on the bus.

6. **Start gating race**: `triggerTestStart` checks `app_control_motionEnabled()` from a cross-cog call. There's a small window where the value can change before the request is processed in `run()`. Same race exists in the previous design.

## Where to look first if something is off

- A test starts but no moves execute → check that `app_testManagement_run` is being scheduled (cog init in `dev_cogManager_config.c`), and that `IO_SDCard_open(GCODE, …, READ)` is succeeding (`IO_SDCard_lastOpenFailed` in STARTING).
- Test never ends after G122 → testManagement's `feedMotionQueue` should detect G122 in the staged buffer. Verify `move->g == G122_STOP` comparison and that the host writes G122 with that opcode.
- Manual moves rejected even when no test → check `app_testManagement_isBusy()`; if it's true outside of an active test, the state machine isn't reaching IDLE (likely SD close hanging in ENDING).
- `testRunning` telemetry wrong in host UI → `ProtoEmb_onRead_state` in `app_messageSlave.c:103` now reads `app_testManagement_isRunning()`. Confirm `app_testManagement_run` is being ticked.

## Suggested next steps

1. Fix the local `yaml` Python module so `make test` works, then run SIL Playwright suite end-to-end.
2. Run `make playground`, drive a test through the UI, verify start → moves → G122 → clean stop. Verify abort mid-test. Verify a second test launches cleanly right after the first.
3. `pio run -e propeller2` to confirm the hardware build still links (CONTROL cog stack is unchanged at 1024B; testManagement data is in BSS, not stack).
4. `pio check` for MISRA regressions.
5. Decide whether to drop the snapshot `testRunning` field from `app_control` and re-point the SIL DWARF reader.
