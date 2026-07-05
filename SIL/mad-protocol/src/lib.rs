//! mad-protocol — MaD wire-protocol types.
//!
//! Project-specific (NOT part of the generic embsim library): the protocol
//! codec is generated from `Protocol/MaDProtocol.yaml` by `make protocol`.
//! It lives in its own crate (rather than inside a generic embsim crate) so
//! the generated roundtrip tests stay compiled and verified without coupling
//! the reusable peripheral layer to one project's wire format.

#[path = "generated/protoemb.rs"]
pub mod protoemb;

pub use protoemb::*;
