# Reliability & scalability hardening (2026-06-13)

A focused pass that kept the (already sound) core architecture and hardened the
edges: machine safety, failure recovery, data integrity, performance, and CI.
All offline gates green throughout: `cargo test` (framing 17 · runtime 29) and
`npm run verify` (tsc + eslint + **44** vitest + production build).

The architecture itself was assessed as well-built and was **not** redesigned:
transferred byte streams → worker-owned WASM protocol core → out-of-React
Float64Array ring → uPlot, Comlink bridge, atomic Zustand selectors.

## Safety model — the machine is self-protecting

The machine is guarded by its own **hardware e-stop and sensors**, and runs tests
**autonomously from its SD card**. The web UI is a monitor/controller, not a
safety device: **losing or closing the UI is an intentional non-event** — the
test keeps running and the UI simply reconnects to monitor it. The UI therefore
does **not** stop the machine, nag, or fail a run when it loses the link.

What the UI *does* provide are correctness/convenience controls:
- **Convenience STOP** in the app shell (a global "disable motion", available on
  every screen and surviving a crashed screen). Calls `setMotionEnabled(false)`;
  user-initiated only — it never fires on its own. This is a UI convenience, not
  the safety stop (the hardware e-stop is).
- **Queue-preempting `emergencyStop()`**: when the user does hit STOP, it clears
  the WASM send queue + aborts upload/download loops so the command isn't stuck
  behind a multi-batch upload.
- **Move encoding validation** (`validateMove`): rejects X/F/P outside the
  encodable range (the packed codec silently bit-wraps otherwise — an over-range
  X flipped to the opposite physical extreme) and rejects unknown G-codes (which
  otherwise coerced to a rapid move). Applied to test uploads *and* manual jogs.
  This is a *correctness* guard on the bytes we send, independent of machine
  safety.
- **Limit/UX**: jog/Home/Zero disabled during a test; NaN/zero jog inputs
  rejected with feedback; rejected manual moves surfaced as a toast.
- **Arc moves**: gauge length is no longer added to G2/G3 targets (firmware
  executes arcs as a dwell). Arcs remain accepted (matches the e2e contract).

No `beforeunload`/`pagehide` interference, no disconnect-marks-run-error, no
reconnect alarm — a dropped UI link keeps the run `running` and reconnect resumes
monitoring (the operator resolves a missed completion via History if needed).

## Failure recovery & robustness
- **Poisoned-WASM / worker-crash recovery**: a throw out of `poll()` (Rust panic
  → trapped instance) is now fatal — it tears down and surfaces a disconnect +
  Reconnect. Each `connect()` spins up a **fresh worker** (pristine WASM
  instance), so a panic can't carry over. `worker.onerror`/`onmessageerror` are
  handled on the main thread.
- **Teardown hardening**: snapshot+null handles before awaiting, releaseLock the
  writer, bounded close timeout, reset the write chain. A failed write now tears
  down (mirrors the read path) instead of spinning against a dead writer.
- **React error boundaries** (top-level + per-screen) + global
  `error`/`unhandledrejection` handlers → throttled toast. A render throw can no
  longer blank the app (and the STOP control).
- **Single-in-flight JS op mutex** + Rust-timeout↔waiter command correlation:
  removes response cross-matching and makes JS/Rust timeouts agree.
- **Bounded mid-download retry**: a transient SD-BUSY NACK mid-stream is retried
  instead of discarding the whole download.
- **Partial-upload invalidation**: a failed test upload re-opens (truncates) the
  SD g-code file so a half-written program can't later run to EOF and report a
  false "complete". TEST_RUN payload now built via the generated `encodeTestRun`.

## Data integrity (File System Access)
- All mutating `DataStore` ops are **serialized through one async mutex** so a
  read-modify-write of `index.json` can't interleave and drop an update.
- `index.json` treated as a **rebuildable cache**: `rebuildIndex()` regenerates
  it from the per-run files; auto-invoked when missing/empty-but-files-exist and
  via a **Rescan folder** button in Settings.
- **Folder-scoped test counter**: the next test name is `max(origin counter,
  highest existing numeric name in the folder) + 1`, so switching folders / a
  cleared profile can't silently overwrite real results.
- `navigator.storage.persist()` requested on folder choose; surfaced storage
  errors (download save failures, grant rejections); corrupt-JSON logged.

## Performance & scalability
- **O(1) live ring buffer** (head/tail), replacing the per-sample
  `copyWithin` shift (~28 MB/s memmove on the main thread at 100 Hz).
- **Idle-redraw gating** on both live charts (no canvas work when no new data);
  stress-strain gauge captured via ref (no stale first-sample strain).
- **WASM marshalling**: `Event` byte payloads + `get_stored` entries returned as
  `Uint8Array` (`serde_bytes`) instead of boxed `number[]`; empty polls skip the
  serde marshal entirely.
- **Drain rx fully per poll** + a 256 KiB rx cap in the WASM transport.
- **Route code-splitting**: initial bundle 359 KB → **268 KB** (gzip 119→86 KB).

## Observability
- **Diagnostics flight recorder** (significant events + worker throughput
  counters) with a one-click **Download diagnostics** bundle (About page). Store
  now handles `error`/`timeout`/`nack` events; hidden production source maps.

## PWA
- `registerType: 'prompt'` (+ `skipWaiting/clientsClaim: false`) and a manual,
  deferred update flow: a new version is announced and only applied when **idle
  and disconnected** — never a silent reload mid-test.

## Tooling / CI
- **ESLint flat config** (typescript-eslint + react-hooks), wired into
  `npm run verify`; dead `lint` script fixed; stale disable directives removed.
- **CI job** `wasm-control-ci` (cargo test → build wasm → generate proto →
  verify), gated on `Software/MaDWasmControl/**` + `Protocol/**`.
- `.nvmrc`, `engines.node>=20`, repo `dependabot.yml` (npm + cargo + actions).
- `noImplicitOverride` enabled.

## Tests added
- FrameParser **fuzz** (no-panic / bounded / resync) + all-frame round-trip.
- Self-contained **golden codec byte vectors** (re-enables Move + StoredSample;
  no longer imports the git-ignored sibling desktop codec → CI-safe).
- Native **Client parse→event contract** test (the path the WASM exposes).
- `gcode` validation, `liveBuffer` wraparound, diagnostics recorder tests.

## Deliberately deferred (with rationale)
- **Firmware host-link watchdog — NOT wanted.** Earlier framing called link-loss
  a safety gap; it isn't. The machine has a hardware e-stop + its own sensors and
  runs tests autonomously, so a UI/host that drops out is by design harmless.
  The UI must *not* halt the machine on its own — keep everything running.
- `noUncheckedIndexedAccess` / `exactOptionalPropertyTypes` — ~79 errors, most in
  **generated** code; needs a codegen-template change + cross-project
  regeneration. Tracked, not hand-patched.
- **Worker unit-test injectability** refactor + **CI-runnable e2e orchestration**
  (needs the SIL+firmware toolchain in CI) — larger DX work; the offline gate +
  existing manual e2e cover the path meanwhile.

> Build-cache note: `SIL/target` (a regenerable cargo cache) was removed to free
> a full disk during this work — it rebuilds on the next `make emulator`.
