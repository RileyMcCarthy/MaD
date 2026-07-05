//! ProtoEmb Runtime
//!
//! Generic serial protocol client library for ProtoEmb-based protocols.
//! This crate is **project-independent** — it works with raw command IDs
//! and byte payloads. Project-specific typing is supplied by the generated
//! code (command-ID constants + `encode`/`decode` per struct, and the
//! generated typed facade), which lives alongside the caller; the runtime
//! itself never depends on any particular schema.
//!
//! # Architecture
//!
//! ```text
//! ┌─────────────────────────────────────────────────┐
//! │  StdioBridge (NDJSON on stdin/stdout)            │
//! │  Host process sends JSON commands, receives      │
//! │  JSON events — no serial or framing knowledge    │
//! ├─────────────────────────────────────────────────┤
//! │  Client                                          │
//! │  Request/response orchestration, one-in-flight   │
//! │  at a time, timeout + retry logic                │
//! ├─────────────────────────────────────────────────┤
//! │  PriorityQueue                                   │
//! │  HIGH (writes, on-demand reads) before           │
//! │  LOW (periodic polling), with coalescing         │
//! ├─────────────────────────────────────────────────┤
//! │  Transport (trait)                               │
//! │  SerialTransport — opens real serial port         │
//! │  or any custom impl (e.g. PTY for testing)       │
//! ├─────────────────────────────────────────────────┤
//! │  protoemb-framing                                │
//! │  Frame parser + builder + CRC                    │
//! └─────────────────────────────────────────────────┘
//! ```
//!
//! # Usage
//!
//! The typical usage pattern is:
//! 1. Create a [`transport::SerialTransport`] (or custom transport)
//! 2. Create a [`client::Client`] with the transport
//! 3. Use [`client::Client::read`] and [`client::Client::write`] to communicate
//! 4. Optionally wrap in [`bridge::StdioBridge`] for subprocess IPC

pub mod transport;
pub mod queue;
pub mod storage;
pub mod client;

// The NDJSON stdio bridge is native-only (stdio + serial port enumeration).
#[cfg(not(target_arch = "wasm32"))]
pub mod bridge;

// The browser bindings: a `WasmClient` driven by JS over Web Serial.
#[cfg(target_arch = "wasm32")]
pub mod wasm;

// Re-export key types at crate root
pub use client::Client;
pub use queue::{Priority, QueuedMessage};
pub use storage::{DataStore, RingBuffer};
pub use transport::Transport;
#[cfg(not(target_arch = "wasm32"))]
pub use transport::SerialTransport;
#[cfg(unix)]
pub use transport::PtyTransport;
#[cfg(not(target_arch = "wasm32"))]
pub use bridge::StdioBridge;
