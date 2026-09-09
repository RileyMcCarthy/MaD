# vibes.suite.json — how Vibes finds and runs a test suite

One file per runnable suite, committed, living beside the tests it describes.

```json
{
  "v": 1,
  "name": "control",
  "lang": "ts",
  "cmd": "npx vitest run --reporter=json --outputFile=$VIBES_RESULTS",
  "results": "vitest-json"
}
```

| field     | required | meaning |
|-----------|----------|---------|
| `v`       | yes      | schema version. An unknown version is an error, not a skip. |
| `name`    | yes      | suite id, unique in the repo. Appears in the report. |
| `lang`    | yes      | provenance only. Vibes never branches on it. |
| `cmd`     | yes      | run the tests. Executed with the suite file's directory as cwd. |
| `results` | yes      | format of the runner's own output: `vitest-json`, `unity-stdout`, `cargo-stdout`. |

## Discovery is `git ls-files`, never a filesystem walk

Vibes locates suites with `git ls-files '*vibes.suite.json'`. That matters here:
this repo carries 18 git worktrees, several nested under `.claude/worktrees/`,
each a full checkout. A filesystem glob would find every stale copy and run
their suites. `git ls-files` sees only tracked files in the current worktree,
so the problem cannot arise.

It also means an untracked suite file is invisible — deliberately. A suite
nobody committed is not part of the repo's declared behaviour.

## Two environment variables

Vibes sets both before running `cmd`:

- **`VIBES_BEHAVIOURS`** — the bindings append one JSON line per declared
  behaviour here. See SCHEMA.md.
- **`VIBES_RESULTS`** — where the runner should write its own output, in the
  format `results` names. Vibes reads pass/fail from it and joins on `test`.

Status is deliberately NOT in the behaviour ledger. The bindings emit on entry,
before the test has passed or failed; taking status from the runner is what lets
a crashed test still have its behaviour recorded rather than appearing deleted.

## What a missing join means

A behaviour whose `test` matches no result is reported as **`did-not-report`**,
never as passing. That is the honest reading: the binding ran, so the behaviour
was declared, but nothing said whether it held.
