# Control — Test Plan

Goal: a complete, automated test suite covering every scenario below, kept green.

The app source stays **pure** (Web Serial + File System Access only). All test-only
abstractions (SIL serial, OPFS data folder) live in the harness — never in `src/`.

> **Status:** offline `npm run verify` and the full SIL e2e suite (`npm run e2e`,
> 49 scenarios) **gate CI** (`control-e2e-sil` is in `ci-gate.needs`). The emulator
> for e2e is unpaced (`cd SIL && make e2e-emulator`, `--speed 0`); do not use
> `make playground` for the suite — that path is real-time and measures the host.

---

## 1. Test layers

| Layer | Tool | Scope | Command |
|---|---|---|---|
| Rust unit | `cargo test` | protocol core (framing, queue, storage, client) | `cd Protocol/ProtoEmb/runtime && cargo test` |
| MaDSim PTY smoke | `cargo test -p mad-emulator --test pty_protocol` | boot emulator, one `firmware_version` round-trip, no Chrome | `cd SIL && make test` |
| TS unit | `vitest` (`src/**/*.test.ts`) | domain, codec, device policy, storage, firmware loader, diagnostics | `npm test` |
| E2E smoke | Playwright | 20 IDs in `e2e/smoke-ids.txt` | `npm run e2e:smoke` |
| E2E full | Playwright | 49 scenarios in `e2e/run-all.mjs` (parity + matrices M8–M11 + FW*) | `npm run e2e` |

`npm run verify` is the offline Control gate (tsc + eslint + vitest + coverage + production build). Coverage thresholds apply only to `src/firmware/**`.

WASM-pack browser tests remain a stretch (`wasm-pack test --headless --chrome`); native runtime tests run in `protoemb-ci`.

---

## 2. Unit coverage (vitest, `src/**/*.test.ts`)

Pure, no DOM/device needed. Current files cover:

- **Codec parity** — `src/protocol/codec.parity.test.ts`
- **G-code / profiles** — `gcode.test.ts`, `gcode.matrix.test.ts` (M2), `testProfile.test.ts`, `profileFiles.test.ts` (F3 `.sp` parse, F5 set replace)
- **Sample → CSV / export** — `sample.test.ts`, `exportCsv.test.ts`
- **Type mapping / units / labels** — `mapping.test.ts`, `unitScale.matrix.test.ts` (M1), `stateLabels.test.ts` (C2 tooltips)
- **Expected motion / analysis** — `analysis.test.ts`
- **Worker policy / store** — `sessionPolicy.test.ts` (M7), `deviceEventReduce.test.ts` (B4), `liveBuffer.test.ts`, `DataStore.test.ts` (incl. F5 set save/load)
- **Firmware loader** — `src/firmware/*.test.ts` (coverage-gated)
- **Diagnostics** — `src/diagnostics/*.test.ts`
- **Catalog integrity** — `e2eMatrixCatalog.test.ts` (must stay in lockstep with `e2e/smoke-ids.txt`)

---

## 3. E2E harness

Built on `e2e/fixtures.mjs`: injects a fake `navigator.serial` backed by the
WS↔PTY bridge, and overrides `showDirectoryPicker` to return an **OPFS**
directory. Also stubs the capability gate.

**Preconditions:**
```bash
cd SIL && make e2e-emulator        # /tmp/tty.rpi, unpaced virtual time
# (make playground is real-time — for clicking around, not this suite)
npm run sil:bridge                 # ws://localhost:9999  (in Control)
npm run dev                        # app on http://localhost:5174
```
The runner (`e2e/run-all.mjs`) asserts the dev server (5174) and bridge (9999) are reachable
and resets the OPFS test dir between runs.

```
e2e/
  fixtures.mjs            # fake serial (WS↔PTY) + OPFS picker + newSilPage/connectToSil
  run-all.mjs             # 49 scenarios, serial, system Chrome
  run-smoke.mjs           # SCENARIOS= from smoke-ids.txt → run-all.mjs
  smoke-ids.txt           # 20-ID CI/nightly subset (must match matrix-catalog.json)
  matrix-catalog.json     # M8–M11 cells + smoke_ids
  diagnostics-smoke.mjs   # logging capture (no SIL; wasm-control-ci)
  sil-smoke.mjs / sil-playground.mjs
tools/
  sil-ws-bridge.mjs       # ws://localhost:9999 ↔ /tmp/tty.rpi
```

SIL is single-instance: scenarios run serially; close `sil:app` before `npm run e2e`.

Motion waits use `settleMotion` (position vs setpoint). Sample stream and
calibrate waits use `awaitResponding` (Responding **and** `fw <version>` in
the status bar — handshake done, not the first sample) / `awaitReadoutNear`.
Reconnect retries until the PTY is free (`clickReconnect`). Remaining
`waitForTimeout`s are poll
intervals inside those helpers, plus a few UI ticks (chart toggle, form settle).

**Long-lived emulator state:** position accumulates across scenarios. Motion
scenarios start from absolute machine zero via `zeroLength(page)`.
`window.__silDropLink()` severs the link for M11 / B5.

---

## 4. E2E acceptance scenarios (the parity suite)

Each maps to a desktop feature (PARITY § in parentheses). A scenario is "green" when it
runs against the live SIL emulator with no page errors and the listed assertions pass.

