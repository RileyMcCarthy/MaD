//! Standard ProtoEmb bridge binary.
//!
//! Runs the generic NDJSON stdio bridge from `protoemb-runtime`.
//! The MaD Electron app spawns this process and communicates over
//! newline-delimited JSON on stdin/stdout.

use protoemb_runtime::bridge::StdioBridge;
use protoemb_runtime::client::ClientConfig;
use std::time::Duration;

fn main() {
    let timeout_ms: u64 = std::env::var("MAD_BRIDGE_RESPONSE_TIMEOUT_MS")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(10_000);

    let config = ClientConfig {
        response_timeout: Duration::from_millis(timeout_ms),
    };

    let mut bridge = StdioBridge::with_config(config);

    if let Err(e) = bridge.run() {
        eprintln!("Bridge error: {}", e);
        std::process::exit(1);
    }
}
