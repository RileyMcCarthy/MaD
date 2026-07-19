# Copilot instructions — MaD

MaD is a low-cost open-source uniaxial tensile-testing machine. This monorepo has:

- **Firmware** (`Firmware/MaDCore/`) — Parallax Propeller 2, C, strictly layered
  `APP → DEV → IO → Library → HAL → HW` (each layer calls only *downward*).
- **Web app** (`Software/MaDWasmControl/`) — the shipped React/Vite + WebAssembly
  browser control app (Web Serial + File System Access, Chromium-only). A legacy
  Electron app (`Software/MaDControl/`) is frozen (SIL Playwright driver only).
- **SIL** (`SIL/`) — a Rust software-in-the-loop emulator that links the firmware.
- **Protocol** (`Protocol/`) — `MaDProtocol.yaml` → generated C / TS / Rust codec.

## How to review

The authoritative coding standards live in
[`docs/coding-guidelines/`](../docs/coding-guidelines/README.md) (one file per language)
and [`CLAUDE.md`](../CLAUDE.md) / [`Claude.md`](../Claude.md). **Read the guideline for
the area you're reviewing and hold the change to it.** The path-scoped files in
`.github/instructions/` point you at the right one per area.

Deterministic tools already gate the mechanical rules — MISRA/cppcheck, ESLint, `tsc`,
Clippy, ruff, the protocol schema validator, a codegen-reproducibility check, and a
firmware layering linter. **Do not re-report what those tools catch.** Focus on the
judgment concerns tools can't decide.

## Required checklist (comment when missing or incomplete)

On every PR, explicitly check and comment when the diff warrants it:

### 1. Documentation
If the PR changes behaviour, public APIs, G-code, protocol fields, build/dev commands,
architecture, state machines, or operator-facing UX, flag missing doc updates. Name the
file(s) that should change, for example:

- `Claude.md` / `CLAUDE.md` (build, architecture, constraints)
- `docs/coding-guidelines/*` (conventions for the touched language)
- user-facing docs under `docs/` or package READMEs
- protocol / release notes when wire or version contracts change

Prefer: *"This changes X; update `path/to/doc` section Y."* over a generic "update docs."

### 2. Tests that should land with this PR
A behaviour change should update the matching test layer. Flag when tests are missing
or clearly insufficient for the risk:

| Change area | Expected coverage |
|-------------|-------------------|
| Firmware `APP`/`DEV` logic | Unity (`pio test -e native_test`) and/or SIL scenarios |
| Motion / control / faults / NVRAM | Unit + SIL; call out edge cases (limits, state transitions) |
| Protocol schema / codec | Generated targets + roundtrip; never hand-edit `Generated/` |
| MaDWasmControl domain / protocol mapping | Vitest under `Software/MaDWasmControl` |
| UI ↔ device / serial / sample stream | Worker/session tests or e2e notes; fakes only in `e2e/`, never `src/` |
| SIL emulator / models / FFI | Rust tests; guard null/len on `unsafe` trampolines |
| Legacy Electron (`MaDControl`) | Only if the PR intentionally touches the frozen E2E driver |

### 3. Suggest additional testing (actionable, optional follow-up)
When risk is higher than the PR's tests cover, **suggest concrete follow-up tests** the
author or coding agent can implement later. Be specific:

- What to test (scenario, inputs, expected outcome)
- Where it should live (Unity path, Vitest file, SIL Playwright, `mad-emulator` scenario)
- Why it matters (regression class: motion safety, wire compatibility, sample path, etc.)

Phrase these so a human can click **Fix with Copilot** / mention `@copilot` to open a
follow-up PR or commit, e.g.:

> **Suggested follow-up test (optional PR):** Add a SIL scenario that forces NVRAM
> corruption recovery and asserts the machine stays in RESTRICTED until cleared.
> Suitable for coding agent via "Fix with Copilot" or `@copilot add this test`.

Do **not** demand large test matrices for pure docs, renames, or comment-only changes.

## Architecture and safety (always apply)

- **Firmware layering** — no upward includes; `APP`/`DEV`/`IO`/`Library` must not include
  low-level MCU headers (go through the HAL). `IO_Debug.h` is a sanctioned exception.
- **HAL locking** — HAL locks are **not reentrant**, and a module must **never call
  another module's API while holding its own lock** (prevents self- and ABBA deadlocks).
- **Generated code** — never hand-edit `Generated/` / `generated/` directories; change
  the schema or templates and regenerate all three targets (C / TS / Rust).
- **Protocol wire compatibility** — `Protocol/MaDProtocol.yaml` is **append-only**: never
  reorder or insert enum variants, struct fields, or union variants (it silently breaks
  firmware↔UI↔SIL). A breaking change must bump `protocol_version` and regenerate.
- **Submodules** — `SIL/embsim` and `Protocol/ProtoEmb` are upstream pins; don't leave a
  MaD PR pointing at an unpushed submodule commit.
- **Reuse, don't duplicate** — prefer existing shared code (firmware `Library/`, app
  `src/domain` & `src/lib`, SIL `embsim` crates) over reimplementing utilities.
- **The app is not a safety device** — never make the UI halt the machine on link loss
  or tab close; the machine is the safety authority.
- **G-code completion** — profiles/tests that must signal completion to firmware should
  end appropriately (e.g. **`G122`** where the contract requires it).

## Review style

- Be specific; tie each comment to the diff.
- Prefer precision over volume — skip nits CI already covers.
- Separate **must-fix** (correctness, layering, wire breaks, missing safety-relevant tests)
  from **suggestions** (docs polish, extra tests, refactors).
- Commits follow conventional-commit style
  (`feat`, `fix`, `refactor`, `test`, `docs`, `ci`).
