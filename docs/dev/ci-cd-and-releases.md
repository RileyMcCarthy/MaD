# CI/CD & releases

GitHub Actions builds, tests, and releases every part of MaD. There are two
workflows: `ci.yml` (build/test) and `pages.yml` (deploy the docs + app).

## CI (`.github/workflows/ci.yml`)

A `changes` gate job detects which areas a push/PR touched and runs only the
relevant jobs:

| Job | Runs when | What it does |
|---|---|---|
| `wasm-control-ci` | app or protocol changed | `cargo test` the runtime, build WASM, generate the protocol, then `npm run verify` (typecheck + lint + tests + build) — fully offline |
| `build-software` | software/firmware changed, or a software tag | Builds the desktop app for macOS/Windows/Linux |
| `build-firmware` | firmware/software changed, or a firmware tag | Builds `propeller2_debug`, `propeller2` release, and the native (SIL) binary |
| `build-hardware` | hardware changed, or a hardware tag | KiBot → Gerbers, BOM, interactive BOM, 3D models for each board |
| `sil-tests` | software or firmware changed (not a release tag) | Downloads the built artifacts, starts the emulator, and runs the Playwright integration suite |
| `release-*` | a `*-v*` tag | Publishes a GitHub Release with the built artifacts |

## Pages deploy (`.github/workflows/pages.yml`)

One workflow publishes **both** this documentation site and the control app to
GitHub Pages as a single deployment:

```text
https://rileymccarthy.github.io/MaD/        → documentation (this site)
https://rileymccarthy.github.io/MaD/app/    → the control app (MaDWasmControl)
```

The job builds the app with Vite (base path `/<repo>/app/`), builds the docs with
MkDocs, copies the app into `site/app/`, and uploads the merged `site/` as the
Pages artifact. It triggers on:

- **push to `main`** (when `docs/**`, `mkdocs.yml`, `Software/MaDWasmControl/**`,
  or `Protocol/**` change),
- **`workflow_dispatch`** (manual deploy of any branch), and
- **`webapp-v*` tags**.

!!! note "One-time setup"
    In the repo, set **Settings → Pages → Source = GitHub Actions** so the
    workflow can publish.

## Releases

Releases are cut by pushing a version tag:

```bash
git tag software-v1.0.0 && git push --tags   # desktop app release
git tag firmware-v1.0.0 && git push --tags   # firmware binaries release
git tag hardware-v1.0.0 && git push --tags   # hardware manufacturing files
git tag webapp-v1.0.0   && git push --tags   # deploy docs + app to Pages
```

## Running the gates locally

You can reproduce the most important gates before pushing:

```bash
# Web app offline gate
cd Software/MaDWasmControl && npm run verify

# Full SIL integration
cd SIL && make test

# Firmware static analysis + unit tests
cd Firmware/MaDCore && pio check && pio test -e native_test

# Protocol cross-language conformance
cd Protocol/ProtoEmb && ./examples/verify.sh

# Docs build (link check)
pip install -r docs/requirements.txt && mkdocs build --strict
```
