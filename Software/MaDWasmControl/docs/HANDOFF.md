# MaDWasmControl — Parity Handoff & Operating Brief

You are continuing an autonomous push to bring `Software/MaDWasmControl` (frontend-only
Web Serial + WASM control app) to **full parity** with the desktop app `Software/MaDControl`.

Read alongside: [PARITY.md](./PARITY.md) (feature checklist) and [TEST_PLAN.md](./TEST_PLAN.md)
(the test suite that defines "test parity").

---

## ✅ Status: PARITY REACHED (2026-06-08)

**The autonomous parity push is complete — every Definition-of-Done gate passes** (verify +
`cargo test` + e2e 12/12). The directive below is retained as the operating brief for any
follow-up session (e.g. clearing the hardware-only caveats or the optional/cosmetic items).

## ⛔ Operating directive — DO NOT STOP UNTIL PARITY

**This is an autonomous parity push. Do not stop, do not ask for confirmation, and do not
yield the turn until BOTH conditions in "Definition of Done" hold.** Specifically:

- Work the **Remaining work** list top-to-bottom. For **each** feature run the **Per-feature
  loop** below, then **immediately continue to the next** — do not pause for approval between
  features.
- The only acceptable early stop is a **hard external blocker you cannot resolve yourself**
  (e.g. it physically requires hardware, or a dependency cannot be installed). If that happens:
  document it in PARITY.md, mark that item blocked, **skip it, and keep going** on everything
  else. Re-attempt blocked items if the blocker clears.
- Never weaken a test or mark an item ✅ without its gate actually passing. Report failures
  honestly; fix forward.
- Keep the **app source pure**: `src/` may use only Web Serial + the File System Access API.
  All SIL / OPFS / test-only concerns live in `e2e/` and `tools/` — never in `src/`.

## ✅ Definition of Done (the stop condition) — **MET** (re-verified 2026-06-11)

All true:
- [x] `npm run verify` green — `tsc -b` + **vitest 25/25** + `vite build`.
- [x] `cargo test` green in `Protocol/ProtoEmb/runtime` — **28/28**.
- [x] `npm run e2e` — **26/26** scenarios green against a live SIL emulator with **zero page
      errors**, run twice back-to-back. Covers §4 IDs A1 · B1–B5 · C1/C3/C4 · D1/D2/D3 · E1 ·
      F1/F2/F4/F6/F7 · G1/G2/G3 + G-limit · H1–H5 · I1–I4 · J1 (toast, in G-limit) · K1 (fw
      version, in B2+B3+B4), plus regressions ported from the desktop SIL suite (NAV navigation
      persistence, settled jog, slack→tension force model, fractional sub-mm precision,
      back-to-back runs) and TC1/TC2/TC4/TC6/TC11/TC14.
- [x] TEST_PLAN §2 unit targets implemented and passing (codec/gcode/analysis/sample/mapping/reorder).
- [x] PARITY.md — every section ✅ or explicitly **N/A (browser)**.

> **§4 IDs without a dedicated e2e scenario:** C2 (tooltips), F3 (.sp import), F5 (Set
> save/load) — feature-present and unit/presence-covered. The 2026-06-09 motion-regression
> blockers (G2/G3/H2/D2) were fixed 2026-06-10 and are now real SIL e2e scenarios.

---

## Environment & commands

Toolchain: Node 20+, Rust + `wasm-pack` (`~/.cargo/bin` — run `export PATH="$HOME/.cargo/bin:$PATH"`),
`wasm32-unknown-unknown` target, Python 3. Playwright/Chromium are reused from `SIL/node_modules`
and launched as **system Chrome** (`channel: 'chrome'`) — no browser download.

```bash
# one-time after clone (regenerate build artifacts)
npm run build:wasm        # Rust protocol core → src/wasm/
npm run generate:proto    # → src/protocol/generated/
npm install

# offline gate (fast; run constantly)
npm run verify

# E2E vs SIL — needs THREE things up, in separate shells:
cd ../../SIL && make playground          # emulator on /tmp/tty.rpi  (or: cargo run --bin mad-emulator -- --sd-path ./sd --pty-path /tmp/tty.rpi --log-level warn)
npm run sil:bridge                       # WS↔PTY bridge on ws://localhost:9999
npm run dev                              # app on http://localhost:5174
npm run e2e                              # run the suite

# manual interactive session vs SIL (headed Chrome, fake serial injected)
npm run sil:app
```

