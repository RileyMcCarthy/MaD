# Session logging

The app records a structured, always-on session log so a field failure can be
root-caused from a bug report rather than a reproduction. Before this existed
`src/` contained three `console.*` calls and nothing else.

Capture is unconditional; the console filter below only controls what is
*mirrored* to DevTools. A quiet console never means a thin log.

## API

```ts
import { logger } from '@/diagnostics/log';

const log = logger('device');           // cat: app|device|proto|store|ui|fs|perf|wasm
log.info('connect', 'link established', { baud, label });
log.warn('nack', undefined, { command });
log.error('read-failed', err.message, { bytesIn });
```

`logger(cat)` is cached per category, so inline `logger('proto').debug(...)` does
not allocate. Levels are `debug | info | warn | error`.

The `data` object is passed through `sanitize()`: depth-1 only, strings capped at
200 chars, `Uint8Array`/`ArrayBuffer` reduced to `{ bytes: n }`, `Error` to
name/message/5 stack frames, path-ish keys reduced to their basename, and
non-finite numbers stringified so they survive JSON. Nothing logged should ever
carry file contents or a full filesystem path — a bundle can end up in a public
issue.

## Threads

The device worker runs its own logger instance and batches entries to the main
thread every **250 ms or 100 entries**, whichever comes first, over a Comlink
proxy registered alongside the existing event sink (`setLogSink`). The main
thread folds them into the same ring, so `logSnapshot()` is one merged
main+worker timeline.

Both threads stamp `t = (Date.now() - performance.now()) + performance.now()`,
computed once per thread. `performance.timeOrigin` differs between a page and
its worker, so raw `performance.now()` values are not comparable; anchoring to
wall clock makes them so without a handshake, while keeping sub-ms resolution.

The worker flushes on its shutdown path, because a teardown is usually the
prelude to a worker termination that would otherwise take the most diagnostic
entries of the session with it.

## Ring

5000 entries, evict-oldest, with a `dropped` count so truncation is visible.
Per-`cat:tag` counters survive eviction, so "how many nacks this session" stays
accurate over a long run.

**Steady-state backoff.** The sample aggregator originally emitted every second,
which meant healthy traffic alone evicted the entire ring in ~83 minutes of
connected time — a long run would lose the connect sequence, the config and the
test program. A heartbeat that only says "still fine" does not deserve that
budget, so once the rate is steady it reports every 10 s instead
(`AGGREGATE_STEADY_MS`). Anything abnormal, or a rate change over 20 %, reports
immediately. That takes the ring from ~83 minutes to ~14 hours of healthy
traffic.

## Runtime verbosity

Console mirroring is controlled by two `localStorage` keys, read at boot and
settable at runtime via `setLogFilter(cats, level)`:

| Key | Value | Default |
| --- | --- | --- |
| `mad:log` | `*`, a comma-separated category list, or `''` to silence | `*` in dev, `*` in prod |
| `mad:loglevel` | `debug` \| `info` \| `warn` \| `error` | `info` in dev, `error` in prod |

```js
localStorage.setItem('mad:log', 'proto,device');
localStorage.setItem('mad:loglevel', 'debug');
```

Workers have no `localStorage`; access is guarded and the worker runs on the
defaults unless the main thread pushes a filter across.

## What is logged

| Category | Covers |
| --- | --- |
| `app` | boot identity (version, git SHA, UA, capabilities, viewport), intercepted `console.error`/`warn`, global `error`/`unhandledrejection`, visibility and online/offline transitions, main-thread stalls, heap growth |
| `device` | port open with USB VID/PID, WASM init duration, connect/disconnect, link loss with counters, read/write stream failures, e-stop, worker crash |
| `proto` | every non-periodic frame in and out by command **name**, acks, nacks, timeouts, round-trip durations, upload retries and failures, op start/end, test-run and download lifecycles |
| `perf` | one aggregate per second for the ~100 Hz sample stream: rate, counts, throughput, last force/position, and anomalies |
| `store` | user actions with their arguments *and outcomes*, field-level config diffs, machine-state transitions, faults, every toast shown |
| `ui` | route changes, React render crashes with component stack |
| `fs` | folder chosen/restored/permission, every DataStore op by name + duration, all failures |
| `wasm` | protocol-core traps (`poll()` panics) |
| `flash` | firmware programming: reset, boot-ROM detect attempts and replies, upload deciles, checksum verify, failure phase |

