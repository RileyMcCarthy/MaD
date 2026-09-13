# behaviours.jsonl — the contract between a binding and Vibes

One JSON object per line, UTF-8, LF. Order is not significant; Vibes sorts.

**One line per EXPECTATION, not per test.** A test declares the condition it
sets up once, and every expectation for that condition is its own line, sharing
the test's `id`, `given`, `file` and `covers`:

```json
{"v":2,"id":"gcode.trailing-comment","expect":"target-survives","lang":"ts",
 "file":"src/domain/gcode.test.ts",
 "test":"a move line with a trailing comment containing a coordinate token [gcode.trailing-comment]",
 "covers":"src/domain/gcode.ts#parseGcodeToMove",
 "given":"a move line with a trailing comment containing a coordinate token",
 "then":"the target position is the one the author wrote before the comment",
 "why":"everything after the comment marker is annotation"}
{"v":2,"id":"gcode.trailing-comment","expect":"comment-dropped","lang":"ts",
 "file":"src/domain/gcode.test.ts",
 "test":"a move line with a trailing comment containing a coordinate token [gcode.trailing-comment]",
 "covers":"src/domain/gcode.ts#parseGcodeToMove",
 "given":"a move line with a trailing comment containing a coordinate token",
 "then":"no parameter is taken from the comment"}
```

| field    | required | why it exists                                                        |
|----------|----------|----------------------------------------------------------------------|
| `v`      | yes      | schema version, currently `2`. A binding emitting a version Vibes does not know is an error, not a skip. |
| `id`     | yes      | the TEST's stable identity. Several expectations share it.           |
| `expect` | yes      | this expectation's stable id, unique within the test. Identity is `suite/id/expect`. |
| `lang`   | yes      | provenance only. Vibes never branches on it.                          |
| `file`   | yes      | where the test lives, repo-relative.                                  |
| `test`   | yes      | the runner's own name for this test. THE JOIN KEY for pass/fail.      |
| `given`  | yes      | the CONDITION the test sets up, shared by every expectation of it.    |
| `then`   | yes      | ONE expectation for that condition. A change here is a specification change and is reported loudest. |
| `covers` | no       | `path#symbol` the behaviour exercises, so a reader can find the code. |
| `why`    | no       | the standing requirement this expectation serves.                     |

Vibes adds two fields the bindings never send: `status`, joined from the
runner's own output, and `num`, a short handle (`BH-42`) for citing one
expectation in a review or a commit message. A number is assigned the first time
an expectation is collected and never reused, even after it is deleted, so a
citation written a year ago still means the same claim. It is not the identity —
`id` plus `expect` is.

## Why identity is a pair

`id` alone would make every expectation of a test indistinguishable, and a
position in a list would make inserting one look like all of them changed.
Naming each expectation means rewording it is a change to THAT expectation and
leaves its siblings alone — the same reason `id` itself is stable across a
rewording.

Which is why **v1 records are rejected rather than read**. A v1 line has one
welded `then` and no `expect`, so accepting it would file every expectation of
that test under one identity.

## Writing the claim

`given` is the condition. `then` is one expectation for it, and does NOT restate
the condition — the report prints them together:

```
- given a move line with a trailing comment containing a coordinate token
  **the target position is the one the author wrote before the comment** BH-42
  **no parameter is taken from the comment** BH-43
```

The ledger is read by someone who has NOT seen the code — that is its entire
purpose. A claim that needs the code to decode has already failed:

    then: "the dwell is emitted as exactly one op and P survives in milliseconds"

"op" is an internal type name and "P" is a parameter letter. The reader this
report exists for knows neither. The same claim, written for them, and split
because it is two expectations wearing one sentence:

    expect "one-pause":         "exactly one pause is produced"
    expect "milliseconds-kept": "the duration is kept in milliseconds without conversion"

Rules of thumb:

- **No internal type names** (op, ProgramOp, struct fields) and **no parameter
  letters** (P, X, F). Say what the thing IS to the machine or its operator.
- Domain words the operator genuinely uses are fine — G-code, dwell, gauge
  length, tensile — implementation words are not. Use the words THIS repo uses:
  the moving part that pulls the sample is the **gantry**.
- `then` states what the MACHINE DOES, not what the situation is called. An
  outcome that only re-labels the condition is not an expectation.
- `then` must be specific enough that a wrong implementation makes it FALSE.
- Write `why` when an expectation exists for a reason the claim does not carry —
  a safety property, a hardware constraint, a requirement.

A quick test: read `given` + one `then` aloud to someone who has never opened the
repo. If you have to explain a word, change the word.

## How many expectations?

Let the test's assertions decide. One assertion is one expectation. Several
assertions about genuinely different things are several. Assertions that
together establish ONE fact — three fields of the same decoded record all
surviving a round trip — are one expectation, not three.

## Two rules every binding must follow

**1. Emit on ENTRY, never on exit.** A test that fails or crashes must still emit
its lines. If emission happened at the end, a crashing test would produce none
and Vibes would report the behaviours as REMOVED — "this PR deleted a behaviour"
when the truth is "a test crashed" is the worst misreport available.

**2. Status is NOT in this file.** Pass/fail comes from the runner's own output
and is joined on `test`. A binding that reported its own status would be
reporting on a test that had not finished yet. Every expectation of a test
shares that test's verdict.

## Being inert

A binding writes only when `VIBES_BEHAVIOURS` names a file. Unset, it is a no-op
so the suite runs normally outside Vibes. Appends use O_APPEND and stay under
PIPE_BUF (4096 bytes), so parallel workers interleave without a lock; a line
longer than that is truncated by the binding rather than corrupting a neighbour.
