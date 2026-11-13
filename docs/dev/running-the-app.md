# Running the app

The control app is in `Software/Control/` — Vite + React + TypeScript, with
the protocol core compiled to WebAssembly from Rust.

## Setup

> Needs the `Protocol/ProtoEmb` submodule (wasm core + codec generation):
> `git submodule update --init --recursive` after a plain clone.

```bash
cd Software/Control
npm install
npm run build:wasm       # compile the Rust protocol core → src/wasm/
npm run generate:proto   # generate the TS codec → src/protocol/generated/
```

!!! note "Build artifacts are git-ignored"
    `src/wasm/` and `src/protocol/generated/` are not committed. Run `build:wasm`
    and `generate:proto` after cloning, and again whenever the protocol schema or
    the Rust core changes.

## Dev scripts

| Command | What it does |
|---|---|
| `npm run dev` | Vite dev server on <http://localhost:5174> (no browser opened) |
| `npm run app` | Dev server **and** opens your real browser (real Web Serial → real hardware) |
| `npm run build` | Typecheck + production PWA bundle → `dist/` |
| `npm run lint` | ESLint (flat config) |
| `npm test` | Vitest unit tests (codec, domain, diagnostics) |
| `npm run verify` | `tsc` + eslint + tests + build — the **offline CI gate** |

## Connecting to hardware vs. the emulator

The app only ever uses the **real Web Serial API**. There are two ways to drive
it interactively:

- **`npm run app`** — opens the app in *your* browser, so the connect flow shows
  Chrome's native port chooser and connects to **real hardware**.
- **`cd SIL && make playground`** — boots the simulated board and opens the app
  in a headed Chrome held to the **board's clock** (no hardware); see
  [SIL testing](sil-testing.md). A browser on the host's clock is not a SIL
  configuration, which is why the older `npm run sil:app` script (a fake
  `navigator.serial` over a bridge) has no valid backend any more.

Test-only fakes live in the test harness (`e2e/`) — they are **never** baked
into `src/`, which keeps the app pure (Web Serial + File System Access only).

## Regenerating documentation screenshots

The screenshots in this site are captured from the real UI with no machine and
no emulator:

```bash
cd Software/Control
npm run docs:screenshots   # → docs/assets/screenshots/*.png
```

The script (`e2e/capture-screenshots.mjs`) starts its own dev server, puts the
store into each state the docs describe (every firmware banner, fault and
restriction), and feeds the live buffer from a small in-page carriage model so
the charts and both calibration panels run their real code. It rewrites the
whole folder; `SHOT_ONLY=<regex>` re-takes only matching names. Run it after
any UI change and commit the images with the change.

The shots show what the app looks like in a state. They are not evidence that
the firmware produces it; that is the e2e suite's job.