### Hot-path rules

The ~100 Hz sample and ~10 Hz state periodics never get a per-frame entry — they
feed `PeriodicAggregator`, which emits one summary per second and sanity-checks
values (non-finite, out-of-range, physically impossible position jumps). A
sample stream producing garbage is the bug; the frame that carried it is not
interesting on its own.

## Correlating an action with its frames

Every serialized worker operation gets a monotonic id and bracketing
`op-start` / `op-end` entries carrying the op name and duration. Frames emitted
while it is in flight are tagged `op: <id>`, so a report reads

```
store/manualMove              { mm: 5, speed: 10 }
proto/op-start  manualMove    { op: 7 }
proto/tx        WRITE_MANUAL_MOVE(19)  { op: 7, bytes: 7 }
proto/nack      WRITE_MANUAL_MOVE(19)  { op: 7 }
proto/op-end    manualMove    { op: 7, ok: true, durMs: 12 }
```

instead of leaving the reader to guess which write a NACK belonged to.

`runOp` already guarantees a single in-flight operation, so a plain field is a
correct "current op" marker — no async-context plumbing. Poll-driven traffic can
still interleave, so an inbound frame is only tagged when its command matches
the command the op actually wrote (`claimOpCommand`). The store-side action and
the worker-side op are joined by name and adjacency in the merged timeline
rather than by a shared id, since threading one through Comlink would mean
changing every method signature.

## Test runs and downloads

A run logs `test-program` before uploading: line count, byte size, an FNV-1a
content hash, a per-opcode histogram, and `endsWithG122`. That last flag makes
the project's classic footgun visible at a glance — a program without its
trailing `G122` never signals completion to the firmware. The hash answers "did
these two runs upload the same thing", which catches a non-deterministic
transform.

Then `test-uploaded` (duration), `test-started` (accepted by the device), or
`test-failed` — which records whether the partial SD file was invalidated,
because that decides whether a retry is safe or runs a half-written program.
`upload-aborted` reports how many batches and bytes made it out before a
failure.

Downloads log `download-start` / `download-done` / `download-failed` with
request count, bytes, duration, and **NACK retries** — a download that succeeded
after 40 BUSY NACKs is a bug report waiting to happen and is otherwise silent.

## Decode failures carry their bytes

A protocol `error` event and a WASM `poll-trap` both attach `tail`: a hex dump
of the last 64 (or 96) bytes from the byte ring, inline in the entry. For a
framing or CRC fault those bytes are the whole story, and by export time they
would long since have been overwritten.

## Raw serial tail

`src/diagnostics/byteRing.ts` keeps the last **64 KiB** of RX+TX in a
preallocated circular buffer with per-chunk metadata (direction, timestamp,
absolute offset). Chunk boundaries and inter-chunk timing survive, because a
frame split across two reads looks very different from one that arrived whole —
and that difference is usually the bug.

`push()` is one `set()` memcpy plus a few typed-array stores: no allocation, and
a footprint that cannot creep (asserted in tests). Residency uses **absolute**
byte offsets, so a chunk whose front has been overwritten is reported `clipped`
rather than silently corrupt — the classic failure mode for this data structure.

It is pull-based: bytes stay in the worker and only cross Comlink via
`deviceClient.getByteTail()` when a report is actually filed. The export bundle
includes it only when `includeSerialTail` is set.

## E2E

`globalThis.__madLog` is attached in dev (and in prod when the user has opted in
via `mad:log`):

```js
await page.evaluate(() => globalThis.__madLog.snapshot());
globalThis.__madLog.mark('B3 start');   // annotate the timeline
```

`e2e/fixtures.mjs` wraps `browser.close()` to snapshot the log on the way out —
scenarios close their browser in a `finally` that runs before the runner's catch,
so capturing at close time is what makes the log available afterwards without
touching any of the ~40 scenario bodies. On failure `run-all.mjs` writes
`e2e/artifacts/<scenario>.json` (error, URL, browser console, full merged log)
and prints the last 25 entries to stderr. Browser console output is captured
separately, since a failure before boot never reaches the in-page logger.

The runner calls `setCurrentScenario(id)` before each scenario and
`connectToSil` drops a `scenario <id>` marker into the app's timeline at the
first point the page can take one, so a dump shows which scenario produced
which frames.

