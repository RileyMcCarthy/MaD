# Control

Frontend-only control app for the MaD tensile tester. The browser talks straight to the Propeller 2 over the **Web Serial API**, and the
protocol logic runs as **WebAssembly** compiled from the same Rust core
(`Protocol/ProtoEmb/runtime`) used by the firmware tooling and SIL.

> **Chromium only.** Web Serial + the File System Access API are available only in
> Chrome/Edge on desktop. The app shows an "unsupported browser" screen elsewhere.

## Architecture

```
React UI (Vite) ── Zustand store ── Comlink ─┐
   uPlot live charts                          │  (transferred byte streams)
navigator.serial.requestPort()/open() ────────┤
                                              ▼
                              Web Worker: DeviceSession
                                ├─ reads port.readable → wasm.feed_bytes()
                                ├─ wasm.poll() → decode → events → store
                                └─ wasm.take_outgoing() → port.writable
                              protoemb-wasm (framing + queue + storage + client)

Persistence: File System Access API (mirrors the desktop data-folder layout)
```

The serial read loop and all protocol work run in a dedicated **Web Worker**, so
the ~100 Hz sample stream never blocks rendering. The port is opened on the main
thread (a user gesture is required) and its readable/writable streams are
transferred to the worker.

- `src/protocol/generated/` — generated TypeScript codec (browser-safe `Uint8Array`/`DataView`)
- `src/wasm/` — `wasm-pack` output of the Rust protocol client
- `src/domain/` — pure logic (G-code build/transform, sample→CSV, proto↔display mapping)
- `src/device/` — `DeviceSession.worker.ts` (worker) + `session.ts` (main-thread client)
- `src/storage/` — `DataStore` over the File System Access API
- `src/store/` — Zustand store + out-of-React `liveBuffer`
- `src/ui/` — screens + uPlot live charts

## Prerequisites

- Node 20+ and npm
- Rust + `wasm-pack` + the `wasm32-unknown-unknown` target (for `build:wasm`)
- Python 3 (for `generate:proto`)

## Build & run

```bash
npm install
npm run build:wasm       # compile the Rust protocol core → src/wasm/
npm run generate:proto   # regenerate src/protocol/generated/ from the YAML schema
npm run dev              # dev server only, on http://localhost:5174
npm run app              # dev server + open your real browser (proper Web Serial → real hardware)
npm run build            # typecheck + production PWA bundle → dist/
npm run lint             # ESLint (flat config)
npm test                 # codec + domain + diagnostics unit tests
npm run verify           # tsc + eslint + tests + build (the offline CI gate)
```

## Reliability features

The machine is the safety authority — it has a **hardware e-stop and its own
sensors** and runs tests **autonomously from its SD card**. This app is a
monitor/controller, so **closing or losing the UI is a non-event**: the test
keeps running and the UI reconnects to monitor it. The UI never halts the machine
on its own.

Robustness/convenience features (see [docs/HARDENING.md](./docs/HARDENING.md)): a
global **disable-motion** control in the status bar (a convenience, user-initiated
only — not the safety stop), move-range/G-code validation before any motion
command (a correctness guard on the wire bytes), React error boundaries +
automatic recovery from a crashed worker/WASM instance, a deferred PWA update
flow (no surprise reload mid-session), serialized + rebuildable file-storage, and
a one-click **diagnostics export** on the Firmware/About page.

### Real hardware vs. the SIL emulator

The app only ever uses the **real Web Serial API** — the fake serial used by tests
and the emulator playground is injected by the harness (`e2e/`), never baked into
`src/`. Two ways to run interactively:

- **`npm run app`** — opens the app in *your own* browser, so `requestPort()` shows
  Chrome's native port chooser and connects to **real hardware** (the genuine Web
  Serial flow, with permissions that persist in your profile).
- **`npm run sil:app`** — launches a Playwright-controlled Chrome with a *fake*
  `navigator.serial` wired to the **SIL emulator** (no hardware needed). This is the
  only way to drive the emulator from the browser — Chrome won't list the emulator's
  pseudo-terminal in the real chooser, and an automation-controlled Chrome cancels
  the chooser anyway. See `docs/TEST_PLAN.md` for the full SIL stack.

`src/wasm/` and `src/protocol/generated/` are git-ignored build artifacts; run
`build:wasm` and `generate:proto` after cloning (and whenever the protocol schema
or Rust core changes). Both need the `Protocol/ProtoEmb` submodule — after a
plain clone run `git submodule update --init --recursive` first.

## Deploying (GitHub Pages)

The app is published to GitHub Pages by `.github/workflows/pages.yml`, which
builds the wasm + protocol bindings, runs `vite build` with the project base
path (`/<repo>/app/`), and deploys `dist/` under `/app/`. HashRouter keeps
client routing working without server rewrites; Web Serial + File System Access
work because Pages is served over HTTPS.

**MaD Control version is `package.json` `version`.** Do not `git tag` by hand
(`webapp-v*` is retired). The tag `madcontrol-vX.Y.Z` must match that version
on the tagged commit — CI rejects a mismatch, which is what used to ship
`0.1.0` on the About page while the tag said otherwise.

```bash
# from repo root, after main is up to date
git checkout -b release/madcontrol origin/main
Software/Control/scripts/release.sh patch --no-tag    # or minor | major | x.y.z
git push -u origin HEAD
# open PR → CI Gate → merge
Software/Control/scripts/release.sh --publish         # tags origin/main as madcontrol-vX.Y.Z
```

That tag publishes a GitHub Release named **MaD Control X.Y.Z**. Pages already
deployed from the merge to `main` (the `github-pages` environment only allows
that branch). The live app is `https://rileymccarthy.github.io/MaD/app/`. A
manual deploy of any branch is also available via the workflow's **Run
workflow** button (`workflow_dispatch`). One-time setup: repo **Settings →
Pages → Source = GitHub Actions**.

## Firmware flashing

The **Firmware** page programs the Propeller 2 over Web Serial — no native
`loadp2` needed. It resets the chip with DTR and drives the boot ROM's serial
loader directly, either into RAM (temporary) or through a flash stub (permanent).
Requires the Debug/Programming header J1 and an adapter that wires DTR to `RESn`.
See [docs/FLASHING.md](docs/FLASHING.md) for the protocol, hardware requirements,
and the CLI harness (`npm run hw:flash`) used to validate it against a board.

## Not included

- Non-Chromium browsers.
