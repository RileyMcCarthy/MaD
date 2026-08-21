# Diagnostics & user issue reporting — design

Goal: when a user hits a bug, they press one button and I get enough to root-cause
it without owning their machine — **including the bytes on the wire**. Frontend-only
constraint holds throughout: no backend, no secrets, GitHub Pages deploy.

## Why the current bundle isn't enough

`src/diagnostics/` today produces a snapshot of *state at export time*: UA, build
mode, capability flags, connection/firmware/port, worker counters, and a 1000-entry
ring of five event tags (`connected`, `disconnected`, `device-error`, `timeout`,
`nack`) recorded from `useStore.ts:301-334`.

That answers "what state was the app in." It cannot answer:

- What bytes did the device actually send before the decode failed?
- What did the user do in the minute before it broke?
- Was the sample stream dropping, and by how much?
- What threw, and from where?
- Anything at all, if the page was reloaded after the freeze.

Everything below is additive — the existing recorder becomes one source among many.

## Architecture

High-volume data (raw bytes, frames) **stays in the worker** and is pulled on demand
at export/incident time. Low-volume data (breadcrumbs, errors) streams to the main
thread on a 250 ms batch so there is one merged timeline. Nothing high-rate crosses
the Comlink boundary continuously.

```
worker thread                          main thread
  byteRing (256 KB, RX+TX) ──pull──▶
  frameLog (ring, decoded)  ──pull──▶   bundle assembly ──▶ gzip ──▶ download
  workerLog ───batch 250ms──────────▶   log (merged, monotonic)
                                            ▲
                                            ├── UI breadcrumbs (store actions)
                                            ├── error capture (window/EB/console)
                                            ├── health metrics
                                            └── storage events
                                            │
                                            └──▶ IndexedDB (crash-survivable)
```

Timestamps: both threads record `performance.now()` plus a single shared epoch
anchor captured at worker construction, so cross-thread ordering is real. Store
`t` as ms-since-anchor (a small number) and resolve to wall clock only at export.

---

## Layer 1 — capture

### A. Raw serial byte tail — the highest-value item

A preallocated circular `Uint8Array` in the worker holding the last ~60 s of traffic
in both directions. This is what makes framing, CRC, baud, and partial-frame bugs
diagnosable, which is the failure class real hardware actually produces.

**New file: `src/diagnostics/byteRing.ts`**

- `Uint8Array(256 * 1024)` + write head + wrapped flag.
- Parallel chunk-metadata ring (~8192 entries): `{ at, dir: 'rx' | 'tx', start, len }`
  so chunk boundaries and inter-chunk timing survive, not just a flat byte soup.
- `push(dir, bytes)` is one `set()` memcpy + one metadata write. No allocation, no
  GC pressure. Negligible next to the copy `feed_bytes()` already does.
