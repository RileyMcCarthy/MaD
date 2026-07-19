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
| **A** | M1 unit scale · M2 move bounds · M12 schema lockstep · e2e smoke | **in progress** |
| **B** | M4 faults/restrictions · M5 lifecycle · M7 worker ops | pending |
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

## Sprint B–D

See prior audit: M4/M5 Unity tables, worker fake streams, motion/force e2e
grids, link-loss moments, culture.

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
