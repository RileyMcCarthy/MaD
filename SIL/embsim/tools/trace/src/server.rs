//! Trace viewer — WebSocket handler and embsim-ui view registration.
//!
//! Protocol (server → client):
//!   { "catalog": [{ name, group, unit }, ...] }   — active signals catalog
//!   { "data": { "signal_name": [{ time_us, value }, ...], ... } } — incremental samples
//!   { "firmware_catalog": [{ signal_name, var_name, field_path }, ...] } — available firmware vars
//!
//! Protocol (client → server):
//!   { "cmd": "subscribe",   "signals": ["name1", "name2"] }
//!   { "cmd": "unsubscribe", "signals": ["name1"] }
//!   { "cmd": "browse_firmware" }                     — request firmware variable catalog
//!   { "cmd": "add_signal",    "signal": "name" }     — activate a firmware variable
//!   { "cmd": "remove_signal", "signal": "name" }     — deactivate a signal
//!   { "cmd": "set_poll_interval", "interval_ms": 10 } — set C variable polling rate

use crate::recorder;
use crate::ui;
use axum::extract::ws::{Message, WebSocket};
use embsim_core::virtual_clock;
use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::pin::Pin;
use tracing::info;

/// Register the trace viewer as a view in embsim-ui.
/// Call this before `embsim_ui::start_server()`.
pub fn register_view() {
    let view = embsim_ui::View::new(
        "trace",
        "Trace Viewer",
        "📊",
        ui::HTML,
        ui::CSS,
        ui::JS,
        Some(ws_handler),
    )
    // Vendored so the viewer works offline (no CDN dependency).
    .with_asset(
        "chart.umd.min.js",
        include_bytes!("../static/vendor/chart.umd.min.js"),
        "application/javascript",
    )
    .with_asset(
        "chartjs-plugin-zoom.min.js",
        include_bytes!("../static/vendor/chartjs-plugin-zoom.min.js"),
        "application/javascript",
    );
    embsim_ui::register_view(view);
}

/// WebSocket handler factory — matches the `embsim_ui::WsHandler` signature.
fn ws_handler(socket: WebSocket) -> Pin<Box<dyn Future<Output = ()> + Send>> {
    Box::pin(handle_ws(socket))
}

