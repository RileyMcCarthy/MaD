//! protocol — MaD wire-protocol types.
//!
//! The Rust codec generated from `MaDProtocol.yaml` (sibling file) by
//! `make protocol` in `SIL/`. Nothing imports this crate: it exists so the
//! generated code and its roundtrip tests stay compiled and verified by
//! `cargo test` (the C and TS targets get the same coverage from the firmware
//! and app builds). It lives under Protocol/, next to the schema and the
//! ProtoEmb toolchain submodule, as an out-of-tree member of the SIL workspace.

// The module below is regenerated on every build, so its style is the ProtoEmb
// Rust template's, not this repo's: explicit `impl Default` blocks, structs
// built by field assignment after `Default::default()`, and parenthesised cast
// arguments. Hand-editing the output is impossible (it is overwritten by `make
// protocol`), so the lints are allowed here — scoped to the generated module,
// never crate-wide — which lets CI run clippy with `-D warnings` on the code we
// actually write. To change the style, change the template upstream in
// RileyMcCarthy/protoemb and bump the submodule pin.
#[allow(
    clippy::derivable_impls,
    clippy::field_reassign_with_default,
    unused_parens
)]
#[path = "generated/protoemb.rs"]
pub mod protoemb;

pub use protoemb::*;
