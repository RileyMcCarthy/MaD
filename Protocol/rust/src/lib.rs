//! protocol — MaD wire-protocol types.
//!
//! The Rust codec generated from `MaDProtocol.yaml` (sibling file) by
//! `make protocol` in `SIL/`. Nothing imports this crate: it exists so the
//! generated code and its roundtrip tests stay compiled and verified by
//! `cargo test` (the C and TS targets get the same coverage from the firmware
//! and app builds). It lives under Protocol/, next to the schema and the
//! ProtoEmb toolchain submodule, as an out-of-tree member of the SIL workspace.

#[path = "generated/protoemb.rs"]
pub mod protoemb;

pub use protoemb::*;
