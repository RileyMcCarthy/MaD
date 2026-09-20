# Writing behaviours for the Vibes ledger

Vibes turns annotated tests into a **behaviour ledger** (`behaviours.jsonl`) and, on every PR, reports the diff: what behaviour the change adds, what it respecifies, what it removed, and what stopped holding. The report is read **instead of the code** — by a reviewer on the PR page, or by anyone asking "what does this system actually claim to do?"

That readership is the entire design constraint: **every word of a behaviour is written for someone who has never opened the repo.**

Vibes itself lives at [RileyMcCarthy/vibes](https://github.com/RileyMcCarthy/vibes)
and is a submodule at `Vibes/`. The wire contract is
[`Vibes/bindings/SCHEMA.md`](https://github.com/RileyMcCarthy/vibes/blob/main/bindings/SCHEMA.md) and the
claim-writing rules are [`Vibes/bindings/CLAIMS.md`](https://github.com/RileyMcCarthy/vibes/blob/main/bindings/CLAIMS.md).
What follows is those rules with MaD's own examples, plus how MaD wires the
suites. **Changes to the tool land upstream first**, then the pinned commit is
bumped here — the same as `embsim` and `ProtoEmb`.

## The shape

A test declares the **condition** it sets up once, then one or more
**expectations** for that condition:

```ts
behaviour(
  {
    id: 'gcode.dwell-carries-milliseconds',
    covers: 'src/domain/gcode.ts#gcodeLinesToProgram',
    given: 'a pause command with a duration',
    expect: {
      'one-pause': 'exactly one pause is produced',
      'milliseconds-kept': 'the duration is kept in milliseconds without conversion',
    },
    why: { 'milliseconds-kept': 'the firmware sleeps for this literal value; a unit slip here is a real-time bug' },
  },
  () => { /* assertions */ },
);
```

Each expectation is its own row in the ledger, its own `BH-` number, and its own
line in the report:

```
- **When** a pause command with a duration
  - exactly one pause is produced `BH-88`
  - the duration is kept in milliseconds without conversion `BH-89`
```

| field | what it is |
|---|---|
| `id` | The **test's** stable identity. Its expectations hang off it. |
| `given` | The condition, in operator language. Shared by every expectation. |
| `expect` | One entry per expectation, keyed by a short id that is stable across rewording. The value is what the machine does. |
| `covers` | `path#symbol` the test exercises, so a reader can find the code. Optional. |
| `why` | Keyed by the same expectation ids, for the ones whose claim doesn't carry its own reason. Optional. |

Identity is `suite/id/expect`. Naming each expectation is what lets you reword
one without its siblings reading as changed — the same reason `id` itself is
stable. There is no v1: the old single-claim form is gone, and a v1 record is
rejected rather than read, because accepting one would file every expectation of
a test under a single identity.

## The capability above the claim

A row is a unit test described politely — *the records land in the file* —
and a thousand of them grouped by file path read as a thousand mechanisms.
What a reader wants first is *what is this a part of, and what is it for?*,
and that is not in any row. So it is declared once, in
[`vibes.capabilities.md`](../../vibes.capabilities.md) at the repo root: a
heading per capability ending in the test-id areas it owns, and a paragraph
written for the operator.

```markdown
## Test monitoring and data logging `firmware/monitor`

During a test the machine ... writes every new load-cell reading to the SD
card ... so a crash or power loss part-way through loses nothing already
measured.
```

The area is the id up to its first dot, so no annotation changes. The PR
report leads with which capabilities changed, groups every section under
those headings in the file's order, and prints each paragraph once;
`node Vibes/bin/vibes.mjs preview` with no filter is the whole ledger as a
document. A new id area needs a heading — `vibes lint` refuses one without.
Prefer an existing area; a capability may own several.

## How many expectations?

Let the test's assertions decide, not the sentence structure.

| the test asserts | expectations |
|---|---|
| one thing | one |
| several genuinely different things | one each |
| several things that together establish ONE fact (three fields of a decoded record surviving a round trip) | one |

A claim reading "no chunk appears in the capture **and** the chunk count stays
at zero" is two expectations wearing one sentence. A claim reading "the name,
travel limit and load-cell constants all come back intact" is one.

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
5. **Write `why` for the non-obvious.** The requirement the claim does not
   already carry ("the target is what the author wrote before the comment;
   everything after it is annotation"), a hardware constraint ("the P2 has no
   64-bit divide; a 32-bit intermediate would silently wrap"). Never the
   defect that taught you the requirement.

The acceptance test: read `given` + `then` aloud to someone who has never seen
this repo. **If you have to explain a word, change the word.**

## `given` is the condition, `then` is the expectation

Each field does one job. The report prints them together:

```
- **When** one of the cores stops reporting that it is running
  - the machine reports a core fault `BH-352`
  <sub>`src/APP/app_control.c#app_control_run`</sub>
```

For a long time `then` was printed as the headline on its own, so it had to
carry its own condition to be readable. Every claim therefore restated its
scene, and the outcome was whatever was left at the end:

> given *one of the cores stops reporting that it is running*
> then *a processor core that stops running is reported as a core fault*

Thirteen words to say six. Worse, the habit hides claims that say nothing at
all — once the condition is repeated, "is reported as a core fault" looks like
an outcome when it is only a label.

`then` still has to be specific enough that a bug makes it false, and it still
has to carry any condition the scene does not establish. It simply must not
repeat the scene it was handed.

## The report supplies the frame — `given` finishes the sentence

The renderer prints `**When** <given>` and nests the expectations under it, so
`given` is the first half of a sentence somebody else already started. It has
to name a **situation**, and read as one on the first pass. This reached the
ledger with every rule above satisfied by each half on its own:

> **When** *a byte left on the load-cell ADC serial link by an abandoned
> exchange, then a start*

"A byte **left**" garden-paths as a verb — the main clause never arrives — and
", then a start" is a bare noun using the report's own word for the
expectation. What it wanted to say:

> **When** *a start of the load-cell ADC with a leftover byte on the link from
> an abandoned exchange*

Name a situation, not a thing. Sequence with `after`, `while`, `that begins
with`; a second beat needs something happening in it. Watch a participle that
is also a past tense right after a noun (`left`, `read`, `set`, `sent`,
`held`, `run`). The one reliable check is not a rule: **render it and read
it** — `vibes preview`, below.

## An expectation is an outcome, not a step

The same row failed the other way round: *"the leftover is flushed before the
configuration read-back"* is a step in the driver's procedure — true, checked,
and no use to a reader, who learns that something internal happens in some
order and nothing about what the machine does. Its sibling is the claim:

| | |
|---|---|
| BAD | the leftover is flushed before the configuration read-back |
| GOOD | the start completes and the converter is converting |

Test it: could an operator, or anyone outside that function, tell whether this
held? If the only way to know is to watch the code run, it is a `why` at most.
Mechanism is welcome in `why` (*"each register read is one request and one
reply, so a leftover would shift every reply after it"*); it is not welcome in
`then`, where it stands in for one.

## State the rule, not the instance

A value the test happens to assert is evidence. The rule that produces it is the
behaviour. This claim was rejected in review:

> given *an expected curve from 0 to 10 mm over two seconds*
> then *one second in reads 5 mm*

Five millimetres is right for straight-line interpolation, wrong for a step and
wrong for a spline, and the claim never says which — so a reader has no way to
judge it. The rule is what was actually built:

> then *a sample between two points reads the straight-line value between them*

Its sibling in the same test got this right already: "samples outside the span
hold the start and end positions" names the clamping rule rather than reporting
that −1 s came back as 0.

A bare value is fine in two cases. When the condition makes the rule
unambiguous — *a 1 mm extension on a 10 mm gauge* → *strain is 10 percent* —
and when the value IS the contract, as with a wire format: *the configuration
encodes to the agreed 68 bytes*. The test there is whether a reader who
disagrees with the number would know what to go and check.

## A spec says what the machine does

Not what it does not do, not what it used to do, and never what a bug once did.
This claim was rejected in review:

> lost power in the emergency-stop circuit is reported as the power fault, not
> as a tripped switch

The trailing contrast makes the reader stop and work out which half is true,
and it quietly implies the other half was once a bug. Neither belongs in a
specification. The machine has one behaviour, so state it:

> lost power in the emergency-stop circuit is reported as the power fault

Ban these from `then` and `given`: `not as`, `rather than`, `instead of`,
`no longer`, `used to`, and any mention of a defect, regression, or what
shipped.

The same rule governs `why`. Researching the commit that introduced a test is
worth doing — it is often the only place the reason survives — but write down
the **requirement it taught you**, never the story:

| instead of | write |
|---|---|
| fixes a defect where `G1 X10 F5 ; X50` moved to X50 | the target is what the author wrote before the comment; everything after it is annotation |
| this check sat commented out, so a test could overpull | the operator's configured force limit protects the specimen for the whole of a test |
| the changeover shipped asking the idle drive, so the machine sat disabled | only the drive actually running reports its readiness, so the controller asks the active one |

One thing that looks like a contrast and is not: a **condition the claim needs
to be true**. "a supervised loop that stops checking in is reported as a
watchdog fault, even while every processor core is still running" carries a
condition, not a comparison. Keep those — rule 2 above requires them.

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
  record its expectations; otherwise a crash reads as "this PR deleted a
  behaviour". The TS binding does this structurally. **In C, `VIBES_TEST` must
  be the first statement in the test body** — that placement is load-bearing and
  nothing checks it for you.
- **Status is never self-reported.** Pass/fail is joined from the runner's own
  output, per test. An expectation whose test reported nothing shows as
  `did-not-report`, never as passing.
- **Every expectation of a test shares that test's verdict.** That is a
  consequence of joining on the test, not a limitation to work around: one test
  passes or fails as a whole. If two expectations need to fail independently,
  they belong to two tests.
- **One condition per test.** Several expectations are expected and encouraged;
  several *conditions* mean the test is really two tests.

## Per language

**TypeScript** (`@vibes/behaviour`, wraps `it()` — do not also call `it`):

```ts
import { behaviour } from '@vibes/behaviour';
behaviour({ id, covers, given, expect: { 'an-id': '...' }, why: { 'an-id': '...' } },
          () => { /* expect(...) */ });
```

**C** (`vibes_behaviour.h`, header-only; `VIBES_TEST` first in the test body):

```c
void test_lib_utility_muldiv64_signed(void)
{
    VIBES_TEST("firmware.muldiv64-signed",
               "src/Library/lib_utility.c#lib_utility_muldiv64_signed",
               "a multiply-then-divide whose intermediate exceeds 32 bits");
    VIBES_EXPECT_WHY("exact",
                     "the result is computed exactly",
                     "the P2 has no 64-bit divide; a 32-bit intermediate would silently wrap");
    VIBES_EXPECT("sign", "the sign is negative for an odd number of negative inputs");
    /* assertions */
}
```

**Rust** (`vibes-behaviour`, `behaviour!` first in the test):

```rust
behaviour!(Test {
    id: "gantry.slack-consumed-before-extension",
    covers: Some("SIL/models/src/gantry.rs#on_position"),
    given: "travel smaller than the configured engagement slack",
});
expect!("no-extension", "extension stays at zero until travel exceeds the slack",
        "the sample is not yet loaded, so reporting strain would be wrong");
```

All three are inert unless `$VIBES_BEHAVIOURS` is set, so suites run normally on
their own, and all three emit on ENTRY: a test that crashes must still have
recorded its expectations, or the report says they were deleted.

## Suites and the ledger

A runnable suite is declared by a committed `vibes.suite.json` next to it
(discovered via `git ls-files` — an uncommitted suite file is invisible, on
purpose). After adding or changing behaviours:

```bash
node Vibes/bin/vibes.mjs preview --given "…" --then "…"   # the composed line, as the PR shows it, then linted
node Vibes/bin/vibes.mjs collect --write                  # regenerate behaviours.jsonl (runs every suite)
node Vibes/bin/vibes.mjs lint                             # the decidable half of CLAIMS.md, over the ledger
```

`preview` and `lint` run no suite — use them while writing, not after. `lint`
exits 4 on an error-level finding (names from the code, contrast words, vague
claims); warnings (machinery in a claim, a garden-path scene) are advice. A
word this repo genuinely uses that the defaults flag goes in
`vibes.lint.json` at the repo root, scoped by path and with a `why`.

Commit the ledger with your change. CI (`Behaviour ledger` job) reports the
diff on every PR — as a single comment on the PR, edited in place on each run
so it always shows the latest verdict, and in the job summary — and warns when
the committed ledger is stale. A second job, `Behaviour wording`, runs
`vibes lint` over the committed ledger and **blocks** the PR on an error.
