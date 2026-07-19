# Bug-class coverage checklist

When fixing a product bug, land **both**:

1. A **specific** regression that would fail on the exact broken behavior.
2. **Class-level** coverage that would catch the same *kind* of mistake nearby.

This document tracks the recurring classes mined from MaD history and where
they are guarded today. Update it when you add a new class or close a gap.

## How to use

- **Before merge of a bugfix:** add or extend the rows below.
- **Prefer the cheapest layer that locks the contract:**
  - pure unit (firmware Unity / vitest) for math, enums, races, timeouts
  - SIL / WASM e2e only when the bug is cross-layer
- Name tests after the failure mode (`*_does_not_spurious_timeout`,
  `*_idle_does_not_end`), not only after the happy path.

## Classes

| Class | Historical incidents | Specific guards | Class guards |
|-------|----------------------|-----------------|--------------|
| **Concurrency / lifecycle races** (`isBusy`, pending flags, self-cancel) | `c081e6c8` test_run self-cancel; pending start accepted manual move | `test_app_testManagement_*`; `test_onWrite_test_run_idle_does_not_end` / `_busy_ends_then_starts`; SIL `testmanagement-lifecycle`; WASM e2e `TM-busy-restart`, `TM-manual-gate` | **M5** phase matrix + restart-after-terminal; messageSlave NACK matrix |
| **Fault / restriction priority** | first-fault-wins; enable refused while faulted | existing per-fault tests | **M4** each fault alone + enable refuse + adjacent pairs; restriction chain |
| **Unsigned time / rollover** | `86b657ec` IO_protocol `(now-period)>start` underflow | `test_near_zero_clock_does_not_spurious_timeout`; `test_timeout_survives_uint32_ms_wrap` | `lib_utility_elapsed_gt` + unit tests; `lib_timer` wrap + near-zero tests; protocol/timer use the helper |
| **Unit scale (×1000 N/mN, mm/µm)** | slope stored as N not mN; SIL 1000× mismatches | SIL `regression-scaling-motion`; WASM `sample.test.ts` | force-gauge mN math units; dashboard unit bounds; codec golden vectors |
| **Protocol enum / wire drift** | G-code enum-compat OOB hang `6972ec9a`; `FORCE_GAUGE_COMMUNICATION` spelling | `test_enum_compat_*`; `stateLabels.test.ts` proto lockstep | `_Static_assert` + runtime enum equality; badge labels non-empty strings |
| **Packed-field bit wrap** | over-range X/F/P silent wrap | `gcode.test.ts` out-of-range rejects | boundary encode/decode; unknown G-code reject |
| **Resource / stack / SD bounds** | large JSON stack overflow; SD close-while-INIT | `test_IO_SDCard` guards; NVRAM file path | pop bounds; open-failure paths in testManagement |
| **UI status / object-as-React-child** | firmware version object render; status stuck on defaults | `faultBadgeLabel` / `restrictionBadgeLabel` always strings; About fw string | `stateLabels` covers every enum ordinal |
| **Motion precision / tracking** | async stepper drift; fractional mm | SIL settled jog; WASM D2-settled-jog; fractional profile | **M8** jog matrix; **M10** waveform matrix |
| **Force model (slack→tension)** | slack-zone zero force | `D3+SR-slack` | **M9** mid-slack / past-slack cells |
| **Link loss / reconnect** | status stuck; crash on drop | `B5-reconnect` | **M11** idle + mid-test drop |
| **Host reliability (worker / storage)** | poisoned WASM; index drop under concurrent write | `session.test.ts` crash fanout + recreate; `DataStore.test.ts` mutex + rebuildIndex | **M7** sessionPolicy; single-in-flight op mutex |

## Shared helpers (prefer these)

| Helper | Purpose |
|--------|---------|
| `lib_utility_elapsed_gt(now, start, period)` | Rollover-safe timeout/expiry. **Never** write `(now - period) > start` for uint32 clocks. |
| `workerCrashEvents(message)` | Canonical fanout for worker/WASM crash → UI disconnect. |
| `FAULT_HINTS` / `RESTRICTION_HINTS` / `faultBadgeLabel` | Display lockstep for machine state enums. |

## Adding a new class

1. One-line description of the *pattern*, not only the ticket.
2. At least one unit test that would fail if the anti-pattern is reintroduced.
3. Cross-layer e2e only if pure unit cannot express the contract.
4. Link the original fix commit in the table above.

## Commands

```bash
# Firmware unit suites (includes new timeout / isBusy / elapsed helpers)
cd Firmware/MaDCore && pio test -e native_test

# WASM offline gate (vitest includes DataStore, session, stateLabels, M1/M2 matrices)
cd Software/MaDWasmControl && npm run verify

# Schema ↔ domain lockstep (M12)
python3 Protocol/scripts/check_schema_domain_lockstep.py

# WASM e2e vs live SIL (includes TM-busy-restart / TM-manual-gate)
# requires: make playground + npm run sil:bridge + npm run dev
npm run e2e
# smoke subset (see e2e/smoke-ids.txt):
npm run e2e:smoke
# or ad-hoc:
SCENARIOS=TM-busy-restart,TM-manual-gate npm run e2e
```

Parameterized matrix roadmap: [bulletproof-test-plan.md](./bulletproof-test-plan.md).
