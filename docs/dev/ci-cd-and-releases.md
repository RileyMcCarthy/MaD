# CI/CD & releases

GitHub Actions builds, tests, and releases every part of MaD. There are three
workflows: `ci.yml` (build/test), `pages.yml` (deploy the docs + app), and
`ai-review.yml` (a comprehensive advisory AI review on every PR).

## CI (`.github/workflows/ci.yml`)

A `changes` gate job detects which areas a push/PR touched and runs only the
relevant jobs:

| Job | Runs when | What it does |
|---|---|---|
| `wasm-control-ci` | app or protocol changed | `cargo test` the runtime, build WASM, generate the protocol, then `npm run verify` (typecheck + lint + tests + build) — fully offline |
| `protoemb-ci` | protocol changed | Generator unit tests + cross-language (C == Rust == TS) wire conformance + framing/runtime crate tests |
| `firmware-unit-tests` | firmware or protocol changed | `pio test -e native_test` — the host Unity suite under AddressSanitizer (no Propeller toolchain needed) |
| `protocol-codegen` | protocol changed | **Blocking.** Regenerates all three targets (C/TS/Rust) twice and asserts success + byte-reproducibility (generated files are gitignored, so this guards the schema/templates + generator determinism, not committed-file drift) |
| `firmware-layering` | firmware changed | **Blocking (baseline-gated).** `scripts/check_layering.py` enforces downward-only includes (APP→DEV→IO→Library→HAL→HW); pre-existing violations are frozen in `.layering-baseline`, so it fails only on **new** upward includes |
| `python-lint` | protocol or firmware changed | **Blocking.** `ruff` over the protocol generator + SCons hooks (`ruff.toml`, mirrors the Python guide); clean today |
| `firmware-misra` | firmware changed | *Advisory.* `pio check` (cppcheck MISRA); large pre-existing backlog so it prints/uploads findings without blocking. CERT was a no-op addon and has been removed |
| `sil-rust` | SIL / firmware / protocol changed | **Blocking (`cargo test`).** `make protocol` + build `libfirmware.a`, then `cargo clippy` (advisory) + `cargo test` (gating) on the SIL workspace |
| `build-software` | software/firmware changed, or a software tag | Builds the desktop app for macOS/Windows/Linux |
| `build-firmware` | firmware/software changed, or a firmware tag | Builds `propeller2_debug`, `propeller2` release, and the native (SIL) binary |
| `build-hardware` | hardware changed, or a hardware tag | KiBot → Gerbers, BOM, interactive BOM, 3D models for each board |
| `sil-tests` | software or firmware changed (not a release tag) | Downloads the built artifacts, starts the emulator, and runs the Playwright integration suite |
| **`ci-gate`** | **every PR** | **Aggregates all of the above. Fails if any job failed/was cancelled; passes when they succeeded or were legitimately skipped. This is the single required status check (`CI Gate`) on `main`.** |
| `release-*` | a `*-v*` tag | Publishes a GitHub Release with the built artifacts |

The PR trigger has **no path filter** — every PR runs at least `changes` + `ci-gate`, so the required `CI Gate` check always reports. A docs-only PR skips every component job and the gate goes green in seconds; requiring the gate (instead of each job individually) is what keeps path-filtered skips from blocking a PR forever.

## Branch protection (`main`)

`main` is protected — **all changes land through pull requests**:

- **No direct pushes** for collaborators; open a PR instead. (Repo **admins keep a
  bypass** for emergency hotfixes; flip *Settings → Branches → enforce admins* on
  if you want to lock that down too.)
- **`CI Gate` must be green** before a PR can merge.
- **0 required approvals** — a PR is required, but a solo author isn't blocked
  waiting for someone else to approve. Bump *Settings → Branches → required
  approvals* when there are more maintainers.
- Force-pushes and branch deletion are disabled; stale approvals are dismissed on
  new commits.

## Advisory AI review (`.github/workflows/ai-review.yml`)

Every PR also gets a comprehensive **advisory** review from a model (free
**GitHub Models** — no API key, runs off the built-in `GITHUB_TOKEN` with
`models: read`). It is **not** a required check and **never blocks merge** — it
posts **one sticky PR comment** to prompt the author.

How it works: a `detect` job maps the changed files to *language concerns*, and a
matrix `review` job runs **one model call per touched concern** (`c`, `ts`, `rust`,
`python`, `yaml`, plus a cross-cutting `docs` pass). Each call is fed that
language's [`docs/coding-guidelines/`](../coding-guidelines/README.md) doc, a
precomputed **index of existing shared code** (so it can flag duplication / missed
reuse), and the PR's changed hunks — assembled by
[`.github/scripts/ai_review_prep.py`](https://github.com/RileyMcCarthy/MaD/blob/main/.github/scripts/ai_review_prep.py).
The model reviews for: **guideline adherence**, **reuse / anti-duplication**, **docs
freshness**, **test gaps**, and **expert suggestions** (e.g. HAL locking, layering,
append-only wire-compat). An `aggregate` job collects every section into the sticky
comment.

!!! note "Free-tier limit"
    The free tier caps each request at ~16K input tokens, so this is a
    *guideline-and-reuse-aware* reviewer, not a whole-repo agentic expert — it sees
    the routed guideline + a shared-code index + the diff, not the entire codebase.
    A deeper reviewer would need an agentic engine (e.g. `claude-code-action`) on a
    paid/subscription token; the workflow is structured so that engine could be
    swapped in later. The reviewer runs on same-repo branches only (a fork PR's
    token can't read Models or comment), and `firmware-misra` aside, nothing here
    blocks merge.

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

# Firmware static analysis + unit tests + layer rule
cd Firmware/MaDCore && pio check && pio test -e native_test
python3 Firmware/MaDCore/scripts/check_layering.py Firmware/MaDCore/src

# Python generator lint (from repo root, ruff.toml is auto-discovered)
ruff check Protocol/ProtoEmb/core Firmware/MaDCore/extra_scripts

# Protocol cross-language conformance
cd Protocol/ProtoEmb && ./examples/verify.sh

# Docs build (link check)
pip install -r docs/requirements.txt && mkdocs build --strict
```
