//! embsim-core — Core infrastructure for embedded MCU simulation.
//!
//! Provides MCU-agnostic primitives shared by all platform crates:
//! - `virtual_clock` — scalable time for deterministic emulation
//! - `serial_pty` — PTY pair creation for host ↔ firmware serial communication

pub mod serial_pty;
pub mod virtual_clock;
