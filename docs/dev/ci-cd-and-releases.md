# CI/CD & releases

GitHub Actions builds, tests, and releases every part of MaD. There are three
workflows — `ci.yml` (build/test), `pages.yml` (deploy the docs + app), and
`e2e-nightly.yml` (scheduled emulator-backed e2e on `main`) — plus
**GitHub Copilot code review** as an advisory AI reviewer on every PR (configured via
instruction files, not a workflow).

## CI (`.github/workflows/ci.yml`)

A `changes` gate job detects which areas a push/PR touched and runs only the
relevant jobs:

| Job | Runs when | What it does |
|---|---|---|
| `wasm-control-ci` | app or protocol changed | `cargo test` the runtime, build WASM, generate the protocol, then `npm run verify` (typecheck + lint + tests + build) — fully offline |
| `protoemb-ci` | protocol changed | Generator unit tests + cross-language (C == Rust == TS) wire conformance + framing/runtime crate tests |
| `embsim-ci` | SIL / firmware / protocol changed | Builds and tests the pinned `SIL/embsim` commit (workspace tests, doctests, `embsim-trace` with `web` off) |
| `embsim-pin-ci` | **the `SIL/embsim` gitlink moved** | **Blocking.** The other half of embsim's upstream gate, run against the commit being pinned: determinism goldens (5× as separate processes) + stepped-clock suites + goldens-unmodified, rustfmt, clippy `-D warnings`, `cargo doc` deny-warnings, MSRV read from the pinned manifest, and `cargo deny`. Catches a pin bumped to an unpushed or never-CI'd commit |
| `protoemb-pin-ci` | **the `Protocol/ProtoEmb` gitlink moved** | **Blocking.** Mirror of the above for the other submodule: `make verify` round-trip, ruff, clippy `-D warnings` (native + `wasm32`), `wasm-pack` build, `cargo deny` per crate + `pip-audit`, MSRV per crate manifest |
| `docs-ci` | `docs/**` or `mkdocs.yml` changed | **Blocking.** `mkdocs build --strict` — broken nav entries, dead internal links and config warnings are errors. Previously this ran only on a push to `main` via `pages.yml`, so a bad docs PR merged green and took the Pages deploy down |
| `control-e2e-sil` | app / protocol / firmware / SIL changed | **Blocking.** The full Control ↔ SIL e2e suite: real app in real Chrome against the real emulator over the WS↔PTY bridge — the only job that exercises the whole stack as one system. Runs the emulator unpaced (`make e2e-emulator`), so the result does not depend on runner speed. See [below](#the-e2e-suite) |
| `firmware-unit-tests` | firmware or protocol changed | `pio test -e native_test` — the host Unity suite under AddressSanitizer (no Propeller toolchain needed) |
| `protocol-codegen` | protocol changed | **Blocking.** Regenerates all three targets (C/TS/Rust) twice and asserts success + byte-reproducibility (generated files are gitignored, so this guards the schema/templates + generator determinism, not committed-file drift) |
| `firmware-layering` | firmware changed | **Blocking (baseline-gated).** `scripts/check_layering.py` enforces downward-only includes (APP→DEV→IO→Library→HAL→HW); pre-existing violations are frozen in `.layering-baseline`, so it fails only on **new** upward includes |
| `python-lint` | firmware changed | **Blocking.** `ruff` over the PlatformIO SCons hooks (`Firmware/MaDCore/extra_scripts`; `ruff.toml`, mirrors the Python guide). The ProtoEmb generator is linted in [its own repo's CI](https://github.com/RileyMcCarthy/protoemb) |
| `firmware-misra` | firmware changed | **Blocking.** `pio check` (cppcheck + MISRA) with `check_severity = medium, high` — low is not reported. Fails CI Gate on any medium/high defect. CERT is not enforced (no cert.py with bundled cppcheck) |
| `sil-rust` | SIL / firmware / protocol changed | **Blocking.** `make protocol` + build `libfirmware.a`, then `cargo fmt --check`, `cargo clippy -- -D warnings`, and `cargo test` on the SIL workspace — all three gating. rustfmt covers `mad-emulator` + `models`; the generated `protocol` crate is excluded because `make protocol` rewrites it every build. Generated-codec clippy allows are scoped to the `mod protoemb` declaration in `Protocol/rust/src/lib.rs`, never crate-wide |
| `build-firmware` | firmware changed, or a firmware tag | Builds `propeller2_debug`, `propeller2` release, and the native (SIL) binary |
| `build-hardware` | hardware changed, or a hardware tag | KiBot → Gerbers, BOM, interactive BOM, 3D models for each board |
| **`ci-gate`** | **every PR** | **Aggregates all of the above. Fails if any job failed/was cancelled; passes when they succeeded or were legitimately skipped. This is the single required status check (`CI Gate`) on `main`.** |
| `release-*` | a `firmware-v*` / `hardware-v*` tag | Publishes a GitHub Release with the built artifacts. MaD Control releases are cut by `pages.yml` on `madcontrol-v*` tags. |

The PR trigger has **no path filter** — every PR runs at least `changes` + `ci-gate`, so the required `CI Gate` check always reports. Requiring the gate (instead of each job individually) is what keeps path-filtered skips from blocking a PR forever.

A docs-only PR now runs `docs-ci` (and nothing else); before that job existed it skipped *every* job, which is how a strict-mode docs break could merge green.

### The e2e suite

`control-e2e-sil` runs the full ~50-scenario suite on every app/protocol/firmware/SIL
PR — the only job that exercises the app, the generated codec, the firmware and the
machine models as one system, so the only place an integration break can be caught. It
has earned that repeatedly: it found the missing `<mount>/gcode/` provisioning (every
uploaded test stored zero moves on a fresh SD card), a UI that reported a moving
machine as idle, and a toolchain-specific protocol UB that returned 0-byte downloads
under GCC.

It **gates** (it is in `ci-gate.needs`): a red e2e run blocks the merge.

It ran advisory only until it deserved to gate. Two things had to be fixed first, and
both were:

1. **It was paced to real time.** The suite borrowed `make playground` (`--speed 1.0`),
   which requires the emulator to sustain a real-time factor of 1.0 — impossible on a
   shared 4-vCPU runner, so the suite measured the runner (~0.25 RTF, 13 failures) and
   passed on faster dev boxes. It now runs unpaced via `make e2e-emulator` (`--speed
   0`): virtual time advances by idle jump, decoupled from the wall clock, so the
   outcome no longer depends on host speed.
2. **A toolchain-specific UB.** Unsequenced `outSize` in the generated dispatcher
   (fixed in [protoemb#23](https://github.com/RileyMcCarthy/protoemb/pull/23)) made
   every `file_download` return a 0-byte frame under GCC while working under Clang.

With both fixed the suite is 49/49 on CI's own toolchain.

`e2e-nightly.yml` runs the same suite on a schedule against `main`, for drift that only
shows over many runs. `ci.yml` is the source of truth for which jobs gate.

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
https://rileymccarthy.github.io/MaD/app/    → MaD Control
```

The job builds the app with Vite (base path `/<repo>/app/`), builds the docs with
MkDocs, copies the app into `site/app/`, and uploads the merged `site/` as the
Pages artifact. **Pages deploys from `main`** (and `workflow_dispatch`). The
`github-pages` environment only allows that branch, so a `madcontrol-v*` tag
does **not** deploy Pages — it asserts `package.json` matches the tag and
publishes a **MaD Control** GitHub Release. The matching merge to `main` already
deployed that SHA.

!!! note "One-time setup"
    In the repo, set **Settings → Pages → Source = GitHub Actions** so the
    workflow can publish.

## Releases

**MaD Control** (`Software/Control/`) — `package.json` is the source of truth.
Do not `git tag` by hand (`webapp-v*` is retired). From the repo root:

```bash
# Protected main (default): bump on a branch, merge, then tag origin/main
git checkout -b release/madcontrol origin/main
Software/Control/scripts/release.sh patch --no-tag    # or minor | major | x.y.z
git push -u origin HEAD
# open PR → CI Gate → merge
Software/Control/scripts/release.sh --publish         # tags madcontrol-vX.Y.Z
```

That tag publishes a GitHub Release named **MaD Control X.Y.Z**. Pages already
deployed from the merge to `main`.

Firmware and hardware are still cut with version tags:

```bash
git tag firmware-v1.0.0 && git push origin firmware-v1.0.0   # firmware binaries
git tag hardware-v1.0.0 && git push origin hardware-v1.0.0   # manufacturing files
```

## Running the gates locally

You can reproduce the most important gates before pushing:

```bash
# MaD Control offline gate
cd Software/Control && npm run verify

# Full SIL integration
cd SIL && make test

# SIL Rust gates — all three block CI. rustfmt skips the generated `protocol`
# crate, which `make protocol` rewrites on every build.
cd SIL && cargo fmt -p mad-emulator -p models --check \
       && cargo clippy --workspace --all-targets -- -D warnings \
       && cargo test --workspace --all-targets

# Firmware static analysis + unit tests + layer rule
cd Firmware/MaDCore && pio check -e propeller2 --fail-on-defect=medium --fail-on-defect=high && pio test -e native_test
python3 Firmware/MaDCore/scripts/check_layering.py Firmware/MaDCore/src

# Python SCons-hook lint (from repo root, ruff.toml is auto-discovered;
# the generator's lint lives in the protoemb repo)
ruff check Firmware/MaDCore/extra_scripts

# Protocol cross-language conformance
cd Protocol/ProtoEmb && ./examples/verify.sh

# Docs build (link check) — gated by docs-ci
pip install -r docs/requirements.txt && mkdocs build --strict
```

The e2e suite needs the emulator, the WS bridge and the dev server up
(three terminals), then `cd Software/Control && npm run e2e` — see
`Software/Control/docs/TEST_PLAN.md`. `npm run e2e:smoke` runs the subset the
nightly uses.
