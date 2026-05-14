//! Trace recorder — global signal store with timestamped samples.
//!
//! The store keeps ALL data server-side. Each client tracks its own read
//! cursor per-signal so the server only sends new samples.
//!
//! ## Signal lifecycle
//!
//! **Model / Peripheral signals** — registered at startup from wiring.rs via
//! `register()`, immediately available for subscribing.
//!
//! **Firmware (C) signals** — discovered lazily from DWARF debug info. The
//! full set of available firmware variables is stored in a separate catalog
//! (`FirmwareVarCatalog`). When the UI requests one, it gets registered for
//! polling and added to the active signal store.

use embsim_core::virtual_clock;
use embsim_memory_inspect::{FirmwareInfo, TypeInfo};
use parking_lot::RwLock;
use serde::Serialize;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::OnceLock;

/// Default poll interval in virtual microseconds (10ms = 10_000µs).
const DEFAULT_POLL_INTERVAL_US: u64 = 10_000;

/// Configurable poll interval for C variable sampling (virtual µs).
static POLL_INTERVAL_US: AtomicU64 = AtomicU64::new(DEFAULT_POLL_INTERVAL_US);

/// Signal grouping for UI organization.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum SignalGroup {
    /// Rust model outputs (stepper, sample, strain gauge, etc.)
    Model,
    /// MCU peripheral state (GPIO, encoder, pulse_out, etc.)
    Peripheral,
    /// C firmware variables read via memory-inspect
    Firmware,
}

/// Signal metadata (active signal being traced).
#[derive(Debug, Clone, Serialize)]
pub struct Signal {
    /// Unique signal name (e.g., "stepper.position_mm")
    pub name: String,
    /// Display group
    pub group: SignalGroup,
    /// Unit label (e.g., "mm", "N", "bool")
    pub unit: String,
}

impl Signal {
    /// Create a new signal with automatic unit detection.
    pub fn new(name: &str, group: SignalGroup) -> Self {
        let unit = guess_unit(name);
        Self {
            name: name.to_string(),
            group,
            unit,
        }
    }

    /// Create a signal with an explicit unit.
    pub fn with_unit(name: &str, group: SignalGroup, unit: &str) -> Self {
        Self {
            name: name.to_string(),
            group,
            unit: unit.to_string(),
        }
    }
}

/// A timestamped sample point.
#[derive(Debug, Clone, Serialize)]
pub struct Sample {
    /// Virtual time in microseconds since boot.
    pub time_us: u64,
    /// Signal value (all values stored as f64).
    pub value: f64,
}

/// Per-signal data with a monotonic write counter for cursor tracking.
///
/// Writers (event sources) call [`record`] which only updates `latest_value`.
/// The `samples` ring buffer is written exclusively by [`resample_all`] at the
/// configured trace poll cadence, so trace volume is bounded by `signals × poll_rate`
/// regardless of how fast event sources emit. [`record_at`] bypasses this and
/// writes directly to `samples` (used for batch imports / replay).
struct SignalData {
    samples: Vec<Sample>,
    /// Total samples ever written (monotonic, does not decrease on ring eviction).
    total_written: usize,
    /// Most recent value pushed via `record()`. `None` until the first call.
    /// `resample_all()` reads this to append a periodic time-series sample.
    latest_value: Option<f64>,
}

impl SignalData {
    fn new() -> Self {
        Self {
            samples: Vec::new(),
            total_written: 0,
            latest_value: None,
        }
    }
}

/// A C variable to poll periodically.
#[derive(Debug, Clone)]
pub struct CVariableWatch {
    /// C variable name (e.g., "app_control_data")
    pub var_name: String,
    /// Field path within the struct (e.g., "state")
    pub field_path: String,
    /// Signal name used in the trace store
    pub signal_name: String,
}

/// An available (but not yet active) firmware variable leaf.
#[derive(Debug, Clone, Serialize)]
pub struct FirmwareVariable {
    /// Signal name as shown in UI (e.g., "app_control_data.state")
    pub signal_name: String,
    /// C variable name (e.g., "app_control_data")
    pub var_name: String,
    /// Field path within the struct (e.g., "state"), empty for top-level primitives
    pub field_path: String,
    /// If this variable is an enum, the type name (e.g., "app_control_state_E")
    #[serde(skip_serializing_if = "Option::is_none")]
    pub enum_type: Option<String>,
}

