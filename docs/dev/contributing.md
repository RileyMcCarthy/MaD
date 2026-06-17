# Contributing

Contributions are welcome. This page collects the conventions and hard
constraints that keep MaD consistent across its firmware, app, protocol, and test
rig.

## Before you push

Run the gate(s) for the area you touched (see
[CI/CD](ci-cd-and-releases.md#running-the-gates-locally)). At minimum:

- **App:** `npm run verify` in `Software/MaDWasmControl`.
- **Firmware:** `pio check` + `pio test -e native_test`, and build both
  `native_emulator` and `propeller2`.
- **Protocol:** regenerate all consumers and run `./examples/verify.sh`.
- **Anything user-facing:** `mkdocs build --strict` if you changed docs.

## Key constraints

These are enforced by review (and often by tooling). Breaking them causes subtle,
hard-to-debug failures:

- **Firmware layering** — `APP → DEV → IO → Library → HAL → HW`, downward only.
  Don't call low-level MCU headers above the HAL. (`pio check` runs MISRA/CERT.)
- **Locking discipline** — HAL locks are **not reentrant**; never call another
  module's API while holding your own lock (prevents self- and ABBA deadlocks).
  `Library` structures are unsynchronised by contract.
- **Generated code is off-limits** — never hand-edit `Generated/`/`generated/`
  directories; change the [schema or templates](protocol-codegen.md) and
  regenerate.
- **Keep the app pure** — `Software/MaDWasmControl/src/` uses only Web Serial +
  File System Access. Test-only fakes (SIL serial, OPFS) live in `e2e/`, never in
  `src/`.
- **Native *and* P2** — always exercise both the host (`native_*`) and the real
  `propeller2` builds; pointer sizes and timing differ.
- **embsim stays generic** — no generic embsim crate may depend on MaD-specific
  code. MaD specifics live in `MaDSim/`, `embsim-mad-models/`, `mad-protocol/`.
- **The app is not a safety device** — never make the UI halt the machine on link
  loss or tab close; the machine is the [safety authority](../how-it-works/the-machine.md#safety-model).

## Coding guidelines

Detailed, language-specific coding standards — grounded in how the code is
actually written and gated — live in
[**Coding guidelines**](../coding-guidelines/README.md): C/firmware (MISRA + CERT),
Rust/SIL, Python (the generator), TypeScript, and the protocol-YAML schema.
Contributors (and AI assistants) are expected to follow them.

## Conventions

- **Firmware files** are prefixed by layer (`app_`, `dev_`, `IO_`, `lib_`); use
  `src/template.ch` / `src/template.cx` as the starting layout for new files.
- **Match the surrounding code** — comment density, naming, and idiom.
- **Commits** follow conventional-commit style (`feat(...)`, `fix(...)`,
  `refactor(...)`, `test(...)`, `docs(...)`).

## Documentation

This site lives in `docs/` and is built with MkDocs Material. To work on it:

```bash
pip install -r docs/requirements.txt
mkdocs serve     # live preview at http://127.0.0.1:8000
```

If you change the app's UI, regenerate the screenshots so the guides stay current
(see [Running the app](running-the-app.md#regenerating-documentation-screenshots)).