- `snapshot()` walks metadata oldest→newest and emits per-chunk **base64**
  (base64 is 4/3 vs hex's 2× — matters before gzip, and a decode tool renders it).

**Hook points (2 lines each):**

| Where | Existing line | Add |
| --- | --- | --- |
| `DeviceSession.worker.ts:805` | `this.stats.bytesIn += value.length` | `byteRing.push('rx', value)` |
| `DeviceSession.worker.ts:641` | `this.stats.bytesOut += out.length` | `byteRing.push('tx', out)` |

Budget: 256 KB ring + ~320 KB metadata ≈ 600 KB resident. Cap is a constant.

### B. Frame log

Decoded frames with direction, command id + name, byte length, and — for non-sample
frames — the decoded payload. Ring of ~2000 entries in the worker.

The 100 Hz `MSG_READ_SAMPLE` / `MSG_READ_STATE` periodics are **counted and
aggregated, not logged individually**; otherwise they'd evict everything interesting
within seconds. A verbose toggle (below) turns on per-sample logging when chasing a
specific sampling bug.

Hook: `DeviceSession.worker.ts:615-637`, the loop that already walks polled events
and bumps `this.stats`.

### C. UI breadcrumbs

Reconstructs what the user actually did. Instrument at the **store-action layer**
(`src/store/useStore.ts`), not per component — the action list is already the
complete set of user-initiated device operations:

`connect` (381), `disconnect` (408), `reconnect` (422), `chooseDataFolder` (441),
`grantDataFolder` (450), `saveConfig` (468), `saveSampleProfile` (483),
`setMotionEnabled` (491), `emergencyStop` (492), `manualMove` (508), `homeAxis` (509),
`zeroForce` (510), `zeroLength` (511), plus test start/stop and profile load.

Plus route changes, from a small `useEffect` on `useLocation()` in `App.tsx`'s
`Shell`. Log the action name and its scalar arguments (jog mm/speed, config field
names) — never file contents.

### D. Error capture

Three sites already exist and currently dead-end at `console.error`:

- `App.tsx:21-45` — `window.error` + `unhandledrejection`. The `report()` closure
  already throttles and filters; add a `log()` call beside the existing
  `console.error` + `notify`.
- `ui/ErrorBoundary.tsx:37` — `componentDidCatch` already has an `onError` prop and
  the component stack in hand. Pass a logging callback at both boundary sites in
  `App.tsx`.
- `device/session.ts` — `workerCrashEvents()` already models worker death; log it.

Add: `console.error`/`console.warn` interception (wrap once at boot, forward to the
real console), and WASM panic capture in the worker's existing `catch` at
`DeviceSession.worker.ts:604`.

### E. Health metrics

Sampled ~1 Hz into the log, so degradation shows as a trend rather than a single
number at export time:

- Observed sample rate vs the profile's expected rate; sample sequence gaps.
- `poll()` loop duration and tick overrun (the `TICK_MS` interval).
- Write-chain depth (`writeChain` backlog), waiter count.
- RX bytes/s, high-water chunk size.
- Main-thread jank: long-task or rAF delta p95.
- `performance.memory.usedJSHeapSize` where available (Chromium-only app, so it is).

### F. Storage events

`src/storage/DataStore.ts` — log directory chosen/restored, permission grant/deny,
and each write as **name + byte count only**. Never contents. Wrap at the ~20 public
async methods, or a single private helper they already funnel through.

---

## Layer 2 — the unified log

**New file: `src/diagnostics/log.ts`** — replaces `recorder.ts`.

```ts
type LogEntry = {
  t: number;                    // ms since epoch anchor
  level: 'debug' | 'info' | 'warn' | 'error';
  cat: 'device' | 'proto' | 'ui' | 'store' | 'fs' | 'perf' | 'app';
  tag: string;                  // short, groupable: 'connect', 'nack', 'jog'
  msg?: string;
  data?: Record<string, unknown>;  // scalars only
};
```

Ring of ~5000, plus per-`tag` counters (keep the existing counter behaviour — it's
genuinely useful for "how many nacks this session"). Subscriber list so the live
viewer can tail it without polling.

Two instances — one per thread. The worker's flushes over a new
`onLogBatch` Comlink proxy (mirroring the existing `setEventSink` pattern at
`DeviceSession.worker.ts:167`) every 250 ms or 100 entries, whichever first.

## Layer 3 — persistence

A freeze-then-reload currently destroys all evidence, which is exactly the case you
most want. Append batched entries to **IndexedDB** (one store keyed by session id,
retain the last 3 sessions, trim by age + count). Flush on `visibilitychange`.

Note on the `src/` purity rule: this adds IndexedDB to the app's browser-API surface
alongside Web Serial + File System Access. It is real app functionality, not a test
fake, so the "fakes live in `e2e/`, never `src/`" rule is unaffected — but
`CLAUDE.md`'s architecture section should be updated to name it.

## Layer 4 — incidents

A two-hour session evicts the interesting 30 seconds long before the user gets
around to reporting. So: on `error` / `timeout` / `nack` / machine fault, freeze a
copy of the preceding window — byte-ring snapshot, frame log tail, last ~200 log
entries, current state — into an incident record. Cap at ~5 incidents (keep first 2
and most recent 3; the *first* failure is usually the informative one).

The freeze must happen **in the worker** for byte data, synchronously at detection.
The main thread pulls incidents at export time.

## Layer 5 — the viewer

New route `/diagnostics` (`src/ui/screens/Diagnostics.tsx`), registered in
`App.tsx:206-219` and code-split like the other non-landing screens. About keeps a
one-line link and otherwise goes back to being About.

- Live tail with filters by level/category/tag; pause-on-scroll.
- Incident list, expandable to the frozen window with an annotated hex dump.
- Counter table (nacks, timeouts, errors, bytes, uptime).
- Verbosity toggle (`normal` / `verbose incl. per-sample frames`), persisted in
  `localStorage`, surfaced in Settings too.
- **"Report a problem"** button.

## Layer 6 — the report flow

Constraint: static PWA, nowhere to hide a token. So the flow is prefill + attach.

**New file: `.github/ISSUE_TEMPLATE/app-bug.yml`** (repo has no templates yet) — an
issue form with `id`s matching the prefill params: `summary`, `steps`, `app-version`,
`fw-version`, `browser`, `counters`, plus a checkbox acknowledging the attachment.

**New file: `src/diagnostics/report.ts`**

1. User writes a short description + optional repro steps in a modal.
2. Bundle is built, gzipped via `CompressionStream('gzip')`, downloaded as
   `mad-diagnostics-<iso>.json.gz` (tens of KB with a full 60 s byte tail).
3. Open `https://github.com/RileyMcCarthy/MaD/issues/new` with
   `template=app-bug.yml&labels=bug,app&title=...` and the small scalar fields
   prefilled. **Keep the URL under ~6 KB** — GitHub rejects much beyond 8 KB, so only
   the summary goes in the URL; the log rides as the attachment. Assert this in a
   unit test.
4. The form body's final field tells them to drag the just-downloaded file in.
5. Clipboard copy of the summary as an always-available fallback (and the only path
   if they have no GitHub account).

**New file: `tools/decode-diagnostics.mjs`** — CLI that takes the `.json.gz`,
pretty-prints the merged timeline, and renders the byte ring as an annotated hex
dump with inter-chunk deltas. This is what makes the base64 choice fine.

Version stamping: `vite.config.ts` has no `define` block today. Add
`__APP_VERSION__` (from `package.json`, currently `0.1.0`) and `__GIT_SHA__` so a
report identifies an exact build. Declare both in `src/vite-env.d.ts`.

---

## Privacy & redaction

The bundle goes into a **public** GitHub issue, so the preview screen matters as much
as the capture does. Show exactly what will be sent, with toggles.

- Never: file contents, directory paths (basename only), clipboard, credentials.
- Default off: raw byte ring (it's the most useful and the most opaque — make the
  choice explicit rather than silent).
- **Reversal of the current promise:** today's blurb advertises "no sample data."
  For a debugging tool that's backwards — chasing a force-gauge glitch, the sample
  values *are* the evidence. Make it an opt-in toggle ("include last 60 s of
  samples", sourced from `liveBuffer`) shown in the preview.

## Performance budget

Non-negotiable: the ~100 Hz path must not regret this.

- Byte ring: one memcpy + one metadata write per chunk. No allocation.
- No per-sample log entries at default verbosity — counters only.
- Nothing high-rate crosses Comlink; bytes are pulled on demand.
- Log batching is time-sliced (250 ms), never per-event.
- IndexedDB writes are batched and off the critical path.
- Fixed memory ceiling: ~600 KB byte ring + ~1 MB logs. Assert in a test.

---

## Work plan

**P1 — capture foundation**
- New `src/diagnostics/log.ts` (replaces `recorder.ts`), `byteRing.ts`, `frameLog.ts`,
  `persist.ts` (IndexedDB), `anchor.ts` (shared epoch).
- Worker: byte-ring + frame-log hooks (`:641`, `:805`, `:615-637`), `onLogBatch`
  Comlink channel, batch flush timer.
- Main: merged log, migrate the 5 `record()` calls in `useStore.ts:301-334`.
- Tests: ring wrap, cross-thread ordering, memory ceiling, IDB retention.

**P2 — sources**
- Breadcrumbs across the store actions; route logging in `Shell`.
- Error capture: `App.tsx:21-45`, `ErrorBoundary` `onError`, console interception,
  worker crash + WASM panic.
- Health metrics sampler; `DataStore` events.

**P3 — incidents + viewer**
- Worker-side incident freeze; pull API.
- `/diagnostics` screen + route; Settings verbosity toggle; About trimmed to a link.
- Update `e2e/capture-screenshots.mjs:292` (the comment and shot still assume the
  export button lives on About).

**P4 — report flow**
- `report.ts`, the modal + preview with redaction toggles.
- `.github/ISSUE_TEMPLATE/app-bug.yml`.
- `vite.config.ts` version/SHA define + `vite-env.d.ts` types.
- `tools/decode-diagnostics.mjs`.
- README/user-guide: how to file a report.

**Testing**
- Vitest: ring wrap + eviction, redaction (assert no contents/paths leak), bundle
  assembly, gzip round-trip, GitHub URL builder length cap, incident retention policy.
- E2E against SIL: force a protocol error, export, assert the bundle contains the
  offending frames and a non-empty byte tail.
- `npm run verify` green throughout.

## Open questions

1. **Byte-ring default** — 60 s is a guess. If the bugs you're chasing are slow-burn
   (drift over a long run) the tail wants to be sparse-but-long instead: keep full
   fidelity for the last 10 s and 1-in-N sampling before that.
2. **Sample inclusion** — opt-in toggle, or always include a decimated version
   (say 1 Hz) since it's cheap and often the first thing you'd ask for?
3. **Serverless intake** — deferred, not rejected. If the drag-and-drop step proves
   to be where reports die, a Cloudflare Worker holding the token is the upgrade;
   the bundle format wouldn't change.
