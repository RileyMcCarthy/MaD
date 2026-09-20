---
name: writing-behaviours
description: How to write and word Vibes behaviour declarations when adding or changing tests in this repo — TS (@vibes/behaviour), C (vibes_behaviour.h), or Rust (vibes-behaviour). Use whenever writing tests, annotating tests with behaviour()/VIBES_TEST/VIBES_EXPECT/expect!, editing behaviours.jsonl claims, or asked to add test coverage.
---

# Writing behaviours for the Vibes ledger

A test declares the **condition** it sets up once, then one or more
**expectations** for that condition. Each expectation is its own row in
`behaviours.jsonl`, its own `BH-` number, and its own line in the PR report.
PRs are reviewed from the **diff of that ledger** — added / respecified /
removed / stopped holding. The reader has never opened the code. Full guide: `docs/coding-guidelines/vibes-behaviours.md`.
The tool is a submodule at `Vibes/`; its own rules are `Vibes/bindings/CLAIMS.md`
and its wire contract `Vibes/bindings/SCHEMA.md`. Tool changes go upstream first.

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

5. **State the RULE, not the instance.** A value the test happens to assert is
   evidence; the rule that produces it is the behaviour. If a reader cannot
   tell whether the number is right without knowing a rule you did not write
   down, the expectation says nothing.
   - BAD:  given *a curve from 0 to 10 mm over two seconds* / then *one second in reads 5 mm*
   - GOOD: given *a curve from 0 to 10 mm over two seconds* / then *a sample between two points reads the straight-line value between them*
   The bad one is unjudgeable: 5 mm is right for linear interpolation, wrong for
   a step or a spline, and the claim never says which.
   A bare value is fine when the condition makes the rule unambiguous (*a 1 mm
   extension on a 10 mm gauge* → *strain is 10 percent*) or when the value IS
   the contract (*encodes to the agreed 68 bytes on the wire*).

6. **`then` is a claim about the machine, not the assertion restated.**
   "returns 3" is an assertion. "a five-millimetre travel with two millimetres
   of slack strains the sample by three" is a claim a reviewer can judge.

7. **A spec says what the machine DOES — never what it does not do, used to
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

8. **Use the words THIS repo uses.** Operator vocabulary is not the same as
   industry vocabulary. A tensile machine has a "crosshead" in Instron's
   manuals; this one has a **gantry**, in 36 files. Writing "crosshead" made a
   claim the maintainer had to stop and ask about — the exact failure rule 1
   exists to prevent, arrived at from the other side.
   Checkable: `git grep -i "<your word>" -- ':!behaviours.jsonl'`. If the term
   appears nowhere in the code or docs, you imported it — use theirs.

9. **The claim must say what the MACHINE DOES, not what the situation is
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

10. **Cite an expectation as `BH-42`, never renumber by hand.** The collector
   assigns the number on first collection and carries it forever; it lives in
   `behaviours.jsonl` and `behaviours.next`. On a merge conflict in either,
   keep the LARGER number — a reused number silently repoints old references.

11. **`id` is stable identity — reword freely, never rename casually.**
   `area.claim-in-brief` kebab-case (e.g. `gantry.slack-consumed-before-extension`).
   Same id + new wording renders as *respecified* (good, reviewable).
   New id renders as removed + added (a lie, if it's the same behaviour).

12. **Declare on ENTRY.** In C the macro is the FIRST statement of the test
   body; nothing checks this for you, and a crash before it makes the
   behaviour read as deleted. TS/Rust: call `behaviour(...)` first thing.

13. **One test, one condition.** If a test sets up two genuinely different
   conditions, it is two tests. Never self-report status — pass/fail joins from
   the runner, and every expectation of a test shares that test's verdict.

14. **The report supplies the frame — `given` finishes its sentence.** The
   renderer prints `**When** <given>` and nests the expectations under it, so
   `given` names a SITUATION and must read as one on the first pass. Each
   half of this claim passed every rule above; composed, it has no main clause:
   - BAD: given *a byte left on the load-cell ADC serial link by an abandoned
     exchange, then a start* — "a byte **left**" garden-paths as a verb, and
     ", then a start" is a bare noun using the report's own word for the
     expectation.
   - GOOD: given *a start of the load-cell ADC with a leftover byte on the link
     from an abandoned exchange*
   Name a situation, not a thing. Sequence with `after`, `while`, `that begins
   with` — a second beat must have something HAPPENING in it (*"gauge length
   zeroed, then the jaws moved further"* reads; *"…, then a start"* does not).
   Avoid a participle that is also a past tense right after a noun (`left`,
   `read`, `set`, `sent`, `held`, `run`): write "a byte **that** an abandoned
   exchange **left**", or the `-ing` form, or name the thing outright.

15. **An expectation is an OUTCOME, not a step.** If the sentence describes what
   the code does on its way to the result, it is a `why` at most.
   - BAD:  `the leftover is flushed before the configuration read-back`
   - GOOD: `the start completes and the converter is converting`
   Test it: could an operator, or anyone outside that function, tell whether
   this held? If the only way to know is to watch the code run, it is not an
   expectation. Mechanism goes in `why` ("each register read is one request
   and one reply, so a leftover would shift every reply after it").

16. **Render it and read it — BEFORE collecting.** Rules 14 and 15 were both
   broken by a claim whose two halves were only ever read as separate strings.
   Neither command below runs a suite:
   ```bash
   node Vibes/bin/vibes.mjs preview --given "<given>" --then "<then>" [--then "<then2>"] [--why "<why>"]
   node Vibes/bin/vibes.mjs lint --file <test file>      # once collected
   ```
   `preview` prints the composed `**When** …` block exactly as the PR will and
   lints the same text. Read the block aloud; a sentence with no main clause
   is a rewrite, whatever the lint says. `lint` exits 4 on an error-level
   finding (names from the code, contrast words, vague claims); warnings
   (machinery, garden paths) are advice — fix them unless the claim genuinely
   reads fine. A word this repo genuinely uses that the lint flags goes in
   `vibes.lint.json`, scoped by path, with a `why`. CI runs `vibes lint` over
   the whole ledger and blocks on errors.

17. **Every id area has a capability paragraph in `vibes.capabilities.md`.**
   The area is the id up to its first dot (`monitor.logging-writes-a-row` →
   `monitor`); the report groups rows under the capability that owns it and
   prints its paragraph above them. A NEW area needs a heading there —
   `## <title> \`<suite>/<area>\`` and a paragraph written for the operator:
   what the machine does for them, why it matters (what is lost if it fails),
   and only then the shape of the thing. It is not a summary of the tests.
   `vibes lint` refuses an area with no heading. Prefer an existing area over
   a new one; a capability may own several areas.

18. **After changing behaviours:** `node Vibes/bin/vibes.mjs collect --write`
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
