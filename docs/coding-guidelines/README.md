# MaD Coding Guidelines

These are the coding standards for the MaD monorepo. They are grounded in the actual codebase — the conventions, patterns, and constraints below reflect how the code is really written and gated, not aspirational rules. **Contributors and AI assistants are expected to follow them** when adding or changing code anywhere in this repository.

The deep, language-specific detail lives in the per-language guides. This index covers only the cross-cutting principles that apply everywhere; start with the guide for whatever you're touching.

## Guides

- [C / Firmware (Propeller 2) — MISRA + cppcheck](c-firmware.md) — Hand-written C under `Firmware/MaDCore/src/`: template/banner layout, layer-prefixed naming, MISRA-friendly idioms, the strict downward layer rule, the non-reentrant HAL try-lock + double-buffer concurrency pattern, cog-manager channels, and how `pio check` is wired (medium+high blocking; low disabled).
- [TypeScript / React](typescript.md) — interface/type/enum conventions, strict `tsconfig`, ESLint, and the generated `protoemb.ts` codec boundary. **Note:** this guide currently documents the **legacy** Electron app (`Software/MaDControl/`); the shipped app, **`Software/Control/`** (frontend-only Web Serial + WASM PWA), follows the same TS/React conventions but with a flat ESLint config and a Web Worker + WASM boundary instead of Electron's main/renderer IPC. (A WASM-app-specific guide is a pending follow-up.)
- [Rust / SIL (MaDSim + embsim workspace)](rust.md) — The Software-in-the-Loop layer under `SIL/`: the generic-framework vs MaD-consumer split (embsim is now a [standalone repo](https://github.com/RileyMcCarthy/embsim) vendored at `SIL/embsim`), Cargo workspace inheritance, the FFI/`unsafe` HAL boundary, std-only hand-rolled error handling, static/atomics/`Mutex` concurrency, the do-not-edit generated protocol crate, and the CI gates (`sil-rust` runs `cargo test`; embsim's own CI gates the submodule).
- [Python (build hooks + ProtoEmb generator)](python.md) — The PlatformIO SCons helpers (`Firmware/MaDCore/extra_scripts/`) and the conventions shared with the ProtoEmb code generator (now a [standalone repo](https://github.com/RileyMcCarthy/protoemb) vendored at `Protocol/ProtoEmb`): the dependency-light stack (pyyaml + jinja2), argparse CLI shape, schema-enrichment key convention, the `SystemExit`-vs-`ValueError` error model, the hardened YAML loader (keeps `OFF`/`ON` as strings), and Jinja2 conventions.
- [Protocol YAML schema (MaDProtocol.yaml) authoring conventions](protocol-yaml.md) — Authoring `Protocol/MaDProtocol.yaml`, the single source of truth the generator turns into byte-identical C, TypeScript, and Rust codecs: top-level layout, naming/casing, the field type system, the message routing/timing table, the wire-format contract, versioning/append-only rules, and the regenerate-all-three-targets workflow.

## Shared principles

These apply repo-wide regardless of language. Each guide expands them in its own context.

### Respect layering and separation of concerns
The firmware has a **strict layered architecture** — each layer only calls the layer below (`APP → DEV → IO → Library → HAL → HW`). Never include or call low-level MCU headers from `APP`/`DEV`/`IO`; go through `HAL`. The same separation discipline applies elsewhere: in the shipped app keep the **UI ↔ Web Worker boundary** clean (the serial read loop and all protocol/WASM work live in the worker; `src/` stays pure Web Serial + File System Access, with test fakes confined to `e2e/`); in SIL keep the reusable **embsim framework** crates free of MaD-specific assumptions, with MaD specifics confined to the consumer crates and FFI/`unsafe` confined to the platform crate.

### Never hand-edit generated code
Three directories are generated from `Protocol/MaDProtocol.yaml` and must **never** be edited by hand:

- `Firmware/MaDCore/src/Generated/`
- `Software/Control/src/protocol/generated/` (shipped app; the legacy Electron app's target was `Software/MaDControl/src/main/generated/`)
- `Protocol/rust/src/generated/` — the Rust target output (per `SIL/makefile:33`); holds `protoemb.rs`. (Some older docs referred to `SIL/embsim/peripherals/src/generated/`, which does not exist — use the `Protocol/rust/src/generated/` path.)

To change anything in them, edit the schema (or the Jinja2 templates) and regenerate.

### Regenerate from the schema
After changing `Protocol/MaDProtocol.yaml` or the templates, regenerate **all three** targets so they stay in lock-step (run from repo root):

```bash
python3 ./Protocol/ProtoEmb/core/generate.py --schema ./Protocol/MaDProtocol.yaml --target c  --output ./Firmware/MaDCore/src/Generated         --templates ./Protocol/ProtoEmb/core/templates
python3 ./Protocol/ProtoEmb/core/generate.py --schema ./Protocol/MaDProtocol.yaml --target ts --output ./Software/Control/src/protocol/generated --templates ./Protocol/ProtoEmb/core/templates
python3 ./Protocol/ProtoEmb/core/generate.py --schema ./Protocol/MaDProtocol.yaml --target rs --output ./Protocol/rust/src/generated          --templates ./Protocol/ProtoEmb/core/templates
```

Firmware also regenerates its C target automatically via the `extra_scripts/generate_protocol.py` PlatformIO pre-build hook. Commit the regenerated code alongside the schema change.

### The protocol is the cross-language contract
Firmware, the desktop app, and the SIL emulator all speak the same wire format (serial, 2,000,000 baud on hardware). The schema-driven codecs are **byte-identical across C, TypeScript, and Rust (C == Rust == TS)** — that equivalence is the contract. Do not patch one language's codec to work around the others; fix the schema and regenerate. G-code motion profiles (`G0`, `G1`, `G4`, `G28`, `G90`, `G91`, `G122`) are streamed line-by-line, and tests/profiles that must signal completion should end with `G122` where the firmware contract requires it.

### Run the linters and checks before pushing
Each area has its own gate (see the checklist below). Run the relevant one locally before pushing. Firmware `pio check` enforces **medium + high** only (low severity is disabled project-wide); fix medium/high rather than suppressing.

### Native vs P2 testing
Pointer sizes and timing differ between the Propeller 2 and the host. Always exercise the `native_emulator` / `native_test` builds for firmware changes — passing on one target does not guarantee the other.

### SIL is single-instance
Treat the emulator as single-instance. Playwright E2E tests use `workers: 1` where the single-instance emulator requires it; don't write tests that assume parallel emulator instances.

### Concurrency / locking discipline (firmware)
HAL locks are **not reentrant**, and a module must **never call another module's API while holding its own lock** (prevents self-deadlock and cross-cog ABBA deadlocks). `IO_protocol` and shared protocol/JSON buffers are not casually thread-safe across cogs; `lib_staticQueue` and Library data structures are unsynchronized by contract (lock-free only for SPSC use) — the owning module wraps ops in its own lock when its topology needs one.

### Commit and PR conventions
Commits follow **Conventional Commits with a scope**: `type(scope): subject` — e.g. `feat(protocol):`, `refactor(firmware):`, `test(sil):`, `fix(ci):`, `chore(protocol):`. Keep changes scoped to one area where practical. Branch off `main` rather than committing to it directly. Releases are cut by pushing version tags (`webapp-v*` deploys the shipped app + docs to Pages; `firmware-v*`, `hardware-v*`; `software-v*` packages the legacy Electron app).

## Before you push

Run the gate for each area you touched:

| Area | Lint / static check | Tests |
| --- | --- | --- |
| Firmware (C) | `pio check -e propeller2 --fail-on-defect=medium --fail-on-defect=high` (from `Firmware/MaDCore/`) | `pio test -e native_test` |
| Software (TS/React) | `npm run verify` (from `Software/Control/` — tsc + eslint + tests + build) | included in `verify` (`npm test`, Vitest) |
| SIL (Rust) | `cargo clippy` + `cargo fmt --check` (from `SIL/`) | `make test` (emulator + Playwright) |
| Protocol / generated code | — | Regenerate all three targets with `generate.py` and commit the output (re-run the schema's conformance/`verify.sh` check) |

If you changed `MaDProtocol.yaml` or the templates, regenerate before running the per-area gates above so each language is linting/testing against the up-to-date codec.
