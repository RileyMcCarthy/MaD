# Control — Test Plan

Goal: a complete, automated test suite covering every scenario below, kept green.

The app source stays **pure** (Web Serial + File System Access only). All test-only
abstractions (SIL serial, OPFS data folder) live in the harness — never in `src/`.

> **Status (2026-06-11): all layers green.** —
> `cargo test` **28/28** · `vitest` **25/25** (codec/gcode/analysis/sample/mapping/reorder) ·
> `npm run e2e` **26/26** vs live SIL with zero page errors (run twice back-to-back).
> Every §4 scenario marked "*(needs … feature)*" below has been **built** — those notes are
> historical. The motion regression that once blocked G2/G3/H2/D2 was fixed 2026-06-10
> (see PARITY §9); the **full lifecycle (run → complete → download → view) is e2e-verified in
> SIL**, as are B5 (link-loss/reconnect), D2/D3 (settled jog, zero-cal), J1 (firmware toast)
> and K1 (fw version), plus regressions ported from the desktop SIL suite (slack→tension force
> model, fractional precision, back-to-back runs, navigation persistence).

---

## 1. Test layers

| Layer | Tool | Scope | Command |
|---|---|---|---|
| Rust unit | `cargo test` | protocol core (framing, queue, storage, client) | `cd Protocol/ProtoEmb/runtime && cargo test` |
| WASM parity *(stretch)* | `wasm-pack test --headless --chrome` | `WasmClient.feed_bytes/poll` vs native client | `cd Protocol/ProtoEmb/runtime && wasm-pack test --headless --chrome` |
| TS unit | `vitest` | pure domain + codec | `npm test` |
| E2E | Playwright (system Chrome) | whole app vs SIL emulator + OPFS | `npm run e2e` |

Toolchain notes: `wasm-pack` lives at `~/.cargo/bin`; Playwright/Chromium are reused
from the SIL workspace (`SIL/node_modules`) and launched via `channel: 'chrome'` so no
browser download is needed.

---

## 2. Unit coverage (vitest, `src/**/*.test.ts`)

Pure, no DOM/device needed. Target each of these:

- **Codec parity** — `src/protocol/codec.parity.test.ts` ✅ (byte-identical to the desktop
  Buffer codec where schema matches; Move round-trip for the current 4-bit-`g` schema).
- **G-code generation** — `src/domain/testProfile.test.ts` ✅ (header/modes/moves, per-execution
  repeats, trailing `G122`, monotonic distance/time series). Extend with: arc points, relative
  chains, dwell timing.
- **Sample → CSV** — add `src/domain/sample.test.ts`: `decodeBinarySampleDataToCSV` on a known
  `StoredSample` byte buffer → exact CSV rows; `parseTestCSV` round-trip.
- **Type mapping** — add `src/domain/mapping.test.ts`: proto↔display for config/sample/profile/state/notification.
- **Expected-motion** (once §11 lands) — `generateExpectedMotion` from G-code matches the
  motion the generator produced.

---

## 3. E2E harness

Built on `e2e/fixtures.mjs` (already provided): injects a fake `navigator.serial`
backed by the WS↔PTY bridge, and overrides `showDirectoryPicker` to return an **OPFS**
directory (no dialog, real `FileSystemDirectoryHandle`). Also stubs the capability gate.

**Preconditions (operator or global-setup starts these):**
```bash
cd SIL && make playground          # emulator on /tmp/tty.rpi
npm run sil:bridge                 # ws://localhost:9999  (in Control)
npm run dev                        # app on http://localhost:5174
```
The runner (`e2e/run-all.mjs`) asserts the dev server (5174) and bridge (9999) are reachable
and resets the OPFS test dir between runs for isolation.

**As built** — the suite is a single Node runner rather than `playwright test` specs (simpler
for the one-worker, single-instance SIL constraint):
```
e2e/
  fixtures.mjs            # fake serial (WS↔PTY bridge) + OPFS picker override + newSilPage/connectToSil/chooseDataFolder
  run-all.mjs            # the scenarios in §4, run serially in system Chrome (channel: 'chrome')
  sil-smoke.mjs          # quick bridge/PTY sanity check (npm run sil:smoke)
  sil-playground.mjs     # headed interactive session vs SIL (npm run sil:app)
tools/
  sil-ws-bridge.mjs      # ws://localhost:9999 ↔ /tmp/tty.rpi (npm run sil:bridge)
```
SIL is single-instance, so scenarios run **serially in one browser** (the moral equivalent of
`workers: 1`); `sil:app` must be closed before `npm run e2e` (one bridge reader at a time).

**Long-lived emulator state:** the emulator persists across scenarios *and* suite runs, so
machine position (and therefore real sample tension) accumulates. Motion scenarios must start
from absolute machine zero — use the `zeroLength(page)` helper in `run-all.mjs`, which jogs the
gantry back to machine 0 (the sample anchor + 15 mm slack sit at the gantry's *boot* position,
see `embsim/models/src/gantry.rs`) before zeroing the gauge. The fake serial also provides
`window.__silDropLink()` (fixtures.mjs) to sever the link for disconnect/reconnect scenarios.

---

## 4. E2E acceptance scenarios (the parity suite)

Each maps to a desktop feature (PARITY § in parentheses). A scenario is "green" when it
runs against the live SIL emulator with no page errors and the listed assertions pass.

