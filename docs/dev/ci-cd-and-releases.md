# CI/CD & releases

GitHub Actions builds, tests, and releases every part of MaD. There are two
workflows — `ci.yml` (build/test) and `pages.yml` (deploy the docs + app) — plus
**GitHub Copilot code review** as an advisory AI reviewer on every PR (configured via
instruction files, not a workflow).

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
| `python-lint` | firmware changed | **Blocking.** `ruff` over the PlatformIO SCons hooks (`Firmware/MaDCore/extra_scripts`; `ruff.toml`, mirrors the Python guide). The ProtoEmb generator is linted in [its own repo's CI](https://github.com/RileyMcCarthy/protoemb) |
| `firmware-misra` | firmware changed | **Blocking.** `pio check` (cppcheck + MISRA) with `check_severity = medium, high` — low is not reported. Fails CI Gate on any medium/high defect. CERT is not enforced (no cert.py with bundled cppcheck) |
| `sil-rust` | SIL / firmware / protocol changed | **Blocking (`cargo test`).** `make protocol` + build `libfirmware.a`, then `cargo clippy` (advisory) + `cargo test` (gating) on the SIL workspace |
| `build-firmware` | firmware changed, or a firmware tag | Builds `propeller2_debug`, `propeller2` release, and the native (SIL) binary |
| `build-hardware` | hardware changed, or a hardware tag | KiBot → Gerbers, BOM, interactive BOM, 3D models for each board |
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

## AI code review (GitHub Copilot, advisory)

Pull requests are reviewed by **GitHub Copilot code review** — GitHub's native,
repo-aware reviewer. It's **advisory** (inline comments, not a required check) and
enforces the judgment concerns the deterministic gates above can't decide (layering,
HAL locking, wire-compat, reuse, docs freshness).

It reads the project's standards from custom-instruction files, so its context stays in
sync with the repo:

- `.github/copilot-instructions.md` — repo-wide review focus.
- `.github/instructions/*.instructions.md` — **path-scoped** (via an `applyTo:` glob)
  files that point Copilot at the right
  [`docs/coding-guidelines/`](../coding-guidelines/README.md) doc for each area
  (firmware C, TypeScript, Rust, Python, protocol YAML).

The guidelines themselves stay the single source of truth in `docs/coding-guidelines/`;
the instruction files just *route* Copilot to them (plus a short list of the highest-
value foci per area). Edit the guideline doc, not a second copy.

!!! note "One-time setup"
    Enable **Settings → Copilot → Code review** → *automatic review* for the repo (or add
    a ruleset that requests Copilot's review on PRs). Copilot code review consumes GitHub
    Copilot AI Credits; on this **public** repo it is exempt from the Actions-minutes
    surcharge that applies to private repos.

## Pages deploy (`.github/workflows/pages.yml`)

One workflow publishes **both** this documentation site and the control app to
GitHub Pages as a single deployment:

```text
https://rileymccarthy.github.io/MaD/        → documentation (this site)
https://rileymccarthy.github.io/MaD/app/    → the control app (Control)
```

The job builds the app with Vite (base path `/<repo>/app/`), builds the docs with
MkDocs, copies the app into `site/app/`, and uploads the merged `site/` as the
Pages artifact. It triggers on:

- **push to `main`** (when `docs/**`, `mkdocs.yml`, `Software/Control/**`,
  or `Protocol/**` change),
- **`workflow_dispatch`** (manual deploy of any branch), and
- **`webapp-v*` tags**.

!!! note "One-time setup"
    In the repo, set **Settings → Pages → Source = GitHub Actions** so the
    workflow can publish.

## Releases

Releases are cut by pushing a version tag:

```bash
git tag firmware-v1.0.0 && git push --tags   # firmware binaries release
git tag hardware-v1.0.0 && git push --tags   # hardware manufacturing files
git tag webapp-v1.0.0   && git push --tags   # deploy docs + app to Pages
```

## Running the gates locally

You can reproduce the most important gates before pushing:

```bash
# Web app offline gate
cd Software/Control && npm run verify

# Full SIL integration
cd SIL && make test

# Firmware static analysis + unit tests + layer rule
cd Firmware/MaDCore && pio check -e propeller2 --fail-on-defect=medium --fail-on-defect=high && pio test -e native_test
python3 Firmware/MaDCore/scripts/check_layering.py Firmware/MaDCore/src

# Python SCons-hook lint (from repo root, ruff.toml is auto-discovered;
# the generator's lint lives in the protoemb repo)
ruff check Firmware/MaDCore/extra_scripts

# Protocol cross-language conformance
cd Protocol/ProtoEmb && ./examples/verify.sh

# Docs build (link check)
pip install -r docs/requirements.txt && mkdocs build --strict
```
