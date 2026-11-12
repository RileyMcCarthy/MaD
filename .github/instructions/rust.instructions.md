---
applyTo: "SIL/**"
---

Rust / SIL. Full conventions: `docs/coding-guidelines/rust.md`.

- No generic `embsim` crate may depend on MaD-specific code — MaD specifics live in
  `models`, `p2core`, `p2iss`, `mad-catalog`, `mad-runner`, and the `protocol`
  crate (`Protocol/rust/`).
- `cargo fmt --all` / `--workspace` is **forbidden** (it rewrites the generated
  `protocol` crate). CI gates `cargo fmt -p models -p mad-catalog -p mad-runner --check`;
  elsewhere match the neighbouring style by hand.
- The emulator runs the P2 image; it links no host-compiled firmware and has no HAL
  trampolines. Scrutinise any `unsafe`: it belongs only at the OS edge (`libc` on a
  PTY descriptor, say), with a `// SAFETY:` comment. Flag a new `extern "C"` entry point.
- Judge doc/rationale quality (`//!` should explain *why*, not restate the signature).

Don't re-report Clippy or build errors.