> ⚠️ **One bridge client at a time.** The PTY can only feed one reader cleanly — if two app
> instances connect, sample bytes get split and you see "no data". Close `sil:app` before
> `npm run e2e`. If samples stall, restart the emulator + bridge fresh.

---

## Architecture map (where things go)

| Concern | Location | Notes |
|---|---|---|
| Protocol core (Rust→WASM) | `Protocol/ProtoEmb/runtime` (`src/wasm.rs`) | rebuild via `npm run build:wasm` |
| Generated TS codec | `src/protocol/generated/` | from `Protocol/ProtoEmb/core/templates/protocol.ts.j2` (browser-safe). **Don't hand-edit** — change template/YAML + `npm run generate:proto` |
| Pure logic | `src/domain/*` (+ `*.test.ts`) | gcode, sample/CSV, mapping, testProfile |
| Device worker + client | `src/device/{DeviceSession.worker.ts, session.ts, events.ts}` | worker owns I/O + WASM; main owns the port |
| Storage | `src/storage/DataStore.ts` | File System Access; mirrors desktop folder layout |
| State | `src/store/{useStore.ts, liveBuffer.ts}` | Zustand + out-of-React live sample ring |
| UI | `src/ui/{screens,components}`, `src/App.tsx`, `src/styles.css` | routes + nav in App.tsx |
| E2E harness | `e2e/{fixtures.mjs, run-all.mjs}` | fake serial + OPFS; `tools/sil-ws-bridge.mjs` |

---

## Per-feature loop (repeat for each Remaining-work item)

1. Pick the top unchecked item.
2. Implement in `src/` (pure logic → `src/domain` with a vitest).
3. Add/extend the matching scenario(s) in `e2e/run-all.mjs` (use the TEST_PLAN §4 id; reuse
   `e2e/fixtures.mjs` helpers: `newSilPage`, `connectToSil`, `chooseDataFolder`).
4. Gates: `npm run verify`; bring SIL up; `npm run e2e`. Fix until all green, zero page errors.
5. Update `docs/PARITY.md` (→ ✅) and TEST_PLAN if scope changed.
6. Go to 1.

---

## Remaining work — ✅ ALL COMPLETE

> **All items below were delivered and gated.** Retained as a record of acceptance criteria
> (each maps to a PARITY § and TEST_PLAN §4 scenario, all ✅). No open functional work remains;
> the only outstanding items are the hardware-only verifications in "Known caveats".

### 3. Test Run Viewer — `/view/:id` (PARITY §11; tests I1–I4, also unblocks §10 H5) — ✅
The runner already records what the viewer needs (gcode, profiles, gaugeLengthMm, initialMachinePositionMm).
- Add a `/view/:id` route + a "View" action on downloaded runs in the history table.
- Load run record + CSV (`DataStore.getTestRun`, `readTestCsv`; parse via `parseTestCsv`).
- Charts (use `StaticLineChart` / a scatter): **Force vs Time** (Max Force line); **Position vs Time**
The runner already records what the viewer needs (gcode, profiles, gaugeLengthMm, initialMachinePositionMm).
- Add a `/view/:id` route + a "View" action on downloaded runs in the history table.
- Load run record + CSV (`DataStore.getTestRun`, `readTestCsv`; parse via `parseTestCsv`).
- Charts (use `StaticLineChart` / a scatter): **Force vs Time** (Max Force line); **Position vs Time**
  actual + setpoint + **expected** (port `generateExpectedMotion` into `src/domain` + unit test);
  **Stress–strain** scatter (stress=|F|/(w·t) MPa, strain=ΔL/gauge %, Max Stress/Strain lines).
- Info cards: sample/motion details, data points, gauge length.
- **Done when**: viewing a downloaded SIL run shows all three charts populated, no errors (I1–I4).

### 4. Combined live chart + live stress–strain (PARITY §3; tests C3, C4) — ✅
- Replace the two separate Live charts with one **dual-axis** chart (left=position, right=force),
  60 s rolling sweep, **machine/sample coordinate toggle**, **Max Force / Max Position reference
  lines** (from machine config + sample profile). uPlot supports a second y-scale + bands/series.