/// Global trace store.
struct TraceStore {
    /// Signal metadata: name → Signal
    signals: HashMap<String, Signal>,
    /// Signal ordering (insertion order for stable UI layout)
    signal_order: Vec<String>,
    /// Time-series data: signal_name → SignalData
    data: HashMap<String, SignalData>,
    /// Maximum samples per signal (ring buffer behavior)
    max_samples: usize,
    /// C variables currently being polled
    c_watches: Vec<CVariableWatch>,
    /// Monotonic version for catalog changes (new signals registered)
    catalog_version: u64,
    /// All available firmware variables (discovered from DWARF, not yet active)
    firmware_catalog: Vec<FirmwareVariable>,
    /// Enum type definitions: type_name → [(variant_name, value), ...]
    enum_definitions: HashMap<String, Vec<(String, i64)>>,
}

impl TraceStore {
    fn new() -> Self {
        Self {
            signals: HashMap::new(),
            signal_order: Vec::new(),
            data: HashMap::new(),
            max_samples: 100_000,
            c_watches: Vec::new(),
            catalog_version: 0,
            firmware_catalog: Vec::new(),
            enum_definitions: HashMap::new(),
        }
    }
}

/// Global singleton.
static STORE: OnceLock<RwLock<TraceStore>> = OnceLock::new();

fn store() -> &'static RwLock<TraceStore> {
    STORE.get_or_init(|| RwLock::new(TraceStore::new()))
}

// ============================================================
// Public API
// ============================================================

/// Register a signal for tracing. Must be called before recording.
pub fn register(signal: Signal) {
    let mut s = store().write();
    let name = signal.name.clone();
    if !s.signals.contains_key(&name) {
        s.signal_order.push(name.clone());
        s.data.insert(name.clone(), SignalData::new());
    }
    s.signals.insert(name, signal);
    s.catalog_version += 1;
}

/// Update a signal's latest value. Cheap and idempotent — does NOT append to
/// the time-series ring. Time-series samples are produced exclusively by the
/// periodic [`resample_all`] poller at the configured trace cadence, so
/// high-frequency callers (e.g. `pulse_out::on_progress` at multi-kHz)
/// cannot blow up trace storage or push the UI past its poll budget.
///
/// Trade-off: edge events (GPIO toggles, state transitions) are timestamped to
/// the next poll boundary rather than the exact event time, with up to one
/// poll interval (~10 ms) of slop. That's invisible for human-readable
/// debugging visualization. If you need exact event timing, use [`record_at`].
pub fn record(signal_name: &str, value: f64) {
    let mut s = store().write();
    if let Some(sd) = s.data.get_mut(signal_name) {
        sd.latest_value = Some(value);
    }
}

/// Record a sample with an explicit timestamp, writing directly to the
/// time-series ring. Used for batch imports / replay where the original
/// timestamp matters and back-pressure is the caller's concern.
pub fn record_at(signal_name: &str, time_us: u64, value: f64) {
    let mut s = store().write();
    let max = s.max_samples;
    if let Some(sd) = s.data.get_mut(signal_name) {
        if sd.samples.len() >= max {
            sd.samples.remove(0);
        }
        sd.samples.push(Sample { time_us, value });
        sd.total_written += 1;
        sd.latest_value = Some(value);
    }
}

/// Register a C firmware variable for periodic polling (called on-demand from UI).
pub fn register_c_variable(var_name: &str, field_path: &str, group: SignalGroup) {
    let signal_name = if field_path.is_empty() {
        var_name.to_string()
    } else {
        format!("{}.{}", var_name, field_path)
    };
    // Don't re-register if already active
    {
        let s = store().read();
        if s.signals.contains_key(&signal_name) {
            return;
        }
    }
    register(Signal::with_unit(&signal_name, group, ""));
    let mut s = store().write();
    s.c_watches.push(CVariableWatch {
        var_name: var_name.to_string(),
        field_path: field_path.to_string(),
        signal_name,
    });
}

/// Get the current poll interval in virtual microseconds.
pub fn poll_interval_us() -> u64 {
    POLL_INTERVAL_US.load(Ordering::Relaxed)
}

/// Set the poll interval in virtual microseconds. Clamped to [1_000, 1_000_000] (1ms–1s).
pub fn set_poll_interval_us(us: u64) {
    let clamped = us.clamp(1_000, 1_000_000);
    POLL_INTERVAL_US.store(clamped, Ordering::Relaxed);
    tracing::info!("Trace poll interval set to {}µs ({}ms)", clamped, clamped / 1000);
}

