# MaDControl → MaDWasmControl feature parity

Full inventory of the original Electron app (`Software/MaDControl`) with the status of
each feature in the new frontend-only app. Legend: ✅ done · 🟡 partial · ❌ missing.

Original routes: `/dashboard`, `/connect`, `/create` (test builder), `/view` (run history),
`/view/:id` (run viewer), `/config`, `/firmware`, `/settings`.

---

## 1. App shell & navigation — ✅ DONE (native menu N/A)
- ✅ Sidebar nav across all sections (Connect / Live / Machine / Profiles / Create Test / Test Runs / Firmware / Settings).
- ✅ **Connection/health badge** in the status bar: Connected + **"Responding" / "Not responding"** / Disconnected.
- 🟡 Collapsible drawer + current-page-name header — cosmetic; nav + status present.
- N/A Native app menu (File/View/Window/Help) — browser; Help/About folded into the Firmware/About page.
- ✅ Dark theme. ✅ Toast notifications (error/warn/info/success).

## 2. Connection (`/connect`) — ✅ DONE
  - ✅ **Selectable baud rate** dropdown (9600…2,000,000; default 2,000,000 per the hardware contract).
  - ✅ **Granted-ports list** via `navigator.serial.getPorts()` + refresh + "Add device…" (`requestPort`).
  - ✅ Connection status / error feedback; disconnect + responding badge.
  - E2E B2/B3 green.

## 3. Live dashboard (`/dashboard`) — monitoring
The original Dashboard is the hub: status + readouts + control + test runner on the left, **two live charts** on the right.
- ✅ Live numeric readouts (Machine force/position/setpoint, Sample force/position).
  - ✅ Field **tooltips** explaining each value (`READOUT_HINTS` → `title=`, `Live.tsx`).
- ✅ Machine state display (fault, restriction, motion, test) as badges, with:
  - ✅ **Per-fault / per-restriction tooltip explanations** (COG, WATCHDOG, ESD_*, SERVO_COMMUNICATION, endstops, door, etc.) via `FAULT_HINTS`/`RESTRICTION_HINTS` (`Live.tsx`).
- ✅ **Combined live chart**: force + position on one **dual-axis** chart (left=position, right=force),
  60 s rolling sweep, **machine/sample coordinate toggle**, **Max Force / Max Position reference lines**
  from machine config + sample-profile limits (`LiveCombinedChart`). E2E C3 green.
- ✅ **Live stress–strain scatter** accumulates only during a running test (clears on test start),
  Max Stress / Max Strain limit lines (`LiveStressStrainChart`). E2E C4 (renders) green.
- ✅ **Chart seeding** from the device ring buffer (2026-06-11): the worker exposes
  `getStoredSamples()` (WASM `get_stored`) and the store backfills the live buffer on connect
  (`seedSamples`, back-dated at the sample period; no-op once live samples flow).
- ❌ Test Runner card embedded on the dashboard (see §8).

## 4. Manual control
- ✅ Enable/disable motion, Home (G28), Zero force, Zero length, jog up/down with distance + speed inputs. *(New app "Live" screen has all of these.)*

## 5. Machine configuration (`/config`)
- ✅ Read all config fields, edit, save to device. ✅ Reload from device.

## 6. Sample profiles
- ✅ Editor (maxForce, maxVelocity, maxDisplacement, width, thickness, serial/name).
- ✅ Read from / write to device.
- ✅ Save / list / delete to data folder.
- ✅ **Import from `.sp` file** (JSON): on **Create**, the **Test Runner**, and (2026-06-11)
  the standalone **Profiles** screen (populates the editor; also saves to the data folder
  when one is connected).

## 7. Motion profiles & test creation (`/create`) — ✅ DONE
Built in the new app (`src/ui/screens/Create.tsx`).
- ✅ ~~Sample-profile section~~ — **moved** (2026-06-12, intentional divergence from the desktop):
  sample-profile creation lives only on the **Samples** page (`Profiles.tsx`); `/create` is the
  motion-profile builder ("Motion Profiles" in the nav). The Test Runner combines a sample +
  motion profile at run time, as before.
