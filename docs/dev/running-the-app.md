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
- **`npm run sil:app`** — launches a Playwright-controlled Chrome with a *fake*
  `navigator.serial` wired to the **SIL emulator** (no hardware). This is the only
  way to drive the emulator from the browser; see [SIL testing](sil-testing.md).

The fake serial is injected by the test harness (`e2e/`) — it is **never** baked
into `src/`, which keeps the app pure (Web Serial + File System Access only).

## Regenerating documentation screenshots

The screenshots in this site are captured from the live app against the SIL
emulator. With the SIL stack running (emulator + bridge + dev server, see
[SIL testing](sil-testing.md)):

```bash
cd Software/Control
npm run docs:screenshots   # → docs/assets/screenshots/*.png
```

This reuses the e2e fixtures to seed realistic profiles/runs, walk each screen,
and write a PNG per screen + key modal.
