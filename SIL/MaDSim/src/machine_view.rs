//! Machine visualizer — WebSocket handler and view registration.
//!
//! Reuses the embsim-trace recorder for model/peripheral signal data
//! (position, force, endstops, etc.) and adds GPIO state snapshots
//! plus firmware C variable state polling.
//!
//! Protocol (server → client):
//!   { "data": { "signal_name": [{ time_us, value }, ...] } }  — trace samples
//!   { "gpio": { esd_upper, esd_lower, ... } }                 — GPIO snapshot
//!   { "firmware": { state, fault, restriction, ... } }         — firmware state
//!
//! Protocol (client → server):
//!   { "cmd": "subscribe", "signals": ["name1", ...] }
//!
//! GPIO is read through the MCU's own [`PeripheralInstance`], not the `gpio::`
//! free functions: the firmware runs in owned-execution mode on the `P2EVAL`
//! component's instance (see `system_description.rs`) and these snapshots run
//! on unbound tokio worker threads, which would resolve to the process-default
//! instance and report a permanently all-false machine.

use crate::machine_ui;
use axum::extract::ws::{Message, WebSocket};
use embsim_peripherals::instance::PeripheralInstance;
use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use tracing::info;

/// GPIO channel indices — set once at init from firmware DWARF info.
struct GpioChannels {
    esd_upper: usize,
    esd_lower: usize,
    esd_switch: usize,
    esd_power: usize,
    endstop_upper: usize,
    endstop_lower: usize,
    endstop_door: usize,
    charge_pump: usize,
    servo_ready: usize,
}

static GPIO_CHANNELS: std::sync::OnceLock<GpioChannels> = std::sync::OnceLock::new();
static FIRMWARE_INFO: std::sync::OnceLock<embsim_memory_inspect::FirmwareInfo> =
    std::sync::OnceLock::new();
/// The MCU instance whose GPIO bank this view reports (see the module docs).
static MCU: std::sync::OnceLock<Arc<PeripheralInstance>> = std::sync::OnceLock::new();

/// Initialize the machine view with GPIO channel mappings and the peripheral
/// instance the firmware runs against. Must be called before the server starts.
pub fn init(fw: &embsim_memory_inspect::FirmwareInfo, mcu: Arc<PeripheralInstance>) {
    FIRMWARE_INFO.get_or_init(|| fw.clone());
    MCU.get_or_init(|| mcu);
    GPIO_CHANNELS.get_or_init(|| GpioChannels {
        esd_upper: fw.enum_channel("HAL_GPIO_ESD_UPPER"),
        esd_lower: fw.enum_channel("HAL_GPIO_ESD_LOWER"),
        esd_switch: fw.enum_channel("HAL_GPIO_ESD_SWITCH"),
        esd_power: fw.enum_channel("HAL_GPIO_ESD_POWER"),
        endstop_upper: fw.enum_channel("HAL_GPIO_ENDSTOP_UPPER"),
        endstop_lower: fw.enum_channel("HAL_GPIO_ENDSTOP_LOWER"),
        endstop_door: fw.enum_channel("HAL_GPIO_ENDSTOP_DOOR"),
        charge_pump: fw.enum_channel("HAL_GPIO_CHARGE_PUMP"),
        servo_ready: fw.enum_channel("HAL_GPIO_SERVO_RDY"),
    });
}

/// Register the machine visualizer view with embsim-ui.
pub fn register_view() {
    embsim_ui::register_view(embsim_ui::View::new(
        "machine",
        "Machine",
        "🔧",
        machine_ui::HTML,
        machine_ui::CSS,
        machine_ui::JS,
        Some(ws_handler),
    ));
}

fn ws_handler(socket: WebSocket) -> Pin<Box<dyn Future<Output = ()> + Send>> {
    Box::pin(handle_ws(socket))
}

/// Read current GPIO state as a JSON-friendly snapshot.
fn gpio_snapshot() -> serde_json::Value {
    let ch = GPIO_CHANNELS.get().expect("machine_view not initialized");
    let gpio = &MCU.get().expect("machine_view not initialized").gpio;
    serde_json::json!({
        "esd_upper": gpio.get_active(ch.esd_upper),
        "esd_lower": gpio.get_active(ch.esd_lower),
        "esd_switch": gpio.get_active(ch.esd_switch),
        "esd_power": gpio.get_active(ch.esd_power),
        "endstop_upper": gpio.get_active(ch.endstop_upper),
        "endstop_lower": gpio.get_active(ch.endstop_lower),
        "endstop_door": gpio.get_active(ch.endstop_door),
        "charge_pump": gpio.get_active(ch.charge_pump),
        "servo_ready": gpio.get_active(ch.servo_ready),
    })
}

/// Read firmware state from C variables via memory-inspect.
fn firmware_state_snapshot(
    resolver: &embsim_memory_inspect::SymbolResolver,
    fw: &embsim_memory_inspect::FirmwareInfo,
) -> serde_json::Value {
    let read_i32 = |var: &str, field: &str| -> Option<i32> {
        unsafe { resolver.read_field_as_f64(fw, var, field) }.map(|v| v as i32)
    };
    let read_bool = |var: &str, field: &str| -> Option<bool> {
        unsafe { resolver.read_field_as_f64(fw, var, field) }.map(|v| v != 0.0)
    };

    let state = read_i32("app_control_data", "state");
    let fault = read_i32("app_control_data", "faultedReason");
    let restriction = read_i32("app_control_data", "restrictedReason");
    let motion_enabled = read_bool("app_control_data", "motionEnabled");
    let test_running = read_bool("app_control_data", "testRunning");

    serde_json::json!({
        "state": state,
        "fault": fault,
        "restriction": restriction,
        "motion_enabled": motion_enabled,
        "test_running": test_running,
    })
}

async fn handle_ws(mut socket: WebSocket) {
    info!("Machine visualizer client connected");

    let mut subscribed: HashSet<String> = HashSet::new();
    let mut cursors: HashMap<String, usize> = HashMap::new();

    // Try to create a symbol resolver for firmware state reading
    let resolver = embsim_memory_inspect::SymbolResolver::new().ok();
    let fw = FIRMWARE_INFO.get();

    loop {
        // Non-blocking receive with 100ms timeout (sends updates at ~10Hz)
        match tokio::time::timeout(std::time::Duration::from_millis(100), socket.recv()).await {
            Ok(Some(Ok(Message::Close(_)))) | Ok(None) => {
                info!("Machine visualizer client disconnected");
                return;
            }
            Ok(Some(Ok(Message::Text(text)))) => {
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
                        _ => {}
                    }
                }
            }
            _ => {} // Timeout or other
        }

        // Build combined update message
        let mut update = serde_json::Map::new();

        // Trace data for subscribed signals
        if !subscribed.is_empty() {
            let sub_vec: Vec<String> = subscribed.iter().cloned().collect();
            let (new_data, new_cursors) = embsim_trace::read_new_samples(&sub_vec, &cursors);
            cursors = new_cursors;
            update.insert("data".to_string(), serde_json::json!(new_data));
        }

        // GPIO snapshot (always sent)
        update.insert("gpio".to_string(), gpio_snapshot());

        // Firmware state (if resolver available)
        if let (Some(r), Some(f)) = (&resolver, &fw) {
            update.insert("firmware".to_string(), firmware_state_snapshot(r, f));
        }

        let msg = serde_json::Value::Object(update);
        if let Ok(json) = serde_json::to_string(&msg) {
            if socket.send(Message::Text(json.into())).await.is_err() {
                info!("Machine visualizer client disconnected (send error)");
                return;
            }
        }
    }
}
