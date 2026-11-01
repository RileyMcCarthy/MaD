## Summary

<!-- What changed and why (1–3 sentences). -->

<!-- Linked issues: "Fixes #N" for each issue this PR resolves (GitHub closes it on
merge). "Refs #N" for an issue it only relates to or was prompted by. Plain prose
like "prompted by #N" closes nothing. -->
Fixes #

## Matrices touched (bulletproof plan)

Check every matrix this PR **could** break. If none apply, check N/A.

See `docs/dev/bulletproof-test-plan.md` and `docs/dev/bug-class-coverage.md`.

- [ ] **N/A** — docs / CI chore only
- [ ] **M1** unit scale (N/mN, mm/µm)
- [ ] **M2** move / waveform packed bounds
- [ ] **M4** fault × restriction priority
- [ ] **M5** test-session lifecycle / isBusy
- [ ] **M7** worker upload/download/abort policy
- [ ] **M8** motion precision / jog
- [ ] **M9** force slack → tension model
- [ ] **M10** waveform G123 shape×params
- [ ] **M11** link loss / reconnect
- [ ] **M12** schema ↔ domain lockstep
- [ ] **B4** device event → store reduction

If you change behavior in a matrix cell, **add or update a test** that would have failed on the old bug.

## Motion

- [ ] Motion change: `test_dev_servo` / `test_app_motion` and the motion e2e on `mad-emulator` (or why not)

## Test plan

- [ ] `cd Software/Control && npm test` (or `npm run verify`)
- [ ] Relevant firmware suite(s): `pio test -e native_test -f …`
- [ ] Schema lockstep if protocol/domain touched: `python3 Protocol/scripts/check_schema_domain_lockstep.py`
- [ ] Optional SIL: `npm run e2e:smoke` or full `npm run e2e`
