# MaDControl — legacy Electron app (frozen)

> **This app is no longer the shipped product.** The control app is now
> **[`Software/Control/`](../Control/)** — a frontend-only browser PWA
> (Web Serial + WebAssembly) that has reached full parity and is the documented,
> deployed application: <https://rileymccarthy.github.io/MaD/app/>.

This Electron + React + TypeScript desktop app is **frozen**: no new features land
here. It is retained for one reason only —

**It is still the driver for the SIL Playwright E2E suite** (`SIL/tests/*.spec.ts`,
run via `playwright test --project=electron`). `SIL/tests/global-setup.ts` rebuilds
this app before tests, and CI's `build-software` job (which `sil-tests` depends on)
packages it.

## Do not develop new functionality here

- New UI/feature work goes in **`Software/Control/`**.
- Touch this package **only** to keep the SIL Playwright E2E suite green while it
  still targets Electron.

## Decommissioning this app

Deleting `Software/MaDControl/` is a coupled migration, not a simple removal. The
remaining steps:

1. **Port the E2E suite** in `SIL/tests/*.spec.ts` from the Electron `--project=electron`
   target to the WASM app's harness (`Software/Control/e2e/`), then rewire
   `SIL/tests/fixtures.ts`, `SIL/tests/global-setup.ts`, `SIL/makefile`, and
   `SIL/package.json` (which `cd`s here to `npm run build`).
2. **Rewire CI** (`.github/workflows/ci.yml`): drop the Electron packaging from
   `build-software`, re-point or retire the `sil-tests` job, and remove
   `release-software` (Electron DMG/exe/deb on `software-v*` tags) — the shipped
   app deploys via the `webapp-v*` / Pages flow.
3. **Then** delete this directory and the remaining `MaDControl` references.

## Building (legacy)

```bash
npm install        # postinstall: check-native-dep, electron-builder install-app-deps, build:dll
npm start          # Dev mode with hot reload
npm run package    # Production build → release/build/
npm run lint:fix   # ESLint auto-fix
npm test           # Jest unit tests
```