### A. Capability gate (§1)
- A1. With `navigator.serial` / `showDirectoryPicker` **absent**, the app shows the
  "Unsupported browser" screen and does not crash.

### B. Connection (§2, §14)
- B1. Click Connect → app connects to SIL; status shows Connected.
- B2. Baud-rate selectable; chosen baud is used on `open`.
- B3. Granted-ports list from `navigator.serial.getPorts()` shown.
- B4. Device-responding indicator turns true once samples flow.
- B5. Disconnect → status returns to Disconnected; reconnect works.

### C. Live monitoring (§3)
- C1. After connect, numeric readouts update to finite values.
- C2. Machine-state shows fault/restriction/motion/test; **tooltips** explain each
  fault/restriction. *Unit-locked by `stateLabels.test.ts` (Live.tsx `title={FAULT_HINTS…}`).*
- C3. Combined live chart renders force and position with a machine/sample toggle.
- C4. Live stress–strain chart accumulates during a running test and clears at test start.

### D. Manual control (§4)
- D1. Enable motion → `motionEnabled` becomes true.
- D2. Jog +N / −N at a speed → position moves in the expected direction.
- D3. Home, Zero force, Zero length issue commands without error.

### E. Machine configuration (§5)
- E1. Config loads from device; edit a field, Save, Reload → value round-trips.

### F. Sample + motion profiles / Create (§6, §7, §8)
- F1. Choose OPFS data folder (Settings).
- F2. Create + save a **sample profile**; it appears in the load dropdown; reload page →
  still listed; delete removes it.
- F3. Import a `.sp` file → fields populate. *Unit-locked by `parseSampleProfileJson`.*
- F4. Build a **motion profile**: add set, add moves, drag-reorder, Save; load restores it.
- F5. Save/Load an individual **Set**. *Unit-locked by `parseMotionSetJson` / `replaceSetAt` / DataStore `saveSet`.*
- F6. Import a `.mp` file.
- F7. Preview G-code modal shows generated G-code (contains `G122`) and the distance/time chart.

### G. Run a test end-to-end (§9)
- G1. Run Test: run record `running`; firmware `testRunning` goes true.
- G2. When motion completes, status auto-updates to `completed`.
- G3. Gauge length + initial position are persisted on the run record.

### H. Run history (§10)
- H1. New run appears in the History table.
- H2. Download data pulls the CSV from SIL, status → `downloaded`.
- H3. Columns show sample/motion profile names; pagination loads older runs.
- H4. Delete removes the run (with confirm).
- H5. Export CSV with metadata produces a file. *Header composition unit-locked by `exportCsv.test.ts`.*

### I. Run viewer (§11)
- I1. View a downloaded run → info cards.
- I2. Force vs Time chart with a Max Force line.
- I3. Position vs Time: actual + setpoint + expected (from G-code).
- I4. Stress–strain scatter with Max Stress/Max Strain lines.

### J. Notifications (§ cross-cutting)
- J1. A firmware notification surfaces as a toast of the right severity.

### K. Firmware/About (§13)
- K1. Current firmware version is displayed when responding.

### Additional runner IDs (not in the original A–K list)

Ported SIL regressions and matrices, all in `run-all.mjs`: `G-limit`, `TC1-multiset`,
`TC4-dwell`, `TC6-disable-stops`, `TC11-velocity`, `TC14-jog`, `VT-linear`, `NAV`,
`P1-precision`, `BB-back-to-back`, `TM-busy-restart`, `TM-manual-gate`, `D2-settled-jog`,
`D3+SR-slack`, M8 jog cells, M9 slack cells, M10 WAVE-* cells, M11 link-loss cells,
`FW1`–`FW3` / `FW5`–`FW9` (in-app loader UI; native `loadp2` CLI is still out of scope).

Smoke subset (`e2e/smoke-ids.txt`, 20 IDs): A1, B1+C1, D1, E1, G1, G2+G3+H2+I,
TM-busy-restart, TM-manual-gate, P1-precision, VT-linear, BB-back-to-back,
M8-jog-1mm-20, M8-jog-4mm-20, M8-jog-roundtrip-5, M9-mid-slack, WAVE-sine, WAVE-tri,
M11-idle-drop, B5-reconnect, FW1.

---

## 5. Definition of "test parity" (pass criteria)

On a clean checkout after `npm run build:wasm && npm run generate:proto && npm install`:

1. `cd Protocol/ProtoEmb/runtime && cargo test` — green.
2. `npm test` — green (includes the unit targets in §2).
3. `npm run build` — green, no type errors.
4. `npm run e2e` — every scenario in `run-all.mjs` green against live SIL, zero page errors.
5. [PARITY.md](./PARITY.md) — every section ✅ (or explicitly marked N/A for the browser).

`npm run verify` runs 1–3 (offline) and **gates** `wasm-control-ci`.
`npm run e2e` runs 4 (needs SIL) and **gates** `control-e2e-sil`.

---

## 6. Out of scope / N/A in the browser

- Native `loadp2` CLI flashing — desktop/CLI only. In-app flashing is covered by
  firmware vitest goldens + e2e `FW*` (fake boot ROM, no SIL).
- "Open data folder in Finder/Explorer" — verify once manually with a real granted folder.
- Non-Chromium browsers (A1 covers the gate).