- ✅ **Motion profile**: name + description.
- ✅ **Sets** (named, with executions count), **drag-and-drop reorderable** (native HTML5 DnD), add/delete.
- ✅ **Moves** within a set, **drag-and-drop reorderable**, add/delete, with move types:
  - **Linear** (absolute → position+velocity; relative → distance+velocity)
  - **Dwell** (time ms)
  - **Waveform** (the `math` move, 2026-06-13) — a **real position-vs-time waveform**
    (sine / triangle) for cyclic/fatigue loading: amplitude, frequency, cycles, centre.
    Host-expanded into `G1` segments the firmware plays back from SD (position-controlled,
    runs unattended; no firmware/protocol change). Replaces the old "unsupported, skipped" stub.
    The builder shows live peak-velocity + duration and warns past the 100 mm/s limit.
  - ~~**Arc** (G2)~~ — **removed** (2026-06-13): the Waveform move replaces it. The `arc` move
    type and the `circularOffset` parameter are gone from the app; `G2/G3` remain valid *wire*
    codes (protocol/firmware untouched) but the app no longer generates them. The old `TC2-arc`
    e2e scenario was replaced by **`WAVE-sine`** (asserts the position actually oscillates).
  - absolute/relative selector per move.
- ✅ **Save / load / overwrite individual Sets** to the data folder (load via picker modal).
- ✅ Save / load-dropdown / delete / **import `.mp`** motion profiles.
- ✅ **Preview G-code** dialog (see §8).

## 8. G-code generation — ✅ DONE
- ✅ **Motion profile → G-code** converter (`G90`/`G91`, `G1` linear, `G4` dwell, `G2` arc, trailing **`G122`** stop; per-set/execution comments) — `src/domain/testProfile.ts`, unit-tested.
- ✅ **Distance-vs-time preview chart** of the generated motion (`GcodePreview` + uPlot `StaticLineChart`).
- ✅ Hand-typed G-code textarea on Runs **removed**; the Test Runner (§9) consumes generated G-code.

