# Copilot instructions — MaD

MaD is a low-cost open-source uniaxial tensile-testing machine. This monorepo has:

- **Firmware** (`Firmware/MaDCore/`) — Parallax Propeller 2, C, strictly layered
  `APP → DEV → IO → Library → HAL → HW` (each layer calls only *downward*).
- **Web app** (`Software/MaDWasmControl/`) — the shipped React/Vite + WebAssembly
  browser control app (Web Serial + File System Access, Chromium-only). A legacy
  Electron app (`Software/MaDControl/`) is frozen.
- **SIL** (`SIL/`) — a Rust software-in-the-loop emulator that links the firmware.
- **Protocol** (`Protocol/`) — `MaDProtocol.yaml` → generated C / TS / Rust codec.

## How to review

The authoritative coding standards live in
[`docs/coding-guidelines/`](../docs/coding-guidelines/README.md) (one file per language)
and [`CLAUDE.md`](../CLAUDE.md). **Read the guideline for the area you're reviewing and
hold the change to it.** The path-scoped files in `.github/instructions/` point you at
the right one per area.

Deterministic tools already gate the mechanical rules — MISRA/cppcheck, ESLint, `tsc`,
Clippy, ruff, the protocol schema validator, a codegen-reproducibility check, and a
firmware layering linter. **Do not re-report what those tools catch.** Focus on the
judgment concerns tools can't decide:

- **Firmware layering** — no upward includes; `APP`/`DEV`/`IO`/`Library` must not include
  low-level MCU headers (go through the HAL). `IO_Debug.h` is a sanctioned exception.
- **HAL locking** — HAL locks are **not reentrant**, and a module must **never call
  another module's API while holding its own lock** (prevents self- and ABBA deadlocks).
- **Generated code** — never hand-edit `Generated/` / `generated/` directories; change
  the schema or templates and regenerate.
- **Protocol wire compatibility** — `Protocol/MaDProtocol.yaml` is **append-only**: never
  reorder or insert enum variants, struct fields, or union variants (it silently breaks
  firmware↔UI↔SIL). A breaking change must bump `protocol_version` and regenerate all
  three targets.
- **Reuse, don't duplicate** — prefer existing shared code (firmware `Library/`, app
  `src/domain` & `src/lib`, SIL `embsim` crates) over reimplementing utilities.
- **Docs freshness** — if a change alters a command, flag, G-code, public API, or
  behaviour, name the doc under `docs/` that now needs updating.
- **Tests** — a behaviour change should update the matching unit/SIL test.
- **The app is not a safety device** — never make the UI halt the machine on link loss
  or tab close; the machine is the safety authority.

Be specific, tie each comment to the diff, and prefer precision over volume.
Commits follow conventional-commit style (`feat`, `fix`, `refactor`, `test`, `docs`, `ci`).
