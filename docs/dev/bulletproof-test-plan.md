# Bulletproof test plan

Executable roadmap so MaD code changes fail-closed in CI. Matrix IDs **M1–M12**
are stable references for PRs. See also [bug-class-coverage.md](./bug-class-coverage.md).

## Goals

1. Specific + class coverage for every historical bug family.
2. Parameterized matrices so boundary slips cannot hide in one-off goldens.
3. CI gates for unit, schema lockstep, SIL, and WASM e2e (smoke → full).

## Status

| Sprint | Theme | Status |
|--------|--------|--------|
| **A** | M1 unit scale · M2 move bounds · M12 schema lockstep · e2e smoke | **done** |
| **B** | M4 faults/restrictions · M5 lifecycle · M7 worker ops · B4 store events | **done** |
| **C** | M8–M11 motion/force/waveform/link e2e matrices · nightly e2e | **done** |
| **D** | PR template · pairwise tooling · backend certification | **done** |

---

## Sprint A

### A1 — M1 Unit-scale bible

Wire raw units ↔ engineering units never silently ×1000.

- vitest: `src/domain/unitScale.matrix.test.ts`
- firmware: force-gauge conversion table in `test_dev_forceGauge`

### A2 — M2 Move / waveform bounds matrix

Out-of-range packed fields never encode (bit-wrap).

- vitest: `it.each` in `gcode.test.ts` / `gcode.matrix.test.ts`

### A3 — M12 Schema lockstep

- `Protocol/scripts/check_schema_domain_lockstep.py` — YAML MachineConfiguration
  field names must exist in domain mapping (`configFromShared` keys).
- CI step on protocol / wasm changes.
- Existing `protocol-codegen` job keeps generator determinism.

### A4 — WASM e2e smoke scaffold

- `e2e/smoke-ids.txt` + `npm run e2e:smoke`
- Full CI job deferred until playground is GHA-stable; script is ready.

---

## Sprint B (done)

### B1 — M4 Fault × restriction tables

- `test_app_control.c`: each fault alone + enable refused; adjacent first-fault-wins;
  each active restriction alone; priority chain; sample restrictions via app_monitor flags.

### B2 — M5 Lifecycle matrix

- `test_app_testManagement.c`: start/manual/busy matrix across IDLE / pending /
  RUNNING / after user-end / motion-abort / sample-limit / open-fail; restart
  after each terminal reaches RUNNING.
- `test_app_messageSlave.c`: start NACK when rejected; manual NACK when busy.

### B3 — M7 Worker policy (pure)

- `sessionPolicy.ts` + tests: download NACK budgets, upload retries, partial-upload
  invalidate, abort detection, `OpMutex`, chunk terminal.
- Worker wired to policy helpers.

### B4 — Device event reduction

- `deviceEventReduce.ts` + matrix tests for store patches + `isResponding`.

## Sprint C (done)

### C1 — M8 motion precision

- `e2e/matrix-catalog.json` → `M8_jog` cells
- `run-all.mjs` generates one scenario per cell (Δ/speed/settle/round-trip)

### C2 — M9 force slack × extension

- Catalog `M9_force_slack` mid-slack / past-slack
- Exercised in `D3+SR-slack` and dedicated `M9-*` scenarios

### C3 — M10 waveform matrix

- Sine + triangle cells; sine uses sinusoid fit; triangle uses excursion/crossings

### C4 — M11 link loss

- `M11-idle-drop`, `M11-mid-test-drop` (+ legacy `B5-reconnect`)

### C5 — Nightly e2e

- `.github/workflows/e2e-nightly.yml` — schedule + workflow_dispatch (`smoke`|`full`)
- Not a required PR check (playground cost); logs uploaded on failure

### Catalog integrity

- `src/domain/e2eMatrixCatalog.test.ts` validates JSON shape without SIL

## Sprint D (done)

### D1 — PR template

- `.github/pull_request_template.md` — matrix checklist + stepper/servo certification

### D2 — Pairwise tooling

- `src/domain/pairwise.ts` + tests — greedy all-pairs for future large products

### D3 — Backend certification

- `docs/dev/backend-certification.md` — stepper CI-certified; servo not yet

## Definition of done

- [x] Sprint A–D plan items landed
- [x] Schema field rename without mapping update fails a gate (M12)
- [x] Bugfix PRs prompted to cite a matrix cell (PR template)
- [ ] WASM e2e smoke green on nightly (ops: watch `e2e-nightly` workflow)
- [ ] Electron SIL still green on PR until WASM e2e is a required check

## Commands

```bash
cd Software/Control && npm run generate:proto && npm test && npm run verify
cd Firmware/MaDCore && pio test -e native_test -f test_dev_forceGauge -f test_app_gauge
python3 Protocol/scripts/check_schema_domain_lockstep.py
cd Software/Control && npm run e2e:smoke   # needs SIL playground + bridge
# Full matrix e2e:
npm run e2e
# Pairwise helper (import from domain):
# pairwiseCases([{ name: 'shape', levels: ['sine','triangle'] }, ...])
```