## 9. Running a test — ✅ DONE
Built as `src/ui/components/TestRunner.tsx`, mounted on the Runs screen.
- ✅ **Profile-driven Test Runner**: select saved sample + motion profile (or import `.sp`/`.mp`), **G-code preview** modal, then run.
- ✅ On run: pushes selected **sample profile to firmware**, reserves a test name, creates the run record, captures **gauge length** and **initial machine position** from the latest sample, generates + uploads G-code, starts test.
- ✅ **Run button reflects firmware `testRunning`** and auto-marks the run "completed" when firmware finishes (state-driven via the store's machineState).
- ✅ **Run-stuck fallbacks** (2026-06-11; exceeds the desktop):
  - Completion is only inferred **while connected** (a disconnect resets machineState, which
    previously read as a false completion); losing the device mid-test marks the run **error**
    (its data may still be downloadable after reconnect).
  - A **watchdog** (2× the profile's expected duration + grace, min 30 s) warns when firmware
    never reports completion.
  - History rows stuck in "running" get **Mark done / Mark failed** actions.
- ✅ Raw-textarea run path removed.
- ✅ **Auto-completion + data download WORK end-to-end in SIL** (2026-06-10). The full lifecycle —
  run → firmware executes the motion → `testRunning` toggles → run auto-marks **completed** →
  **download** the CSV → **view** — is green and covered by e2e **G2+G3+H2+I**. The downloaded data
  matches the motion profile (the position excursion equals the commanded peak; relative up/down
  returns to start). The earlier "SIL can't" / "burst-RX-drop" notes were **both wrong**; the real
  causes were firmware regressions from commit `c081e6c8`, now fixed:
  - **Re-entrant lock self-deadlock** — `addManualMove` held the CONTROL cog lock and called
    `app_motion_addMove` → `lib_staticQueue_push`, which re-acquired the *same* lock (non-reentrant
    HAL lock) → cog hang. Fixed: dedicated motion-queue lock + lock-release-before-enqueue;
    `lib_staticQueue` lock made optional.
  - **`test_run` self-cancel** — `processRequests` cleared `triggerTestStart` unconditionally, but
    `motionEnabled` lags one cog cycle, so the request was dropped before the test started. Fixed:
    consume the trigger only when the test actually starts.
  - **gcode write→read sequencing** — the uploaded gcode WRITE file was never closed before STARTING
    re-opened it for READ. Fixed: close-then-reopen sequenced via `gcodeReadOpened`.
  - **completion aborted the motion** — G122/EOF called `enterEnding` which `abortAndClear`'d the
    queued moves, so the test ended instantly with no motion. Fixed: drain (`allMovesFed` +
    `app_motion_isIdle()`) before ending.
  - **App:** the Test Runner now `setMotionEnabled(true)` before running (was the desktop's step 5).
- ✅ **Sample-profile limit enforcement** (2026-06-10): the firmware now **stops the test** when the
  sample exceeds `maxForce` or `maxDisplacement`. `app_monitor` already computed `isForceExceeded()` /
  `isDisplacementExceeded()` against the loaded profile; `app_testManagement` RUNNING now ends the test
  (`END_LIMIT_EXCEEDED`, warning notification) when either trips. Covered by e2e **G-limit** (a 20 mm
  move under `maxDisplacement=8 mm` stops at ~8 mm). *(The stale, commented-out `length`/`stretchMax`
  block in `app_control` was bypassed — `app_monitor`'s `maxDisplacement` path is the live one.)*

## 10. Test run history (`/view`)
- ✅ List of runs with status badges. E2E H1/H3/H4/H5 green.
  - ✅ **Sample-profile & motion-profile names** columns.
  - ✅ **Pagination** ("load older runs", page size 10).
  - ✅ **Download progress bar** (KB counter + bar; full real-download progress also exercised by §9 run flow).
  - ✅ Download data from device → CSV. ✅ Delete with **confirm dialog** (Modal).
  - ✅ **View** action (→ run viewer, shown once downloaded).
  - ✅ **Export CSV with metadata header** (Blob download).
  - ✅ **Refresh** button.

## 11. Test run viewer / analysis (`/view/:testName`) — ✅ DONE
Built as `src/ui/screens/TestRunViewer.tsx`; analysis in `src/domain/analysis.ts` (unit-tested);
charts via `StaticLineChart`/`StaticScatterChart` + `uplotRef` reference lines. E2E I1–I4 green.
- ✅ Info cards: sample-profile details, run details (motion name, started/completed, data points, gauge length).
- ✅ **Force vs Time** chart with Max Force reference line.
- ✅ **Position vs Time**: **actual vs setpoint vs expected** (`generateExpectedMotion` + `interpolateExpected`), with Max Displacement line.
- ✅ **Stress–strain** scatter (stress=|F|/(w·t) MPa, strain=ΔL/gauge %), Max Stress / Max Strain limit lines.
- ✅ CSV parsing (`parseTestCSV`).

## 12. Persistence & settings (`/settings`)
- ✅ Choose data folder; new app uses File System Access API mirroring the same on-disk layout.
- ✅ Persists across reloads (IndexedDB handle).
- ⚠️ "Open in Finder/Explorer" — not possible in a browser (N/A).
- ✅ Profiles / sets / test runs / CSV stored as files (interchangeable with desktop).

## 13. Firmware / About (`/about`) — ✅ DONE (flashing N/A)
- ✅ **Show current firmware version** (`src/ui/screens/About.tsx`, from the store).
- N/A Flash-from-file — **out of scope** (native `loadp2`, can't run in a browser); noted in the UI.
- ✅ GitHub releases link + About info.

## 14. Device status / health — ✅ DONE
- ✅ **`responding`** signal — store watchdog on recent sample activity; surfaced in the status bar
  ("Responding" / "Not responding") and on Connect. E2E B4 green.
- ✅ `connected` state.
- ✅ **Disconnect/reconnect handling** (2026-06-11; exceeds the desktop):
  - The worker detects stream death (USB unplug, bridge loss) in its read loop and emits
    `disconnected` with a reason; in-flight waiters reject; the main thread releases the port.
  - `navigator.serial` `disconnect`/`connect` events keep the port handle honest and signal replug.
  - Unexpected loss ⇒ error toast + **Reconnect** button (status bar + Connect screen), which
    retries the last port/baud; on replug (`connect` event) the app **auto-reconnects**.
  - E2E **B5-reconnect** green (link severed mid-session → Disconnected + toast → Reconnect →
    responding again).
- ✅ **Stale data-folder handle probe** — `DataStore.restoreDirectory` probes the restored handle
  and drops it if the folder no longer exists (was: reported connected until the first I/O failed).

## 15. Cross-cutting device actions (in `useDevice`)
- ✅ connect, setMotionEnabled, manualMove, home, zeroForce, zeroLength, get/saveMachineConfiguration, get/saveSampleProfile, readFirmwareVersion, runTest, downloadTestFile.
- ✅ `streamGCode` — in the worker; consumed by the Test Runner (§9) to upload generated G-code (no user-facing raw textarea).
- ✅ `getAllDeviceData` / `getCachedDeviceData` equivalent — `deviceClient.getStoredSamples()`
  reads the WASM sample ring buffer; the store seeds `liveBuffer` from it on connect (§3).
- ✅ `listPorts` equivalent — granted-ports listing via `navigator.serial.getPorts()` on Connect (§2).

---

## Priority gaps (biggest user-visible deltas)
1. ✅ ~~**Test creation** (`/create`): motion-profile builder + G-code generation + preview.~~ (§7, §8) — **done**
2. ✅ ~~**Profile-driven Test Runner** with gauge-length/initial-position capture + `testRunning`-driven completion.~~ (§9) — **done**
3. ✅ ~~**Test run viewer** (`/view/:testName`): force/position/expected + stress–strain analysis.~~ (§11) — **done**
4. ✅ ~~**Combined live chart** (dual-axis, limits, coord toggle) + **live stress–strain**.~~ (§3) — **done**
5. ✅ ~~**Connection**: baud-rate selection + granted-ports list; **device-responding** health indicator.~~ (§2, §14) — **done**
6. ✅ ~~**Run history** polish: profile-name columns, pagination, progress bar, view/export.~~ (§10) — **done**
7. ✅ ~~Fault/restriction + readout **tooltips**; firmware-version/About page.~~ (§3, §13) — **done**

### Status: full functional + test parity, plus reliability features beyond the desktop
(2026-06-11) All priority items 1–7 ✅. Gates: `cargo test` **28/28** · `vitest` **25/25** ·
`npm run verify` green · E2E **26/26 green** vs live SIL (`npm run e2e`, run twice back-to-back):
A1 gate · B1+C1 · B2-B4 (+K1 fw version) · **B5-reconnect** · C3+C4 · D1 · **D2-settled-jog** ·
**D3+SR-slack** · E1 · F1/F2/F4/F6/F7 · G1 · **G2+G3+H2+I full lifecycle** · G-limit (+J1 toast) ·
H1/H3/H4/H5 · I1-I4 · **NAV** · **P1-precision** · **BB-back-to-back** ·
TC1-multiset/TC2-arc/TC4-dwell/TC6-disable-stops/TC11-velocity/TC14-jog.

The old "blocked by SIL fidelity" caveat is resolved: completion + download run end-to-end in
SIL (§9, fixed 2026-06-10), and the disconnect/reconnect + stuck-run gaps are now features (§9, §14)
with e2e coverage (2026-06-11).

**Beyond-desktop e2e regressions ported from `SIL/tests/`** (2026-06-11): settled jog
(±0.12 mm setpoint tracking), zero-cal value assertions, slack→tension force model
(±10 mm ≈ 0 N, +20 mm > 0.1 N), fractional sub-mm setpoint precision (7.503 mm), back-to-back
runs, cross-page navigation persistence, link-loss/reconnect. Note for suite authors: the
emulator is long-lived across scenarios *and* suite runs — motion scenarios must start from
absolute machine zero (`zeroLength()` helper does this; the sample anchor + 15 mm slack sit at
the gantry's boot position, see `embsim/models/src/gantry.rs`).

**Optional / cosmetic (not parity-blocking):**
- Collapsible drawer + current-page-name header (§1).
- Real on-disk folder interop with the desktop app (OPFS verifies behavior only) — one manual check pending.
