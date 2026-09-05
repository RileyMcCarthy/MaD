# Writing behaviours for the Vibes ledger

Vibes turns annotated tests into a **behaviour ledger** (`behaviours.jsonl`) and, on every PR, reports the diff: what behaviour the change adds, what it respecifies, what it removed, and what stopped holding. The report is read **instead of the code** — by a reviewer on the PR page, or by anyone asking "what does this system actually claim to do?"

That readership is the entire design constraint: **every word of a behaviour is written for someone who has never opened the repo.**

## The shape

```ts
behaviour(
  {
    id: 'gcode.dwell-carries-milliseconds',
    covers: 'src/domain/gcode.ts#gcodeLinesToProgram',
    given: 'a pause command with a duration',
    then: 'a pause command produces exactly one pause, with its duration kept in milliseconds without conversion',
    why: 'the firmware sleeps for this literal value; a unit slip here is a real-time bug',
  },
  () => { /* assertions */ },
);
```

| field | what it is |
|---|---|
| `id` | The behaviour's **stable identity**. Never encodes wording. |
| `given` | The situation, in operator language. |
| `then` | The claim — a sentence a reviewer can judge true or false **about the machine**. |
| `covers` | `path#symbol` the behaviour exercises. Joins to patch coverage. Optional. |
| `why` | The reason it matters when the claim alone doesn't carry it: a pinned defect, a safety property, a hardware constraint. Optional. |

## Writing the claim

This failed review, verbatim from an early ledger:

> the dwell is emitted as exactly one **op** and **P** survives in milliseconds

"op" is an internal type name; "P" is a G-code parameter letter. The reader this
report exists for knows neither. The same claim, written for them:

> exactly one pause is produced, and its duration is kept in milliseconds without conversion

Rules, in priority order:

1. **No internal type names, no parameter letters, no variable names.** Say what
   the thing *is* to the machine or its operator: a pause, a move, a target
   position, a speed, a fault.
2. **Domain words the operator genuinely uses are fine** — G-code, dwell, gauge
   length, tensile, load cell. Implementation words are not — op, struct, enum,
   buffer, `ProgramOp`.
3. **`then` is a claim, not an assertion restated.** "returns 3" is an
   assertion. "a five-millimetre travel with two millimetres of slack strains
   the sample by three" is a claim. If `then` could caption *any* test, it says
   nothing.
4. **`given` + `then` read as one sentence.** *Given* a pause command with a
   duration, *then* exactly one pause is produced…
5. **Write `why` for the non-obvious.** A defect it pins ("fixes a defect where
   `G1 X10 F5 ; X50` moved to X50"), a hardware constraint ("the P2 has no
   64-bit divide; a 32-bit intermediate would silently wrap").

The acceptance test: read `given` + `then` aloud to someone who has never seen
this repo. **If you have to explain a word, change the word.**

## `then` stands alone

The report prints `then` as the bolded headline of every row — in the "stopped
holding" list it is often the *only* thing a reviewer reads. So `then` cannot
lean on `given`. This claim was rejected in review:

> it stays a rapid move to zero, whatever the comment says

"it" has no antecedent on its own line, and "whatever the comment says" is a
sweep phrase, not a claim. Rewritten to stand alone:

> a rapid move to zero with a trailing comment naming a different move is still a rapid move to zero

Three checks, applied to `then` read **by itself**:

1. **Name the subject.** No `it`, `this`, `they`. The reader has not seen
   `given` yet.
2. **State the specific outcome.** No `correctly`, `properly`, `as expected`,
   `whatever`. A wrong implementation must make the sentence *false* — if a
   bug could ship and the sentence still read true, it is not a claim.
3. **Carry the condition it depends on.** If the claim is only true under a
   configuration or mode, say so in `then`. "moving to a smaller position
   produces positive extension" is *false* on the default machine; "on a
   machine whose tensile direction is decreasing position, moving to a smaller
   position produces positive extension" is true everywhere it is read.

`given` then adds the concrete scene — the exact inputs — rather than carrying
information `then` needs to be true.

## Choosing an `id`

`area.claim-in-brief`, kebab-case: `gcode.trailing-comment`,
`gantry.slack-consumed-before-extension`, `firmware.muldiv64-signed`.

The `id` is what makes the ledger diff four-way instead of two-way:

| you change… | the report says |
|---|---|
| the wording of `then`/`given`, same `id` | **respecified** — old and new claims side by side |
| the `id` | one behaviour **removed** + an unrelated one **added** |

So: **rewording a claim is normal and encouraged — keep the `id`.** Change an
`id` only when the behaviour genuinely is a different claim. Never version ids
(`-v2`) and never encode the wording in them.

## Rules the bindings enforce (and one they can't)

- **Declared on entry, never on exit.** A test that fails or crashes must still
  record its behaviour; otherwise a crash reads as "this PR deleted a
  behaviour". The TS binding does this structurally. **In C, the macro must be
  the first statement in the test body** — that placement is load-bearing and
  nothing checks it for you.
- **Status is never self-reported.** Pass/fail is joined from the runner's own
  output. A behaviour whose test reported nothing shows as `did-not-report`,
  never as passing.
- **One behaviour per test.** The join is per test; two declarations in one
  test share a fate and blur the ledger.

## Per language

**TypeScript** (`@vibes/behaviour`, wraps `it()` — do not also call `it`):

```ts
import { behaviour } from '@vibes/behaviour';
behaviour({ id, covers, given, then, why }, () => { /* expect(...) */ });
```

**C** (`vibes_behaviour.h`, header-only; first statement in a Unity test body):

```c
void test_lib_utility_muldiv64_signed(void)
{
    VIBES_BEHAVIOUR_WHY("firmware.muldiv64-signed",
                        "src/Library/lib_utility.c#lib_utility_muldiv64_signed",
                        "a multiply-then-divide whose intermediate exceeds 32 bits",
                        "a multiply-then-divide with an intermediate wider than 32 bits is computed exactly, and the sign is negative for an odd number of negative inputs",
                        "the P2 has no 64-bit divide; a 32-bit intermediate would silently wrap");
    /* assertions */
}
```

**Rust** (`vibes-behaviour`, first statement in the test):

```rust
behaviour!(Behaviour {
    id: "gantry.slack-consumed-before-extension",
    covers: Some("SIL/models/src/gantry.rs#on_position"),
    given: "travel smaller than the configured engagement slack",
    then: "extension stays at zero until travel exceeds the engagement slack",
    why: Some("the sample is not yet loaded, so reporting strain would be wrong"),
});
```

All three are inert unless `$VIBES_BEHAVIOURS` is set, so suites run normally on
their own.

## Suites and the ledger

A runnable suite is declared by a committed `vibes.suite.json` next to it
(discovered via `git ls-files` — an uncommitted suite file is invisible, on
purpose). After adding or changing behaviours:

```bash
node Vibes/bin/vibes.mjs collect --write   # regenerate behaviours.jsonl
```

and commit the ledger with your change. CI (`Behaviour ledger` job) reports the
diff on every PR — as a single comment on the PR, edited in place on each run
so it always shows the latest verdict, and in the job summary — and warns when
the committed ledger is stale.