/// Snapshot the latest cached value of every registered signal into the
/// time-series ring at the current virtual time. This is the **only** writer
/// to the ring under the cache-and-snapshot model: event sources (Model,
/// Peripheral, and Firmware C-variable polls alike) push values into
/// `latest_value` via [`record`], and this function — driven by the trace
/// poll thread at [`POLL_INTERVAL_US`] cadence — writes them as samples.
///
/// Signals that have never received a `record()` call (no `latest_value`)
/// are skipped so the chart doesn't get spurious leading zeroes.
pub fn resample_all() {
    let time_us = virtual_clock::virtual_us();
    let mut s = store().write();
    let max = s.max_samples;
    let names: Vec<String> = s.signal_order.clone();
    for name in &names {
        if let Some(sd) = s.data.get_mut(name) {
            if let Some(value) = sd.latest_value {
                if sd.samples.len() >= max {
                    sd.samples.remove(0);
                }
                sd.samples.push(Sample { time_us, value });
                sd.total_written += 1;
            }
        }
    }
}

/// Get the current catalog version (bumped when new signals are registered).
pub fn catalog_version() -> u64 {
    store().read().catalog_version
}

/// Get the full signal catalog (only active/registered signals).
pub fn catalog() -> Vec<Signal> {
    let s = store().read();
    s.signal_order
        .iter()
        .filter_map(|name| s.signals.get(name).cloned())
        .collect()
}

/// Get new samples for a set of subscribed signals since each signal's cursor.
///
/// Cursors track `total_written` (monotonic), so ring-buffer eviction is handled
/// correctly — if the cursor is behind the eviction frontier, we send all
/// currently available samples.
pub fn read_new_samples(
    subscribed: &[String],
    cursors: &HashMap<String, usize>,
) -> (HashMap<String, Vec<Sample>>, HashMap<String, usize>) {
    let s = store().read();
    let mut data_out: HashMap<String, Vec<Sample>> = HashMap::new();
    let mut new_cursors: HashMap<String, usize> = cursors.clone();

    for name in subscribed {
        if let Some(sd) = s.data.get(name) {
            let cursor = cursors.get(name).copied().unwrap_or(0);
            let total = sd.total_written;
            if total > cursor {
                let new_count = total - cursor;
                let available = sd.samples.len();
                // If ring buffer evicted some, we can only send what's still in the buffer
                let send_count = new_count.min(available);
                let start = available - send_count;
                let new_samples: Vec<Sample> = sd.samples[start..].to_vec();
                data_out.insert(name.clone(), new_samples);
            }
            new_cursors.insert(name.clone(), total);
        }
    }

    (data_out, new_cursors)
}

/// Get the list of registered C variable watches.
pub fn c_watches() -> Vec<CVariableWatch> {
    store().read().c_watches.clone()
}

// ============================================================
// Firmware variable discovery (DWARF-based)
// ============================================================

/// Parse firmware DWARF info and build the catalog of available C variables.
/// Called once at startup. Does NOT register any signals — they are added
/// on-demand when the user selects them in the UI.
pub fn set_firmware_info(fw: &FirmwareInfo) {
    let mut catalog: Vec<FirmwareVariable> = Vec::new();
    for (var_name, var_info) in &fw.variables {
        // Skip compiler-generated or internal variables
        if var_name.starts_with('_') {
            continue;
        }
        walk_type_fields(fw, var_name, "", &var_info.type_info, 0, &mut catalog);
    }
    catalog.sort_by(|a, b| a.signal_name.cmp(&b.signal_name));
    let count = catalog.len();

    // Collect enum definitions referenced by any catalog entry
    let mut enum_defs: HashMap<String, Vec<(String, i64)>> = HashMap::new();
    for fv in &catalog {
        if let Some(ref enum_type) = fv.enum_type {
            if !enum_defs.contains_key(enum_type) {
                if let Some(enum_info) = fw.enums.get(enum_type) {
                    enum_defs.insert(enum_type.clone(), enum_info.variants.clone());
                }
            }
        }
    }
    let enum_count = enum_defs.len();

    let mut s = store().write();
    s.firmware_catalog = catalog;
    s.enum_definitions = enum_defs;
    drop(s);
    tracing::info!("Discovered {} available firmware variables ({} enum types)", count, enum_count);
}

/// Get the list of all available (but not necessarily active) firmware variables.
pub fn firmware_catalog() -> Vec<FirmwareVariable> {
    store().read().firmware_catalog.clone()
}

/// Get enum definitions for all enum types used by firmware variables.
/// Returns a map of type_name → [(variant_name, variant_value), ...].
pub fn enum_definitions() -> HashMap<String, Vec<(String, i64)>> {
    store().read().enum_definitions.clone()
}