`e2e/artifacts/` is gitignored.

## Verifying the logging actually works

The unit tests cover the logging *machinery*. They cannot cover the ~64
instrumentation call sites, and the entire worker half — protocol frames,
correlation ids, the byte ring, the worker→main batch transport — only runs
with a device attached. That is exactly the half a bug report depends on.

```bash
npm run dev              # in one terminal
npm run e2e:diagnostics  # in another
```

`e2e/diagnostics-smoke.mjs` injects a **scripted fake serial port** rather than
using SIL, so it needs no emulator or bridge and can drive failure modes an
emulator makes awkward. Two device behaviours:

- **silent** — accepts writes, never replies. Exercises outbound frame logging,
  op bracketing, correlation ids and the timeout path.
- **garbage** — streams deterministic non-frame bytes, which is what a wrong
  baud rate, a noisy cable or a half-flashed board actually looks like.

It asserts what a maintainer needs to be true: worker entries reach the merged
timeline and it is time-ordered; outbound frames are named and sized; ops are
bracketed and their frames carry the op id; an unresponsive device produces
warnings rather than silence; garbage produces an entry carrying a hex byte
tail; and the exported bundle contains build identity, a non-empty log, RX
chunks and worker counters.

This check found three real defects that the unit tests and a manual browser
pass both missed: read requests produced no `tx` entry at all, garbled traffic
produced no log entry whatsoever, and every read frame was labelled with a
*write* command name.

### Command ids are direction-scoped

Reads and writes share the id space — `READ_MACHINE_CONFIGURATION` and
`WRITE_TEST_RUN` are both command `2`, `READ_STATE` and `WRITE_MOTION_ENABLE`
are both `1`. A single id→name map silently mislabels half the traffic, so
`commandName(id, dir)` takes the direction the call site knows. Where direction
genuinely is not knowable — an inbound frame whose id does not match the
in-flight op — it renders `READ_STATE|WRITE_MOTION_ENABLE(1)`. A confidently
wrong name is worse in a bug report than a hedged one.

Note that `isPeriodicCommand` is only consulted for `data` events, which is what
keeps write acks for ids 0 and 1 from being swallowed as periodics.

### Undecodable traffic

The protocol core silently discards bytes that are not valid frames, so a wrong
baud rate used to produce a stream of received bytes and *no* log entry at all —
the app simply looked dead. A watchdog now warns (twice, then stops) when a
2 s window carries bytes but decodes nothing, attaching a hex tail. It compares
*decoded frames*, not events, so the timeouts a garbled link generates cannot
placate it.

## Firmware flashing

Programming runs against the P2 **boot ROM**, not the MaD protocol, so none of
the `proto` instrumentation covers it — and it is the longest, most
failure-prone serial operation in the app. `program.ts` logs the whole run:
reset, each detect attempt with what the ROM actually replied, upload start and
deciles, checksum verification, and on failure **which phase it died in**.
Reset/detect points at wiring or a busy port, upload at the link, verify at
dropped bytes.

`p2loader.ts` stays dependency-free — it is shared with `tools/hw-p2load.mts`,
which drives the identical protocol headlessly — so it emits a typed
`LoaderEvent` and the orchestrator decides what to log.

## Surviving a reload

`src/diagnostics/persist.ts` mirrors the merged timeline into **IndexedDB** as
it is produced. Without it the case people most often report — "it froze so I
restarted it" — destroys the only evidence of what went wrong.

The last **3** sessions are retained, **2000** entries each (the tail, since
after a crash the last entries are the interesting ones). Writes are buffered
and flushed every 5 s plus on `visibilitychange`, which is the last reliable
moment before a tab is discarded. Every IndexedDB call is best-effort: a denied
quota or private mode degrades to "no persistence", never an error.

A bundle attaches the previous session automatically as `previousSession`. Its
`closed: false` means that session never shut down cleanly — itself a strong
signal.

## Triage summary

`src/diagnostics/triage.ts` computes a verdict from the log and puts it at the
top of every bundle, so a maintainer does not have to read 5000 entries to learn
whether the link ever worked. It reports the first error *and* the last (the
first is usually the cause, the last usually a symptom), ranks failure counters,
and raises actionable flags — never connected, connected but silent, undecodable
traffic, WASM trap, render crash, failed flash, main-thread stall, truncated
log. The same text goes into the issue body.

