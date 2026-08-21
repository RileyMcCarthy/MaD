# Design notes

These are in-repo deep-dives kept alongside the code. They're developer-facing
design records rather than user documentation, so they live in the repository and
are linked here rather than duplicated.

## Control app

- [**PARITY.md**](https://github.com/RileyMcCarthy/MaD/blob/main/Software/Control/docs/PARITY.md)
  — a feature-by-feature inventory of the browser app against the original desktop
  app, with status for every screen and capability.
- [**TEST_PLAN.md**](https://github.com/RileyMcCarthy/MaD/blob/main/Software/Control/docs/TEST_PLAN.md)
  — the test strategy and acceptance scenarios that prove (and keep) parity:
  Rust unit, vitest, and live-SIL E2E layers.
- [**HARDENING.md**](https://github.com/RileyMcCarthy/MaD/blob/main/Software/Control/docs/HARDENING.md)
  — the reliability/scalability pass: the safety model, failure recovery, data
  integrity, and performance work.

## Protocol

- [**ProtoEmb README**](https://github.com/RileyMcCarthy/protoemb/blob/main/README.md)
  — the protocol toolchain (generator, framing, runtime, examples).
- [**wire-format.md**](https://github.com/RileyMcCarthy/protoemb/blob/main/docs/wire-format.md)
  — the canonical frame + payload contract.

## SIL framework (embsim)

- [**embsim README**](https://github.com/RileyMcCarthy/embsim/blob/main/README.md)
  — the reusable SIL framework and the ~10-line emulator.
- [**CONTRACT.md**](https://github.com/RileyMcCarthy/embsim/blob/main/CONTRACT.md)
  — the exact symbols and ABI a platform crate must export.

For the curated explanations of these systems, see
[How It Works](../how-it-works/index.md).
