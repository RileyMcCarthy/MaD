---
name: writing-behaviours
description: How to write and word Vibes behaviour declarations when adding or changing tests in this repo — TS (@vibes/behaviour), C (vibes_behaviour.h), or Rust (vibes-behaviour). Use whenever writing tests, annotating tests with behaviour()/VIBES_BEHAVIOUR/behaviour!, editing behaviours.jsonl claims, or asked to add test coverage.
---

# Writing behaviours for the Vibes ledger

Every annotated test becomes a line in `behaviours.jsonl`, and PRs are reviewed
from the **diff of that ledger** — added / respecified / removed / stopped
holding. The reader has never opened the code. Full guide:
`docs/coding-guidelines/vibes-behaviours.md`.

## The non-negotiables

1. **Write `given`/`then` for a reader who has never seen the repo.**
   No internal type names, no parameter letters, no variable names.
   - BAD: `the dwell is emitted as exactly one op and P survives in milliseconds`
   - GOOD: `exactly one pause is produced, and its duration is kept in milliseconds without conversion`
   Operator vocabulary is fine (G-code, dwell, gauge length, load cell);
   implementation vocabulary is not (op, struct, buffer, enum).
   Acceptance test: read `given` + `then` aloud — if a word needs explaining, change the word.

2. **`then` is a claim about the machine, not the assertion restated.**
   "returns 3" is an assertion. "a five-millimetre travel with two millimetres
   of slack strains the sample by three" is a claim a reviewer can judge.

3. **`id` is stable identity — reword freely, never rename casually.**
   `area.claim-in-brief` kebab-case (e.g. `gantry.slack-consumed-before-extension`).
   Same id + new wording renders as *respecified* (good, reviewable).
   New id renders as removed + added (a lie, if it's the same behaviour).

4. **Declare on ENTRY.** In C the macro is the FIRST statement of the test
   body; nothing checks this for you, and a crash before it makes the
   behaviour read as deleted. TS/Rust: call `behaviour(...)` first thing.

5. **One behaviour per test**, and never self-report status — pass/fail joins
   from the runner.

6. **After changing behaviours:** `node Vibes/bin/vibes.mjs collect --write`
   and commit `behaviours.jsonl` alongside the change.

## Snippets

TS — `behaviour({...}, fn)` **replaces** `it()`, do not nest:
```ts
import { behaviour } from '@vibes/behaviour';
behaviour({ id: 'gcode.trailing-comment',
  covers: 'src/domain/gcode.ts#parseGcodeToMove',
  given: 'a move line with a trailing comment containing a coordinate token',
  then: 'the comment is ignored and the move still targets the position the author wrote',
  why: 'fixes a defect where "G1 X10 F5 ; X50 fast" moved to X50',
}, () => { /* expect(...) */ });
```

C — first statement in the Unity test body:
```c
VIBES_BEHAVIOUR(id, covers, given, then);          /* or _WHY(..., why) */
```

Rust — first statement in the `#[test]`:
```rust
behaviour!(Behaviour { id, covers: Some(...), given, then, why: Some(...) });
```
