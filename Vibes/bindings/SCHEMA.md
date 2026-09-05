# behaviours.jsonl — the contract between a binding and Vibes

One JSON object per line, UTF-8, LF. Order is not significant; Vibes sorts.

```json
{"v":1,"id":"gcode.trailing-comment","lang":"ts","file":"src/domain/gcode.test.ts",
 "test":"parseGcodeToMove > ignores a trailing comment",
 "covers":"src/domain/gcode.ts#parseGcodeToMove",
 "given":"a G-code line with a trailing comment containing a coordinate token",
 "then":"the comment is ignored and the authored X survives",
 "why":"pins a defect where G1 X10 ; X50 moved to X50"}
```

| field    | required | why it exists                                                        |
|----------|----------|----------------------------------------------------------------------|
| `v`      | yes      | schema version. A binding emitting a version Vibes does not know is an error, not a skip. |
| `id`     | yes      | STABLE identity. Survives rewording, so a reworded test is a metadata change rather than delete+add. |
| `lang`   | yes      | provenance only. Vibes never branches on it.                          |
| `file`   | yes      | where the test lives, repo-relative.                                  |
| `test`   | yes      | the runner's own name for this test. THE JOIN KEY for pass/fail — see below. |
| `covers` | no       | `path#symbol` the behaviour exercises. Joins to patch coverage.        |
| `given`  | yes      | the precondition, in words.                                           |
| `then`   | yes      | the asserted outcome. A change here is a SPECIFICATION change and is reported loudest. |
| `why`    | no       | why it matters — a pinned defect, a requirement.                      |

## Writing the claim

The ledger is read by someone who has NOT seen the code — that is its entire
purpose. A claim that needs the code to decode has already failed:

    then: "the dwell is emitted as exactly one op and P survives in milliseconds"

"op" is an internal type name and "P" is a parameter letter. The reader this
report exists for knows neither. The same claim, written for them:

    then: "exactly one pause is produced, and its duration is kept in
           milliseconds without conversion"

Rules of thumb:

- **No internal type names** (op, ProgramOp, struct fields) and **no parameter
  letters** (P, X, F). Say what the thing IS to the machine or its operator:
  a pause, a move, a target position, a speed.
- Domain words the operator genuinely uses are fine — G-code, dwell, gauge
  length, tensile — implementation words are not.
- `then` must be a complete sentence a reviewer can judge true or false about
  the SYSTEM, not a restatement of the assertion. "returns 3" is an assertion;
  "a five-millimetre travel with two millimetres of slack strains the sample by
  three" is a claim.
- **`then` stands alone.** It is printed as the row headline, often by itself:
  name the subject (no `it`/`this`), state the specific outcome (no
  `correctly`/`whatever`), and carry any condition the claim depends on.
- `given` then adds the concrete scene — the exact inputs.
- Write `why` when the behaviour exists for a reason the claim alone does not
  carry — a defect it pins, a safety property, a hardware constraint.

A quick test: read `given` + `then` aloud to someone who has never opened the
repo. If you have to explain a word, change the word.

## Two rules every binding must follow

**1. Emit on ENTRY, never on exit.** A test that fails or crashes must still emit
its line. If emission happened at the end, a crashing test would produce no line
and Vibes would report the behaviour as REMOVED — "this PR deleted a behaviour"
when the truth is "a test crashed" is the worst misreport available.

**2. Status is NOT in this file.** Pass/fail comes from the runner's own output
and is joined on `test`. A binding that reported its own status would be
reporting on a test that had not finished yet.

## Being inert

A binding writes only when `VIBES_BEHAVIOURS` names a file. Unset, it is a no-op
so the suite runs normally outside Vibes. Appends use O_APPEND and stay under
PIPE_BUF (4096 bytes), so parallel workers interleave without a lock; a line
longer than that is truncated by the binding rather than corrupting a neighbour.
