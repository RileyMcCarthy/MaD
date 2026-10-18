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
| `wasm-control-ci` | app or protocol changed | Build WASM, generate the protocol, `npm run verify` (typecheck + lint + tests + build), diagnostics e2e, M12 schema↔domain lockstep — fully offline. protoemb-runtime `cargo test` is `protoemb-ci` |
| `protoemb-ci` | protocol changed | Generator unit tests + cross-language (C == Rust == TS) wire conformance + framing/runtime crate tests |
| `embsim-ci` | SIL / firmware / protocol changed | Builds and tests the pinned `SIL/embsim` commit (workspace tests, doctests, `embsim-trace` with `web` off) |
| `embsim-pin-ci` | **the `SIL/embsim` gitlink moved** | **Blocking.** The other half of embsim's upstream gate, run against the commit being pinned: determinism goldens (5× as separate processes) + stepped-clock suites + goldens-unmodified, rustfmt, clippy `-D warnings`, `cargo doc` deny-warnings, MSRV read from the pinned manifest, and `cargo deny`. Catches a pin bumped to an unpushed or never-CI'd commit |
| `protoemb-pin-ci` | **the `Protocol/ProtoEmb` gitlink moved** | **Blocking.** Mirror of the above for the other submodule: `make verify` round-trip, ruff, clippy `-D warnings` (native + `wasm32`), `wasm-pack` build, `cargo deny` per crate + `pip-audit`, MSRV per crate manifest |
| `vibes-pin-ci` | **the `Vibes` gitlink moved** | **Blocking.** Mirror of upstream Vibes CI for the commit being pinned: the tool's install, typecheck, tests and build, plus compile probes of its C, Rust and TypeScript bindings |
| `docs-ci` | `docs/**` or `mkdocs.yml` changed | **Blocking.** `mkdocs build --strict` — broken nav entries, dead internal links and config warnings are errors. Previously this ran only on a push to `main` via `pages.yml`, so a bad docs PR merged green and took the Pages deploy down |
| `control-e2e-boardless` | app or protocol changed, or the `SIL/embsim` gitlink moved | **Blocking.** The e2e scenarios that need no board (A1 and the firmware-flash `FW*` ones): the real app in a real host Chrome against in-page fakes, no emulator. The scenarios that touch the board run in `control-e2e-board` and the nightly. See [below](#the-e2e-suite) |
| `control-e2e-board` | app, protocol, firmware or SIL changed, or the `SIL/embsim` gitlink moved | **Blocking.** A subset of the board-touching e2e scenarios on the board route: the P2 image on the ISS, and the app in the runner's Chrome held to the board's clock by embsim's `chrome-cdp` node (`mad-emulator --chrome`), one fresh board per scenario (`SIL/scripts/board-route.sh e2e`, `BOARD_PER_SCENARIO=1`), then BUNDLE-live on the bundle as `pages.yml` builds it (`APP_DIST`, served by `vite preview`). The whole suite runs nightly on the same route (`e2e-nightly.yml`). See [below](#the-e2e-suite) |
| `firmware-unit-tests` | firmware or protocol changed | `pio test -e native_test` — the host Unity suite under AddressSanitizer (no Propeller toolchain needed) |
| `protocol-codegen` | protocol changed | **Blocking.** Regenerates all three targets (C/TS/Rust) twice and asserts success + byte-reproducibility (generated files are gitignored, so this guards the schema/templates + generator determinism, not committed-file drift) |
| `firmware-layering` | firmware changed | **Blocking (baseline-gated).** `scripts/check_layering.py` enforces downward-only includes (APP→DEV→IO→Library→HAL→HW); pre-existing violations are frozen in `.layering-baseline`, so it fails only on **new** upward includes |
| `python-lint` | firmware changed | **Blocking.** `ruff` over the PlatformIO SCons hooks (`Firmware/MaDCore/extra_scripts`; `ruff.toml`, mirrors the Python guide). The ProtoEmb generator is linted in [its own repo's CI](https://github.com/RileyMcCarthy/protoemb) |
| `firmware-misra` | firmware changed | **Blocking.** `pio check` (cppcheck + MISRA) with `check_severity = medium, high` — low is not reported. Fails CI Gate on any medium/high defect. CERT is not enforced (no cert.py with bundled cppcheck) |
| `sil-rust` | SIL / firmware / protocol changed | **Blocking.** `make protocol` + the `propeller2_debug` image, then `cargo fmt --check`, `cargo clippy -- -D warnings`, and `cargo test` on the SIL workspace — all three gating. rustfmt covers `mad-emulator` + `models`; the generated `protocol` crate is excluded because `make protocol` rewrites it every build. Generated-codec clippy allows are scoped to the `mod protoemb` declaration in `Protocol/rust/src/lib.rs`, never crate-wide |
| `build-firmware` | firmware changed, or a firmware tag | Builds `propeller2_debug` and `propeller2` release |
| `build-hardware` | hardware changed, or a hardware tag | KiBot → Gerbers, BOM, interactive BOM, 3D models for each board |
| `vibes` (Behaviour ledger) | every PR | **Informational** (not in `ci-gate.needs`). Diffs the behaviour ledger against the base branch and posts the report as a PR comment; it fails when a behaviour breaks or is removed, but does not block the merge |
| **`ci-gate`** | **every PR** | **Aggregates all of the above except `vibes`. Fails if any job failed/was cancelled; passes when they succeeded or were legitimately skipped. This is the single required status check (`CI Gate`) on `main`.** |
| `release-*` | a `firmware-v*` / `hardware-v*` tag | Publishes a GitHub Release with the built artifacts. `release-firmware` then dispatches `pages.yml` on `main`, so `/app/firmware/` serves the new release ([Pages deploy](#pages-deploy-githubworkflowspagesyml)). MaD Control releases are cut by `pages.yml` on `madcontrol-v*` tags. |

The PR trigger has **no path filter** — every PR runs at least `changes` + `ci-gate`, so the required `CI Gate` check always reports. Requiring the gate (instead of each job individually) is what keeps path-filtered skips from blocking a PR forever.

A docs-only PR now runs `docs-ci` (and nothing else); before that job existed it skipped *every* job, which is how a strict-mode docs break could merge green.

### The e2e suite

The e2e suite runs the real app in a real Chrome against the firmware. There is
one valid configuration for the scenarios that touch the board: the shipped P2
image on the ISS, and the runner's Chrome with every page and worker held to
the board's clock by embsim's `chrome-cdp` node (`mad-emulator --chrome`), its
Web Serial port the board's protocol line. Every budget in the suite is board
time, so a result does not depend on how fast the runner is. The ISS behind the
WS↔PTY bridge is not a configuration: the bridge hands the board's bytes to a
browser running at host speed, so every wait measures the host rather than the
machine.

The ISS runs at a few percent of real time, so a scenario costs 10–30 times its
board time in host time:

| Job | When | What |
|---|---|---|
| `control-e2e-board` | per PR: the app, the protocol, the firmware, `SIL/`, or a move of the `SIL/embsim` pin (#148) | **Gates.** A subset of the board scenarios on the ISS with `chrome-cdp` (its comment names the scenarios and the time), and BUNDLE-live on the shipped bundle. A fetch that holds a virtual-time budget is granted that budget again under `advance` |
| `control-e2e-boardless` | per PR: the app, or a pin move | **Gates.** The scenarios that never reach a board (A1 and the `FW*` flasher ones, a host Chrome against in-page fakes) |
| `e2e-nightly.yml` | 06:17 UTC daily, or by hand | The whole suite on the same route, after the node's Chrome canary (a worker's timer on the board's clock) |

A move of the `SIL/embsim` pin runs the board job as #148 intended: the node
the suite runs on is embsim's, and `sil-rust` exercises `mad-emulator` itself
against the pin.

Until the native firmware library was removed, `control-e2e-sil` ran the full
suite per PR against that library behind the bridge, unpaced (`--speed 0`) so the
result did not depend on runner speed. It found the missing `<mount>/gcode/`
provisioning (every uploaded test stored zero moves on a fresh SD card), a UI that
reported a moving machine as idle, and a toolchain-specific protocol UB
([protoemb#23](https://github.com/RileyMcCarthy/protoemb/pull/23)) that returned
0-byte downloads under GCC.

`ci.yml` is the source of truth for which jobs gate.

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

One workflow publishes **both** this documentation site and every MaD Control
release to GitHub Pages as a single deployment:

```text
https://rileymccarthy.github.io/MaD/               → documentation (this site, from main)
https://rileymccarthy.github.io/MaD/app/           → redirects to the latest release
https://rileymccarthy.github.io/MaD/app/vX.Y.Z/    → one release, exactly as it shipped
```

- **Each release is built once.** Pushing a `madcontrol-vX.Y.Z` tag runs the
  `release-app` job. It builds the app for its own folder (base path
  `/<repo>/app/vX.Y.Z/`), attaches the build to the **MaD Control X.Y.Z** GitHub
  Release as `mad-control-vX.Y.Z.zip`, then asks `main` to redeploy.
- **Every deploy re-assembles the site.** The `build` job builds the docs from
  `main`, then `tools/assemble-pages-app.mts` unpacks every release zip into
  `site/app/vX.Y.Z/` and writes:
    - `versions.json`, which lists the releases for the app's version picker on
      **About**;
    - the `/app/` redirect, which keeps the page part of the URL;
    - `/app/firmware/`, the latest firmware release, shared by every version so
      an older app still offers the newest firmware;
    - an `/app/sw.js` that removes the service worker left by the unversioned
      app.
- **Merging to `main` never changes a published app.** It redeploys only when
  the docs, the assembler or this workflow change.
- **Pages deploys from `main`.** The `github-pages` environment only accepts that
  branch, which is why the tag job dispatches a `main` deploy rather than
  deploying itself.
- **A firmware release triggers a redeploy too,** so the shared firmware stays
  current. Once a `firmware-v*` tag has published its release, `ci.yml`'s
  `release-firmware` job dispatches this workflow on `main`
  (`gh workflow run pages.yml --ref main`). That run only re-assembles: the
  existing release zips plus the new firmware in `/app/firmware/`.
  `release-app` runs only on `madcontrol-v*` tags, so no app is rebuilt.
- **Releases from before 0.4.0 carry no build** and are not hosted.

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

That tag builds the release, publishes the **MaD Control X.Y.Z** GitHub Release
with its `mad-control-vX.Y.Z.zip`, and redeploys Pages. `/app/` then opens
X.Y.Z, and earlier releases stay at their own `/app/vX.Y.Z/` addresses.

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

The e2e suite runs on the board route (the ISS with the app in Chrome on the
board's clock; no WS bridge). From `SIL/`, `make e2e` starts the dev server
and the board, runs the suite and stops everything; `SCENARIOS=…` selects a
subset, and `BOARD_PER_SCENARIO=1` gives each scenario a fresh board, as CI
does:

```bash
cd SIL && make e2e BOARD_PER_SCENARIO=1   # as control-e2e-board and the nightly run it
cd SIL && make e2e SCENARIOS=B1+C1,F7     # a subset
cd SIL && make e2e-bundle                 # BUNDLE-live on the built bundle
```

CI and the nightly run the suite on the dev server, which compiles for the
newest Chrome. BUNDLE-live runs on the bundle the app ships as (`vite build`, the
Pages base path, served by `vite preview`; `board-route.sh` with `APP_DIST`),
which is compiled for the app's browser floor: a fault that compiling brings
in shows only there.

See [SIL testing](sil-testing.md#running-the-e2e-suite) for the three-terminal
version and `Software/Control/docs/TEST_PLAN.md` for the scenarios. The
nightly runs the whole suite; dispatching it by hand with `suite=smoke` runs
the IDs in `Software/Control/e2e/smoke-ids.txt` instead.