- Add a **live stress–strain** chart that accumulates only while `testRunning`, clears at test start.
- Optionally seed from device history (desktop used `getCachedDeviceData`); the worker has ring
  buffers (`get_stored`) — expose a session method if you want backfill.
- **Done when**: C3/C4 e2e pass (limit lines + toggle present; stress–strain grows during a run).

### 5. Connection completeness (PARITY §2, §14; tests B2–B4) — ✅
- **Baud-rate selector** on Connect (pass chosen baud to `deviceClient.connect`).
- **Granted-ports list** via `navigator.serial.getPorts()` + an "add new" (`requestPort`).
- **Device-responding** health: derive from sample/poll activity (e.g. a recent-sample timestamp
  in the store) and show in the status bar ("Responding" vs "Not responding"), distinct from connected.
- Confirm the correct default **baud**. → app default is **2,000,000**, matching the firmware
  UART (firmware raised from 230400 to 2 Mbaud; reads verified solid to 3M on real hardware).
  Note: the **SIL** emulator stays on a lower baud via `MAD_SIM_BAUD` (it can't pace 2M in real time).

### 6. Run-history polish (PARITY §10; tests H2–H5) — ✅
- Columns for **sample/motion profile names**; **pagination** (page size 10, "load older");
  **download progress** UI (the worker's `downloadTestFile` already reports progress — surface it);
  **delete confirm**; **export CSV with metadata** (browser = file download or write to the folder).

### 7. Tooltips + firmware/About (PARITY §3 C2, §13 K1) — ✅
- Fault/restriction + readout **tooltips** (port the explanation maps from `MachineStatus`/`Parameters`).
- A small **Firmware/About** view showing the current firmware version (already read on connect).

### Unit-test backfill (TEST_PLAN §2) — ✅
- `src/domain/sample.test.ts` (decode→CSV, parseTestCSV round-trip).
- `src/domain/mapping.test.ts` (proto↔display).
- expected-motion test (when §11 lands); extend `testProfile.test.ts` (arc/relative/dwell).

---

## Guardrails / invariants
- Don't hand-edit `src/protocol/generated/` or `src/wasm/` — regenerate.
- Keep `codec.parity.test.ts` green (it guards the shared template; desktop interop depends on it).
- No SIL/OPFS/test code in `src/`.
- Commit per feature on the current branch (`user/mvardhan/rileysmother` or a feature branch);
  open PRs only if asked. End commit messages with:
  `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

## Known caveats (not blockers)
- ~~Motion regression~~ — **fixed 2026-06-10** (re-entrant lock deadlock, test_run self-cancel,
  gcode write→read sequencing, completion-aborts-motion; see PARITY §9). The full lifecycle is
  e2e-verified in SIL.
- OPFS verifies behavior, not real on-disk desktop interop — needs one manual real-folder check.
- Worker stream-transfer + `port.close()` on disconnect needs a real-hardware pass (SIL is a
  PTY; the e2e fake fires the Web Serial `disconnect` event, but real-USB unplug timing differs).
- Real-hardware checks for the new reliability features: auto-reconnect on replug
  (`navigator.serial` `connect` event) and download pacing at low baud.
- Desktop `MaDControl/src/main/generated/protoemb.ts` is stale (pre-`G122`) — out of scope here.

## Current status snapshot — PARITY EXCEEDED (2026-06-11)
- **Functional**: all PARITY.md priority items 1–7 ✅. Capability gate; Connect (baud + granted
  ports + responding); Live (combined dual-axis chart w/ limits + coord toggle, chart seeding from
  the device ring buffer, live stress–strain, manual control, fault/restriction + readout tooltips);
  Machine config; Sample + motion profiles (.sp import on all three screens); Create/test builder +
  G-code gen + preview (Math move stub removed from the picker); Test Runner (run-stuck watchdog,
  disconnect-aware completion, Mark done/failed); Run Viewer; Run history; Firmware/About;
  persistence (stale-handle probe); toasts; **disconnect/reconnect** (loss detection, Reconnect
  button, auto-reconnect on replug).
- **Tests**: `cargo test` **28/28**, `vitest` **25/25**, `npm run e2e` **26/26** vs live SIL
  (twice back-to-back), including the full run lifecycle and desktop-SIL-ported regressions.
- **Remaining**: optional/cosmetic items in PARITY.md (drawer/header) + the one-time manual
  real-folder interop check + real-hardware passes listed under "Known caveats".
