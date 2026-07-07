---
applyTo: "SIL/**"
---

Rust / SIL. Full conventions: `docs/coding-guidelines/rust.md`.

- No generic `embsim` crate may depend on MaD-specific code — MaD specifics live in
  `MaDSim`, `models`, and `mad-protocol`.
- Repo-wide `cargo fmt` is **forbidden** (it would churn ~139 files); match the
  neighbouring style by hand.
- Scrutinise FFI `unsafe` boundaries: guard-before-deref (null/len/sign) on each
  trampoline, and the verbatim firmware symbol names.
- Judge doc/rationale quality (`//!` should explain *why*, not restate the signature).

Don't re-report Clippy or build errors.