## Reporting a bug

`src/diagnostics/report.ts` turns a session into a filed GitHub issue. There is
no backend and nowhere to hide a token, so the flow is two steps with zero
infrastructure:

0. **Review first.** `buildReportPreview` produces the real bundle and lists
   what it contains and which identifying details it carries (browser and OS,
   the adapter's USB id, data-folder names, raw bytes). This becomes a public
   issue, so a checkbox is not informed consent — the user sees the actual
   contents. `fileBugReport` then publishes *the reviewed bundle*, not a
   freshly-built one, so what ships is what was seen.
1. The bundle downloads locally as `mad-diagnostics-<iso>.json`.
2. A pre-filled issue opens against `RileyMcCarthy/MaD` using the
   `.github/ISSUE_TEMPLATE/app-bug.yml` form, which the user submits under their
   own account with the file attached.

The download happens **first**, so a blocked pop-up never loses the report — the
user still has the file, and the UI shows the issue link as a fallback.

Only a compact summary rides in the URL: build identity, firmware version,
failure-ish counters, and the last five error entries. GitHub rejects very long
URLs, so `buildIssueUrl` enforces a 6 KB budget, trimming derived blocks
(`errors`, `counters`, `environment`) before anything the user typed and
truncating the summary only as a last resort. A long session therefore cannot
silently produce a dead link — asserted in tests.

`fileBugReport` imports `exportBundle` at call time rather than module scope,
because that module reaches the device client, which constructs a `Worker` on
import. Keeping it out of the static graph leaves the URL and field builders
pure and unit-testable.

## One-click filing (optional GitHub token)

`api.github.com` sends `access-control-allow-origin: *` and accepts an
`Authorization` header, so a browser can create gists and issues with **no
backend at all**. What it cannot do is complete an OAuth exchange —
`github.com/login/oauth/*` sends no CORS headers — so the token comes from the
user rather than a sign-in flow.

In Settings → GitHub the user pastes a fine-grained PAT with **Issues: Read and
write** on this repo and **Gists: Read and write**. It is verified against the
real repository before being stored, because a fine-grained token can
authenticate perfectly and still have no access here — a failure that would
otherwise only surface when someone tries to file their first report.

With a token connected, Report a bug uploads the full bundle as a **secret
gist** and files an issue linking it. That removes the manual drag-and-drop
attachment, which is the step where reports otherwise get abandoned. Without a
token the original flow is unchanged: download the bundle, open a pre-filled
issue, attach it by hand.

If the gist upload fails (no gist scope), the issue is still filed with the
triage summary — a report without the full log beats no report.

### Keeping the token out of the log

The token is a credential in `localStorage`, and a bundle ends up in a **public**
issue, so a leak would be published. `redactCredentials` in `log.ts` scrubs
anything token-shaped (`ghp_*`, `github_pat_*`, `Bearer …`) from **both** the
`msg` field and every sanitized `data` value — the one choke point every entry
passes through. `GitHubError` scrubs its own message too, since a GitHub error
body can echo the request that carried the token.

Tests assert the token cannot reach a snapshot via a message, via data, or via
the sanitizer directly. Writing them found that `msg` was originally bypassing
redaction entirely.

The token is never included in a diagnostics bundle and is sent nowhere but
`api.github.com`. It is stored per-browser; the UI says so, and says to revoke it
from GitHub when abandoning a machine.

## Reading a bundle

```bash
node tools/view-diagnostics.mjs report.json            # summary + timeline
node tools/view-diagnostics.mjs report.json --bytes    # annotated hex dump
node tools/view-diagnostics.mjs report.json --level warn --cat proto,flash
node tools/view-diagnostics.mjs report.json --previous # the pre-reload session
```

The bundle is built to be complete, not readable. The viewer renders the triage
summary, a filterable merged timeline, and — the part that is otherwise
unusable — a hex dump of the serial window with **inter-chunk timing**, because
a frame split across two reads with a pause between them looks nothing like one
that arrived whole.

## Build identity

`vite.config.ts` defines `__APP_VERSION__` (from `package.json`) and
`__GIT_SHA__`, logged once at boot so every report names the exact build. A
checkout without git metadata yields `unknown` rather than failing the build.