/// Handle a WebSocket connection.
async fn handle_ws(mut socket: WebSocket) {
    info!("Trace viewer client connected");

    let mut last_catalog_version: u64 = 0;
    let mut subscribed: HashSet<String> = HashSet::new();
    let mut cursors: HashMap<String, usize> = HashMap::new();

    loop {
        // Non-blocking receive with 100ms timeout
        match tokio::time::timeout(
            std::time::Duration::from_millis(100),
            socket.recv(),
        )
        .await
        {
            Ok(Some(Ok(Message::Close(_)))) | Ok(None) => {
                info!("Trace viewer client disconnected");
                return;
            }
            Ok(Some(Ok(Message::Text(text)))) => {
                // Parse client commands
                if let Ok(cmd) = serde_json::from_str::<serde_json::Value>(&text) {
                    match cmd.get("cmd").and_then(|v| v.as_str()) {
                        Some("subscribe") => {
                            if let Some(signals) = cmd.get("signals").and_then(|v| v.as_array()) {
                                for s in signals {
                                    if let Some(name) = s.as_str() {
                                        subscribed.insert(name.to_string());
                                    }
                                }
                            }
                        }
                        Some("unsubscribe") => {
                            if let Some(signals) = cmd.get("signals").and_then(|v| v.as_array()) {
                                for s in signals {
                                    if let Some(name) = s.as_str() {
                                        subscribed.remove(name);
                                        cursors.remove(name);
                                    }
                                }
                            }
                        }
                        Some("browse_firmware") => {
                            let fw_catalog = recorder::firmware_catalog();
                            let enum_defs = recorder::enum_definitions();
                            // Convert enum defs to a JSON-friendly format:
                            // { "type_name": { "0": "VARIANT_A", "1": "VARIANT_B", ... } }
                            let enum_maps: HashMap<String, HashMap<String, String>> = enum_defs
                                .into_iter()
                                .map(|(type_name, variants)| {
                                    let map: HashMap<String, String> = variants
                                        .into_iter()
                                        .map(|(name, val)| (val.to_string(), name))
                                        .collect();
                                    (type_name, map)
                                })
                                .collect();
                            let msg = serde_json::json!({
                                "firmware_catalog": fw_catalog,
                                "enum_definitions": enum_maps,
                            });
                            if let Ok(json) = serde_json::to_string(&msg) {
                                if socket.send(Message::Text(json.into())).await.is_err() {
                                    info!("Trace viewer client disconnected (send error)");
                                    return;
                                }
                            }
                        }
                        Some("add_signal") => {
                            if let Some(name) = cmd.get("signal").and_then(|v| v.as_str()) {
                                if recorder::activate_firmware_signal(name) {
                                    // Auto-subscribe the client to the newly added signal
                                    subscribed.insert(name.to_string());
                                }
                            }
                        }
                        Some("remove_signal") => {
                            if let Some(name) = cmd.get("signal").and_then(|v| v.as_str()) {
                                subscribed.remove(name);
                                cursors.remove(name);
                                recorder::deactivate_signal(name);
                            }
                        }
                        Some("set_poll_interval") => {
                            if let Some(ms) = cmd.get("interval_ms").and_then(|v| v.as_u64()) {
                                recorder::set_poll_interval_us(ms * 1000);
                                // Acknowledge back to client
                                let actual_ms = recorder::poll_interval_us() / 1000;
                                let ack = serde_json::json!({ "poll_interval_ms": actual_ms });
                                if let Ok(json) = serde_json::to_string(&ack) {
                                    let _ = socket.send(Message::Text(json.into())).await;
                                }
                            }
                        }
                        _ => {}
                    }
                }
            }
            _ => {} // Timeout or other message types
        }

        // Check if catalog changed (new signals registered)
        let current_catalog_version = recorder::catalog_version();
        if current_catalog_version != last_catalog_version {
            last_catalog_version = current_catalog_version;
            let catalog = recorder::catalog();
            let msg = serde_json::json!({ "catalog": catalog });
            if let Ok(json) = serde_json::to_string(&msg) {
                if socket.send(Message::Text(json.into())).await.is_err() {
                    info!("Trace viewer client disconnected (send error)");
                    return;
                }
            }
        }

        // Send incremental data for subscribed signals
        if !subscribed.is_empty() {
            let sub_vec: Vec<String> = subscribed.iter().cloned().collect();
            let (new_data, new_cursors) = recorder::read_new_samples(&sub_vec, &cursors);
            cursors = new_cursors;

            // Always send current_time_us so the client can extend charts
            // to the current time even when signal values haven't changed.
            let current_time_us = virtual_clock::virtual_us();
            let msg = serde_json::json!({
                "data": new_data,
                "current_time_us": current_time_us,
            });
            if let Ok(json) = serde_json::to_string(&msg) {
                if socket.send(Message::Text(json.into())).await.is_err() {
                    info!("Trace viewer client disconnected (send error)");
                    return;
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex as StdMutex;

    /// `register_view` mutates the process-global embsim-ui registry; serialize
    /// against it so a parallel test can't observe a half-built registry.
    static TEST_LOCK: StdMutex<()> = StdMutex::new(());

    fn lock_or_recover() -> std::sync::MutexGuard<'static, ()> {
        TEST_LOCK.lock().unwrap_or_else(|p| {
            TEST_LOCK.clear_poison();
            p.into_inner()
        })
    }

    /// register_view() installs a 'trace' view into the embsim-ui registry
    /// without panicking. The registry's contents are private to embsim-ui, so
    /// (per the assignment) we can only assert that the call succeeds and that
    /// re-registering after a clear is also fine.
    #[test]
    fn register_view_does_not_panic() {
        let _g = lock_or_recover();
        embsim_ui::clear_views();
        super::register_view();
        // Re-registering after another clear must also be safe.
        embsim_ui::clear_views();
        super::register_view();
        // Leave the registry clean for any other view-touching test.
        embsim_ui::clear_views();
    }

    /// The WebSocket message loop (`handle_ws`) requires a live WebSocket peer
    /// and is integration-level; it is intentionally not unit-tested here.
    /// We can at least assert the handler factory matches the registry's
    /// `WsHandler` fn-pointer signature (a compile-time guarantee), without
    /// invoking it.
    #[test]
    fn ws_handler_factory_matches_registry_signature() {
        let handler: embsim_ui::WsHandler = super::ws_handler;
        // Use the binding so it isn't optimized away / flagged unused.
        assert_eq!(handler as *const () as usize, super::ws_handler as *const () as usize);
    }
}
