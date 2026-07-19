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
| **C** | M8–M11 motion/force/waveform/link e2e matrices | pending |
| **D** | PR template, pairwise tooling, nightly soak | pending |

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
  each active restriction alone; priority chain; sample restrictions locked inactive
  (firmware checks currently commented).

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

## Sprint C–D

Motion/force/waveform/link e2e matrices; CI e2e smoke; PR template culture.

## Definition of done

- [ ] Sprint A–C green in CI
- [ ] WASM e2e smoke in CI (or waiver with Electron SIL covering same contracts)
- [ ] Schema field rename without mapping update fails a gate
- [ ] Bugfix PRs cite a matrix cell or add one

## Commands

```bash
cd Software/MaDWasmControl && npm run generate:proto && npm test && npm run verify
cd Firmware/MaDCore && pio test -e native_test -f test_dev_forceGauge -f test_app_gauge
python3 Protocol/scripts/check_schema_domain_lockstep.py
cd Software/MaDWasmControl && npm run e2e:smoke   # needs SIL playground + bridge
```