### A. Capability gate (§1)
- A1. With `navigator.serial` / `showDirectoryPicker` **absent**, the app shows the
  "Unsupported browser" screen and does not crash.

### B. Connection (§2, §14)
- B1. Click Connect → app connects to SIL; status shows Connected.
- B2. **Baud-rate selectable**; chosen baud is used on `open` *(needs §2 feature)*.
- B3. **Granted-ports list** from `navigator.serial.getPorts()` shown *(needs §2 feature)*.
- B4. **Device-responding** indicator turns true once samples flow; shows "not responding"
  when polling stalls *(needs §14 feature)*.
- B5. Disconnect → status returns to Disconnected; reconnect works.

### C. Live monitoring (§3)
- C1. After connect, numeric readouts (machine/sample force/position/setpoint) update to
  finite values.
- C2. Machine-state shows fault/restriction/motion/test; **tooltips** explain each
  fault/restriction *(needs §3 tooltips)*.
- C3. **Combined live chart** renders both force and position with limit reference lines and a
  machine/sample coordinate toggle *(needs §3 feature)*.
- C4. **Live stress–strain** chart accumulates during a running test and clears at test start
  *(needs §3 feature)*.

### D. Manual control (§4)
- D1. Enable motion → machine-state `motionEnabled` becomes true.
- D2. Jog +N / −N at a speed → machine setpoint/position moves in the expected direction
  (assert via sample readout delta).
- D3. Home, Zero force, Zero length issue commands without error.

### E. Machine configuration (§5)
- E1. Config loads from device; edit a field, Save, Reload → value round-trips.

### F. Sample + motion profiles / Create (§6, §7, §8)
- F1. Choose OPFS data folder (Settings).
- F2. Create + save a **sample profile**; it appears in the load dropdown; reload page →
  still listed; delete removes it.
- F3. Import a `.sp` file → fields populate.
- F4. Build a **motion profile**: add set, add moves of each type, **drag-reorder** a move
  and a set (assert order changes), edit params; Save; appears in dropdown; load restores it.
- F5. Save/Load an individual **Set**.
- F6. Import a `.mp` file.
- F7. **Preview G-code** modal shows generated G-code (contains `G122`) and the distance/time chart.

### G. Run a test end-to-end (§9)
- G1. With device connected + folder chosen + profiles selected, click **Run Test**:
  run record is created with status `running`; firmware `testRunning` goes true.
- G2. When the motion completes, status auto-updates to `completed` (state-driven).
- G3. Gauge length + initial position are persisted on the run record (read back via DataStore).

### H. Run history (§10)
- H1. New run appears in the History table with status badge + started time.
- H2. **Download data** pulls the CSV from SIL, saves it, status → `downloaded`; a
  **progress** indicator is shown during transfer *(progress UI needs §10)*.
- H3. Columns show **sample/motion profile names**; **pagination** loads older runs *(needs §10)*.
- H4. Delete removes the run (with confirm) *(confirm needs §10)*.
- H5. **Export CSV with metadata** produces a file *(needs §10; browser = download/OPFS)*.

### I. Run viewer (§11)
- I1. View a downloaded run → info cards (sample/motion details, data points, gauge length).
- I2. **Force vs Time** chart renders with a Max Force line.
- I3. **Position vs Time** renders actual + setpoint + **expected (from G-code)** with Max
  Displacement line.
- I4. **Stress–strain** scatter renders with Max Stress/Max Strain lines.

### J. Notifications (§ cross-cutting)
- J1. A firmware notification surfaces as a toast of the right severity.

### K. Firmware/About (§13)
- K1. Current firmware version is displayed when responding.

---

## 5. Definition of "test parity" (pass criteria)

All of the following must hold on a clean checkout after
`npm run build:wasm && npm run generate:proto && npm install`:

1. `cargo test` (runtime) — green. ✅ **28/28**
2. `npm test` (vitest) — green, including the unit targets in §2. ✅ **25/25**
3. `npm run build` (`tsc -b && vite build`) — green, no type errors. ✅
4. `npm run e2e` — every **parity-critical** §4 scenario green against a live SIL emulator,
   **zero page errors**. ✅ **26/26** — covers A1, B1–B5, C1/C3/C4, D1/D2/D3, E1,
   F1/F2/F4/F6/F7, G1/G2/G3 + G-limit, H1–H5, I1–I4, J1 (toast in G-limit), K1 (fw version in
   B2+B3+B4), plus ported desktop-SIL regressions (NAV, slack→tension, fractional precision,
   back-to-back, settled jog) and TC1/TC2/TC4/TC6/TC11/TC14. The only §4 IDs without a dedicated
   scenario are C2 (tooltips), F3 (.sp import) and F5 (set save/load) — feature-present,
   unit/presence-covered.
5. [PARITY.md](./PARITY.md) — every section ✅ (or explicitly marked N/A for the browser,
   e.g. native firmware flashing, "open in Finder"). ✅

A convenience aggregate: `npm run verify` runs 1–3 (offline); `npm run e2e` runs 4
(needs SIL). Both pass as of 2026-06-11.

---

## 6. Out of scope / N/A in the browser
- Native firmware flashing (`loadp2`) — desktop/CLI only.
- "Open data folder in Finder/Explorer".
  — verify once manually with a real granted folder.
- Non-Chromium browsers (gate covers this).
