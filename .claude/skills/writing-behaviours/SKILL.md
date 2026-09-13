---
name: writing-behaviours
description: How to write and word Vibes behaviour declarations when adding or changing tests in this repo — TS (@vibes/behaviour), C (vibes_behaviour.h), or Rust (vibes-behaviour). Use whenever writing tests, annotating tests with behaviour()/VIBES_TEST/VIBES_EXPECT/expect!, editing behaviours.jsonl claims, or asked to add test coverage.
---

# Writing behaviours for the Vibes ledger

A test declares the **condition** it sets up once, then one or more
**expectations** for that condition. Each expectation is its own row in
`behaviours.jsonl`, its own `BH-` number, and its own line in the PR report.
PRs are reviewed from the **diff of that ledger** — added / respecified /
removed / stopped holding. The reader has never opened the code. Full guide:
`docs/coding-guidelines/vibes-behaviours.md`.

```
- given a sample 2 mm by 1 mm, with a 100 N reading after 1 mm of extension
  **stress is 50 megapascals** BH-10
  **strain is 10 percent** BH-8
```

## The non-negotiables

1. **Write `given`/`then` for a reader who has never seen the repo.**
   No internal type names, no parameter letters, no variable names.
   - BAD: `the dwell is emitted as exactly one op and P survives in milliseconds`
   - GOOD: `exactly one pause is produced, and its duration is kept in milliseconds without conversion`
   Operator vocabulary is fine (G-code, dwell, gauge length, load cell);
   implementation vocabulary is not (op, struct, buffer, enum).
   Acceptance test: read `given` + `then` aloud — if a word needs explaining, change the word.