/// Activate a firmware variable by signal name. Returns true if found and activated.
pub fn activate_firmware_signal(signal_name: &str) -> bool {
    let entry = {
        let s = store().read();
        // Already active?
        if s.signals.contains_key(signal_name) {
            return true;
        }
        s.firmware_catalog
            .iter()
            .find(|v| v.signal_name == signal_name)
            .cloned()
    };
    if let Some(fv) = entry {
        register_c_variable(&fv.var_name, &fv.field_path, SignalGroup::Firmware);
        true
    } else {
        false
    }
}

/// Remove (deactivate) an active signal by name. Returns true if it was active.
pub fn deactivate_signal(signal_name: &str) -> bool {
    let mut s = store().write();
    if s.signals.remove(signal_name).is_some() {
        s.signal_order.retain(|n| n != signal_name);
        s.data.remove(signal_name);
        s.c_watches.retain(|w| w.signal_name != signal_name);
        s.catalog_version += 1;
        true
    } else {
        false
    }
}

// ============================================================
// Internal: DWARF type walker
// ============================================================

/// Returns true if this TypeInfo is a char type (signed or unsigned 1-byte char).
fn is_char_type(ti: &TypeInfo) -> bool {
    matches!(ti, TypeInfo::Base { name, byte_size, .. } if *byte_size == 1 && name.contains("char"))
}

/// Recursively walk struct fields and collect leaf fields.
fn walk_type_fields(
    fw: &FirmwareInfo,
    var_name: &str,
    field_prefix: &str,
    type_info: &TypeInfo,
    depth: usize,
    catalog: &mut Vec<FirmwareVariable>,
) {
    const MAX_DEPTH: usize = 3;
    if depth > MAX_DEPTH {
        return;
    }

    match type_info {
        TypeInfo::Base { name, byte_size, .. } => {
            if name.contains("char") {
                return;
            }
            if [1, 2, 4, 8].contains(byte_size) {
                let (signal_name, field_path) = if field_prefix.is_empty() {
                    (var_name.to_string(), String::new())
                } else {
                    (format!("{}.{}", var_name, field_prefix), field_prefix.to_string())
                };
                catalog.push(FirmwareVariable {
                    signal_name,
                    var_name: var_name.to_string(),
                    field_path,
                    enum_type: None,
                });
            }
        }
        TypeInfo::Enum { type_name, byte_size } => {
            if [1, 2, 4, 8].contains(byte_size) {
                let (signal_name, field_path) = if field_prefix.is_empty() {
                    (var_name.to_string(), String::new())
                } else {
                    (format!("{}.{}", var_name, field_prefix), field_prefix.to_string())
                };
                catalog.push(FirmwareVariable {
                    signal_name,
                    var_name: var_name.to_string(),
                    field_path,
                    enum_type: Some(type_name.clone()),
                });
            }
        }
        TypeInfo::Struct { type_name, .. } => {
            if let Some(struct_info) = fw.structs.get(type_name) {
                for field in &struct_info.fields {
                    let path = if field_prefix.is_empty() {
                        field.name.clone()
                    } else {
                        format!("{}.{}", field_prefix, field.name)
                    };
                    walk_type_fields(fw, var_name, &path, &field.type_info, depth + 1, catalog);
                }
            }
        }
        TypeInfo::Array { element_type, count: arr_count } => {
            if is_char_type(element_type) {
                return;
            }
            if *arr_count <= 16 {
                for i in 0..*arr_count {
                    let path = if field_prefix.is_empty() {
                        format!("[{}]", i)
                    } else {
                        format!("{}[{}]", field_prefix, i)
                    };
                    walk_type_fields(fw, var_name, &path, element_type, depth + 1, catalog);
                }
            }
        }
        TypeInfo::Pointer { .. } | TypeInfo::Unknown { .. } => {}
    }
}

// ============================================================
// Internal helpers
// ============================================================

fn guess_unit(name: &str) -> String {
    let n = name.to_lowercase();
    if n.contains("_mm") || n.ends_with("position") { "mm".into() }
    else if n.contains("force") || n.contains("_n") { "N".into() }
    else if n.contains("voltage") || n.contains("_mv") { "mV".into() }
    else if n.contains("enabled") || n.contains("triggered") || n.contains("active") { "bool".into() }
    else if n.contains("steps") || n.contains("encoder") { "steps".into() }
    else if n.contains("freq") || n.contains("_hz") { "Hz".into() }
    else if n.contains("state") { "enum".into() }
    else { "".into() }
}