2. **`given` is the condition. `then` is the expectation for that condition,
   and nothing else.** The report prints them together, one above the other, so
   a `then` that restates its condition says the same thing twice and leaves
   almost no room for the outcome.
   - BAD:  given *one of the cores stops reporting that it is running*
     / then *a processor core that stops running is reported as a core fault*
   - GOOD: given *one of the cores stops reporting that it is running*
     / then *the machine reports a core fault*
   `then` still has to be SPECIFIC — no `correctly`, `properly`, `as expected`;
   a wrong implementation must make it FALSE — and it still has to carry a
   condition the scene does not already establish ("on a machine whose tensile
   direction is decreasing position, ..."). What it must not do is repeat the
   scene it was handed.

3. **One expectation per thing the test asserts.** Let the assertions decide,
   not the sentence structure. One assertion is one expectation. Several
   assertions about genuinely different things are several. Assertions that
   together establish ONE fact — three fields of the same decoded record
   surviving a round trip — are one expectation, not three.
   - BAD:  `expect: { 'works': 'no chunk appears in the capture and the chunk count stays at zero' }`
   - GOOD: `expect: { 'no-chunk': 'no chunk appears in the capture', 'count-unchanged': 'the chunk count stays at zero' }`

4. **An expectation id is identity, like the test id.** Short, kebab-case,
   unique within its test, and about the expectation rather than its order.
   Good: `fault-raised`, `tail-kept`, `count-unchanged`. Bad: `one`, `second`,
   `assert3`. Rewording the text is a change to that expectation; renaming the
   id is a delete plus an add. Full identity is `suite/id/expect`.

5. **`then` is a claim about the machine, not the assertion restated.**
   "returns 3" is an assertion. "a five-millimetre travel with two millimetres
   of slack strains the sample by three" is a claim a reviewer can judge.

6. **A spec says what the machine DOES — never what it does not do, used to
   do, or once did wrong.** A contrast makes the reader stop and work out which
   half is true, and a bug the claim outlived is not part of the
   specification.
   - BAD: `lost power is reported as the power fault, not as a tripped switch`
   - GOOD: `lost power in the emergency-stop circuit is reported as the power fault`
   - BAD (`why`): `fixes a defect where "G1 X10 F5 ; X50 fast" moved to X50`
   - GOOD (`why`): `the target is what the author wrote before the comment; everything after it is annotation`
   Ban `not as`, `rather than`, `instead of`, `no longer`, `used to`, and any
   mention of a defect, regression or what shipped. If git history explains the
   claim, write the REQUIREMENT it taught you, not the story. A condition the
   claim genuinely needs ("even while every core is still running") is not a
   contrast — keep it.

7. **Use the words THIS repo uses.** Operator vocabulary is not the same as
   industry vocabulary. A tensile machine has a "crosshead" in Instron's
   manuals; this one has a **gantry**, in 36 files. Writing "crosshead" made a
   claim the maintainer had to stop and ask about — the exact failure rule 1
   exists to prevent, arrived at from the other side.
   Checkable: `git grep -i "<your word>" -- ':!behaviours.jsonl'`. If the term
   appears nowhere in the code or docs, you imported it — use theirs.

8. **The claim must say what the MACHINE DOES, not what the situation is
   CALLED.** If the outcome only re-labels the trigger, the row is circular and
   a reader learns nothing from it.
   - BAD: given *the drive stops reporting ready* / then *a drive that stops
     reporting ready is reported as a drive communication fault*
   - GOOD: given *an otherwise healthy machine whose gantry drive has gone
     silent* / then *a gantry drive that stops answering faults the machine and
     names the drive as the cause*
   Naming an outcome is fine when the name carries information the trigger did
   not ("reported as clipped, with only its remaining tail kept"). It is not
   fine when the name is the trigger in different words.
   Test it: cover `given` and read `then`. Then cover `then` and read `given`.
   If each predicts the other, there is no claim.

9. **Cite an expectation as `BH-42`, never renumber by hand.** The collector
   assigns the number on first collection and carries it forever; it lives in
   `behaviours.jsonl` and `behaviours.next`. On a merge conflict in either,
   keep the LARGER number — a reused number silently repoints old references.

10. **`id` is stable identity — reword freely, never rename casually.**
   `area.claim-in-brief` kebab-case (e.g. `gantry.slack-consumed-before-extension`).
   Same id + new wording renders as *respecified* (good, reviewable).
   New id renders as removed + added (a lie, if it's the same behaviour).

11. **Declare on ENTRY.** In C the macro is the FIRST statement of the test
   body; nothing checks this for you, and a crash before it makes the
   behaviour read as deleted. TS/Rust: call `behaviour(...)` first thing.

12. **One test, one condition.** If a test sets up two genuinely different
   conditions, it is two tests. Never self-report status — pass/fail joins from
   the runner, and every expectation of a test shares that test's verdict.

13. **After changing behaviours:** `node Vibes/bin/vibes.mjs collect --write`
   and commit `behaviours.jsonl` alongside the change.

## Snippets

TS — `behaviour({...}, fn)` **replaces** `it()`, do not nest. `why` is keyed by
the same expectation ids, and only for the ones that need it:
```ts
import { behaviour } from '@vibes/behaviour';
behaviour(
  {
    id: 'gcode.trailing-comment',
    covers: 'src/domain/gcode.ts#parseGcodeToMove',
    given: 'a move line with a trailing comment containing a coordinate token',
    expect: {
      'target-survives': 'the target position is the one the author wrote before the comment',
      'comment-dropped': 'no parameter is taken from the comment',
    },
    why: { 'target-survives': 'everything after the comment marker is annotation' },
  },
  () => { /* expect(...) */ },
);
```

C — `VIBES_TEST` is the FIRST statement in the Unity test body; the expectations
follow it:
```c
void test_run_cogFaultDetected(void)
{
    VIBES_TEST("control.stopped-core",
               "src/APP/app_control.c#app_control_run",
               "one of the cores stops reporting that it is running");
    VIBES_EXPECT_WHY("fault-raised",
                     "the machine faults and names a processor core as the reason",
                     "the motion and monitoring loops run on separate cores");
    VIBES_EXPECT("motion-off", "motion stays off");
    /* ... the test ... */
}
```

Rust — `behaviour!` declares the test, `expect!` adds each expectation. The
three-argument form carries the reason:
```rust
behaviour!(Test {
    id: "gantry.slack-consumed-before-extension",
    covers: Some("SIL/models/src/gantry.rs#on_position"),
    given: "travel smaller than the configured engagement slack",
});
expect!("no-extension", "extension stays at zero until travel exceeds the slack");
```

There is no v1. The old single-`then` macros are gone, and a v1 record in the
ledger is rejected rather than read — accepting one would file every expectation
of that test under a single identity.
