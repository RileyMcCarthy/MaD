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
use std::collections::VecDeque;
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

/// Conventional signal-group names. Groups are free-form strings, so a project
/// can define its own (e.g. "Sensors", "Actuators"); these are just the ones the
/// MaD wiring and firmware discovery use. The viewer orders these first, then
/// any custom groups alphabetically.
pub mod groups {
    /// Rust hardware-model outputs (the physical components being simulated).
    pub const MODEL: &str = "Model";
    /// MCU peripheral state (GPIO, encoder, pulse_out, etc.).
    pub const PERIPHERAL: &str = "Peripheral";
    /// C firmware variables read via memory-inspect.
    pub const FIRMWARE: &str = "Firmware";
}

/// Signal metadata (active signal being traced).
#[derive(Debug, Clone, Serialize)]
pub struct Signal {
    /// Unique signal name (e.g., "motor.position")
    pub name: String,
    /// Display group — a free-form label (see [`groups`] for conventional names).
    pub group: String,
    /// Unit label (e.g., "mm", "N", "bool")
    pub unit: String,
}

impl Signal {
    /// Create a new signal with no unit label, in the given group.
    ///
    /// embsim is unit-agnostic — pass units explicitly with [`Signal::with_unit`].
    /// (Domain-specific unit guessing belongs in the consumer, not this crate.)
    pub fn new(name: &str, group: &str) -> Self {
        Self {
            name: name.to_string(),
            group: group.to_string(),
            unit: String::new(),
        }
    }

    /// Create a signal with an explicit unit.
    pub fn with_unit(name: &str, group: &str, unit: &str) -> Self {
        Self {
            name: name.to_string(),
            group: group.to_string(),
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
    /// Ring buffer of samples. `VecDeque` so front-eviction is O(1) (a `Vec`
    /// did `remove(0)`, which is O(n) on the 100k-sample buffer once full).
    samples: VecDeque<Sample>,
    /// Total samples ever written (monotonic, does not decrease on ring eviction).
    total_written: usize,
    /// Most recent value pushed via `record()`. `None` until the first call.
    /// `resample_all()` reads this to append a periodic time-series sample.
    latest_value: Option<f64>,
}

impl SignalData {
    fn new() -> Self {
        Self {
            samples: VecDeque::new(),
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

/// Reset the trace store to empty (signals, samples, firmware catalog, watches).
///
/// Used to start a fresh trace for an in-process emulator restart. The store is
/// a process-global default (one emulator per process by construction); this is
/// the lightweight reset rather than a full instance handle.
pub fn clear() {
    *store().write() = TraceStore::new();
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
            sd.samples.pop_front();
        }
        sd.samples.push_back(Sample { time_us, value });
        sd.total_written += 1;
        sd.latest_value = Some(value);
    }
}

/// Register a C firmware variable for periodic polling (called on-demand from UI).
pub fn register_c_variable(var_name: &str, field_path: &str, group: &str) {
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
                    sd.samples.pop_front();
                }
                sd.samples.push_back(Sample { time_us, value });
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
                let new_samples: Vec<Sample> = sd.samples.range(start..).cloned().collect();
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

/// Spawn the background poller that drives the trace.
///
/// `record()` only updates each signal's latest value; this thread is what
/// actually writes time-series samples (re-recording model/peripheral signals
/// and reading any activated firmware C variables) at the configured cadence.
/// Without it, the store has no time series — so a consumer that wants tracing
/// just calls this once after wiring (the emulator runtime's `on_wired` hook is
/// the natural place). Reads firmware C variables via a [`SymbolResolver`];
/// if symbol resolution is unavailable, model/peripheral resampling still runs.
pub fn spawn_poller(fw: &FirmwareInfo) {
    let fw = fw.clone();
    std::thread::Builder::new()
        .name("trace-poll".into())
        .spawn(move || poll_loop(&fw))
        .expect("Failed to start trace poll thread");
}

fn poll_loop(fw: &FirmwareInfo) {
    use embsim_memory_inspect::SymbolResolver;

    // Give the firmware a moment to initialize before resolving symbols.
    std::thread::sleep(std::time::Duration::from_millis(500));

    let resolver = match SymbolResolver::new() {
        Ok(r) => Some(r),
        Err(e) => {
            tracing::warn!("Trace C-variable polling disabled: {}", e);
            None
        }
    };

    loop {
        if let Some(resolver) = &resolver {
            for watch in c_watches() {
                let value: Option<f64> = unsafe {
                    resolver.read_field_as_f64(&fw, &watch.var_name, &watch.field_path)
                };
                if let Some(v) = value {
                    record(&watch.signal_name, v);
                }
            }
        }

        // Re-record model/peripheral signals so the trace has uniform density.
        resample_all();

        let interval_us = poll_interval_us();
        let wall_us = embsim_core::virtual_clock::virtual_to_wall_us(interval_us);
        if wall_us > 0 {
            std::thread::sleep(std::time::Duration::from_micros(wall_us));
        }
    }
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
        register_c_variable(&fv.var_name, &fv.field_path, groups::FIRMWARE);
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
        // Floats and bitfields are recordable scalars (read via read_field_as_f64).
        TypeInfo::Float { byte_size, .. } => {
            if [4, 8].contains(byte_size) {
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
        TypeInfo::Bitfield { .. } => {
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
        // Unions are stored alongside structs; recurse into their members.
        TypeInfo::Struct { type_name, .. } | TypeInfo::Union { type_name, .. } => {
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

#[cfg(test)]
mod tests {
    use super::*;
    use embsim_memory_inspect::{EnumInfo, FieldInfo, StructInfo, VariableInfo};
    use std::sync::{Mutex as StdMutex, OnceLock};

    /// The recorder STORE is a process-global singleton and several tests also
    /// touch the global POLL_INTERVAL_US atomic. Serialize every recorder test
    /// and recover from any panic-induced poisoning, exactly like pulse_out.rs.
    static TEST_LOCK: StdMutex<()> = StdMutex::new(());

    fn lock_or_recover() -> std::sync::MutexGuard<'static, ()> {
        TEST_LOCK.lock().unwrap_or_else(|p| {
            TEST_LOCK.clear_poison();
            p.into_inner()
        })
    }

    /// Reset the global store and ensure the virtual clock is initialized once
    /// (record/resample read virtual_us). We never assert on the wall clock —
    /// deterministic timestamp assertions go through record_at instead.
    fn test_setup() {
        static CLOCK: OnceLock<()> = OnceLock::new();
        CLOCK.get_or_init(|| virtual_clock::init(1.0, 180_000_000));
        clear();
        // Restore the poll interval to its default so an earlier test that set a
        // clamp value cannot bleed into a later one.
        set_poll_interval_us(DEFAULT_POLL_INTERVAL_US);
    }

    // ── Signal constructors and group constants ──

    #[test]
    fn signal_new_has_empty_unit() {
        // Signal::new leaves the unit blank — embsim is unit-agnostic.
        let s = Signal::new("motor.position", groups::MODEL);
        assert_eq!(s.name, "motor.position");
        assert_eq!(s.group, groups::MODEL);
        assert_eq!(s.unit, "");
    }

    #[test]
    fn signal_with_unit_carries_unit() {
        // with_unit records the supplied unit verbatim.
        let s = Signal::with_unit("force", groups::PERIPHERAL, "N");
        assert_eq!(s.name, "force");
        assert_eq!(s.group, groups::PERIPHERAL);
        assert_eq!(s.unit, "N");
    }

    #[test]
    fn group_constants_have_expected_labels() {
        // The conventional group labels the wiring/firmware discovery rely on.
        assert_eq!(groups::MODEL, "Model");
        assert_eq!(groups::PERIPHERAL, "Peripheral");
        assert_eq!(groups::FIRMWARE, "Firmware");
    }

    // ── register / catalog / catalog_version ──

    #[test]
    fn register_adds_to_catalog_and_bumps_version() {
        let _g = lock_or_recover();
        test_setup();
        let before = catalog_version();
        register(Signal::new("a", groups::MODEL));
        assert_eq!(catalog_version(), before + 1);
        let cat = catalog();
        assert_eq!(cat.len(), 1);
        assert_eq!(cat[0].name, "a");
    }

    #[test]
    fn reregistering_same_name_does_not_duplicate_or_reorder() {
        let _g = lock_or_recover();
        test_setup();
        register(Signal::new("a", groups::MODEL));
        register(Signal::new("b", groups::MODEL));
        // Re-register "a" with a different group — replaces metadata, no dup,
        // and "a" keeps its original ordering position.
        register(Signal::with_unit("a", groups::PERIPHERAL, "mm"));
        let cat = catalog();
        assert_eq!(cat.len(), 2, "re-registering must not duplicate the entry");
        assert_eq!(cat[0].name, "a", "ordering is preserved on re-register");
        assert_eq!(cat[1].name, "b");
        assert_eq!(cat[0].group, groups::PERIPHERAL, "metadata is updated");
        assert_eq!(cat[0].unit, "mm");
    }

    #[test]
    fn catalog_version_bumps_once_per_new_signal() {
        let _g = lock_or_recover();
        test_setup();
        let v0 = catalog_version();
        register(Signal::new("a", groups::MODEL));
        let v1 = catalog_version();
        // Re-registering an existing name still bumps the version (insert path),
        // but the catalog length stays the same.
        register(Signal::new("a", groups::MODEL));
        let v2 = catalog_version();
        assert!(v1 > v0 && v2 > v1, "version is monotonic");
        assert_eq!(catalog().len(), 1);
    }

    #[test]
    fn catalog_is_empty_after_clear() {
        let _g = lock_or_recover();
        test_setup();
        register(Signal::new("a", groups::MODEL));
        assert_eq!(catalog().len(), 1);
        clear();
        assert!(catalog().is_empty());
        assert_eq!(catalog_version(), 0, "clear resets the version too");
    }

    // ── record vs resample_all vs record_at ──

    #[test]
    fn record_only_updates_latest_and_does_not_append() {
        let _g = lock_or_recover();
        test_setup();
        register(Signal::new("a", groups::MODEL));
        record("a", 1.0);
        record("a", 2.0);
        // record() never touches the ring, so there is nothing new to read.
        let (data, _cur) = read_new_samples(&["a".to_string()], &HashMap::new());
        assert!(data.get("a").is_none(), "record must not append to the ring");
    }

    #[test]
    fn record_on_unknown_signal_is_a_no_op() {
        let _g = lock_or_recover();
        test_setup();
        // No signal registered → record silently does nothing (no panic).
        record("ghost", 9.0);
        let (data, _cur) = read_new_samples(&["ghost".to_string()], &HashMap::new());
        assert!(data.is_empty());
    }

    #[test]
    fn resample_snapshots_latest_value_into_ring() {
        let _g = lock_or_recover();
        test_setup();
        register(Signal::new("a", groups::MODEL));
        record("a", 42.0);
        resample_all();
        let (data, cursors) = read_new_samples(&["a".to_string()], &HashMap::new());
        let samples = data.get("a").expect("resample writes a sample");
        assert_eq!(samples.len(), 1);
        assert_eq!(samples[0].value, 42.0);
        assert_eq!(cursors.get("a"), Some(&1));
    }

    #[test]
    fn resample_skips_signals_without_latest_value() {
        let _g = lock_or_recover();
        test_setup();
        register(Signal::new("touched", groups::MODEL));
        register(Signal::new("untouched", groups::MODEL));
        record("touched", 7.0);
        resample_all();
        let subs = vec!["touched".to_string(), "untouched".to_string()];
        let (data, _cur) = read_new_samples(&subs, &HashMap::new());
        assert!(data.contains_key("touched"), "touched signal got a sample");
        assert!(
            !data.contains_key("untouched"),
            "a signal that never got record() must be skipped (no leading zero)"
        );
    }

    #[test]
    fn record_at_writes_directly_and_bumps_totals() {
        let _g = lock_or_recover();
        test_setup();
        register(Signal::new("a", groups::MODEL));
        record_at("a", 100, 1.5);
        record_at("a", 200, 2.5);
        let (data, cursors) = read_new_samples(&["a".to_string()], &HashMap::new());
        let samples = data.get("a").expect("record_at writes directly to the ring");
        assert_eq!(samples.len(), 2);
        assert_eq!(samples[0].time_us, 100);
        assert_eq!(samples[0].value, 1.5);
        assert_eq!(samples[1].time_us, 200);
        assert_eq!(samples[1].value, 2.5);
        assert_eq!(cursors.get("a"), Some(&2), "total_written advanced by 2");
    }

    #[test]
    fn record_at_on_unknown_signal_is_a_no_op() {
        let _g = lock_or_recover();
        test_setup();
        // Unknown signal name: nothing is written, no panic.
        record_at("ghost", 10, 1.0);
        let (data, _c) = read_new_samples(&["ghost".to_string()], &HashMap::new());
        assert!(data.is_empty());
    }

    // ── read_new_samples cursor tracking + eviction math ──

    #[test]
    fn read_new_samples_cursor_advances_then_returns_nothing_new() {
        let _g = lock_or_recover();
        test_setup();
        register(Signal::new("a", groups::MODEL));
        record_at("a", 1, 10.0);
        record_at("a", 2, 20.0);
        // First read from cursor 0 returns everything and advances the cursor.
        let (data1, cursors1) = read_new_samples(&["a".to_string()], &HashMap::new());
        assert_eq!(data1.get("a").unwrap().len(), 2);
        assert_eq!(cursors1.get("a"), Some(&2));
        // Second read with the returned cursors yields nothing new.
        let (data2, cursors2) = read_new_samples(&["a".to_string()], &cursors1);
        assert!(data2.get("a").is_none(), "no new samples since last cursor");
        assert_eq!(cursors2.get("a"), Some(&2), "cursor stays put");
    }

    #[test]
    fn read_new_samples_returns_only_the_new_ones_after_more_writes() {
        let _g = lock_or_recover();
        test_setup();
        register(Signal::new("a", groups::MODEL));
        record_at("a", 1, 10.0);
        let (_d, cursors1) = read_new_samples(&["a".to_string()], &HashMap::new());
        // Write two more, then read — only the two new samples come back.
        record_at("a", 2, 20.0);
        record_at("a", 3, 30.0);
        let (data2, cursors2) = read_new_samples(&["a".to_string()], &cursors1);
        let new = data2.get("a").unwrap();
        assert_eq!(new.len(), 2, "only the samples after the cursor");
        assert_eq!(new[0].value, 20.0);
        assert_eq!(new[1].value, 30.0);
        assert_eq!(cursors2.get("a"), Some(&3));
    }

    #[test]
    fn read_new_samples_never_returns_more_than_were_written() {
        let _g = lock_or_recover();
        test_setup();
        register(Signal::new("a", groups::MODEL));
        // send_count == min(new, available). With a normal (un-evicted) buffer
        // the count exactly equals what was written, never more, and the cursor
        // is monotonic across repeated reads.
        let mut cursors = HashMap::new();
        let mut total = 0usize;
        for i in 0..50u64 {
            record_at("a", i, i as f64);
            total += 1;
            let (data, new_cursors) = read_new_samples(&["a".to_string()], &cursors);
            let got = data.get("a").map(|v| v.len()).unwrap_or(0);
            assert_eq!(got, 1, "each loop adds exactly one new sample");
            let cur = *new_cursors.get("a").unwrap();
            assert_eq!(cur, total, "cursor tracks total_written");
            assert!(cur >= *cursors.get("a").unwrap_or(&0), "cursor is monotonic");
            cursors = new_cursors;
        }
    }

    #[test]
    fn read_new_samples_ignores_unsubscribed_and_unknown() {
        let _g = lock_or_recover();
        test_setup();
        register(Signal::new("a", groups::MODEL));
        record_at("a", 1, 1.0);
        // Subscribing to an unknown name yields no entry and no cursor.
        let (data, cursors) = read_new_samples(&["nope".to_string()], &HashMap::new());
        assert!(data.is_empty());
        assert!(cursors.get("nope").is_none());
    }

    // ── poll interval clamp ──

    #[test]
    fn poll_interval_clamps_below_min() {
        let _g = lock_or_recover();
        test_setup();
        set_poll_interval_us(0);
        assert_eq!(poll_interval_us(), 1_000, "below 1ms clamps up to 1ms");
        set_poll_interval_us(500);
        assert_eq!(poll_interval_us(), 1_000);
    }

    #[test]
    fn poll_interval_clamps_above_max() {
        let _g = lock_or_recover();
        test_setup();
        set_poll_interval_us(5_000_000);
        assert_eq!(poll_interval_us(), 1_000_000, "above 1s clamps down to 1s");
    }

    #[test]
    fn poll_interval_passes_through_in_range() {
        let _g = lock_or_recover();
        test_setup();
        set_poll_interval_us(25_000);
        assert_eq!(poll_interval_us(), 25_000);
        // Exact boundaries pass through unchanged.
        set_poll_interval_us(1_000);
        assert_eq!(poll_interval_us(), 1_000);
        set_poll_interval_us(1_000_000);
        assert_eq!(poll_interval_us(), 1_000_000);
    }

    // ── register_c_variable / c_watches ──

    #[test]
    fn register_c_variable_builds_dotted_signal_name() {
        let _g = lock_or_recover();
        test_setup();
        register_c_variable("app_control_data", "state", groups::FIRMWARE);
        let watches = c_watches();
        assert_eq!(watches.len(), 1);
        assert_eq!(watches[0].var_name, "app_control_data");
        assert_eq!(watches[0].field_path, "state");
        assert_eq!(watches[0].signal_name, "app_control_data.state");
        // The watch's signal is also registered as an active signal.
        assert!(catalog().iter().any(|s| s.name == "app_control_data.state"));
    }

    #[test]
    fn register_c_variable_empty_field_uses_bare_var_name() {
        let _g = lock_or_recover();
        test_setup();
        register_c_variable("g_counter", "", groups::FIRMWARE);
        let watches = c_watches();
        assert_eq!(watches.len(), 1);
        assert_eq!(watches[0].signal_name, "g_counter", "empty field → bare name");
        assert_eq!(watches[0].field_path, "");
    }

    #[test]
    fn register_c_variable_is_idempotent() {
        let _g = lock_or_recover();
        test_setup();
        register_c_variable("v", "f", groups::FIRMWARE);
        register_c_variable("v", "f", groups::FIRMWARE);
        // Re-registering an already-active signal adds no second watch.
        assert_eq!(c_watches().len(), 1, "duplicate watch is suppressed");
    }

    // ── deactivate_signal ──

    #[test]
    fn deactivate_signal_removes_everything_and_returns_true() {
        let _g = lock_or_recover();
        test_setup();
        register_c_variable("v", "f", groups::FIRMWARE);
        record_at("v.f", 1, 1.0);
        let before = catalog_version();
        assert!(deactivate_signal("v.f"), "active signal returns true");
        assert!(!catalog().iter().any(|s| s.name == "v.f"), "removed from catalog");
        assert!(c_watches().is_empty(), "watch removed");
        assert!(catalog_version() > before, "deactivation bumps version");
        // Data is gone too: re-subscribing returns nothing.
        let (data, _c) = read_new_samples(&["v.f".to_string()], &HashMap::new());
        assert!(data.is_empty());
    }

    #[test]
    fn deactivate_absent_signal_returns_false() {
        let _g = lock_or_recover();
        test_setup();
        let before = catalog_version();
        assert!(!deactivate_signal("nope"), "absent signal returns false");
        assert_eq!(catalog_version(), before, "no version bump for a no-op");
    }

    // ── firmware discovery: set_firmware_info / walk_type_fields / is_char_type ──

    /// Build a FirmwareInfo by hand whose single public variable is a struct
    /// covering every leaf kind walk_type_fields must classify:
    ///   - Base(int)       → INCLUDED, no enum_type
    ///   - Enum            → INCLUDED, carries enum_type
    ///   - Float           → INCLUDED
    ///   - Bitfield        → INCLUDED
    ///   - char            → EXCLUDED
    ///   - char[8] array   → EXCLUDED (is_char_type element)
    ///   - int[4] array    → INCLUDED (numeric, count <= 16)
    /// Plus a leading-underscore variable that must be skipped entirely.
    fn sample_fw() -> FirmwareInfo {
        let mut fw = FirmwareInfo::new();

        // Enum type referenced by the `mode` field.
        fw.enums.insert(
            "demo_mode_E".to_string(),
            EnumInfo {
                name: "demo_mode_E".to_string(),
                byte_size: 4,
                variants: vec![
                    ("DEMO_OFF".to_string(), 0),
                    ("DEMO_ON".to_string(), 1),
                ],
            },
        );

        // The struct describing the public variable's type.
        fw.structs.insert(
            "demo_data_S".to_string(),
            StructInfo {
                name: "demo_data_S".to_string(),
                byte_size: 64,
                fields: vec![
                    FieldInfo {
                        name: "count".to_string(),
                        offset: 0,
                        type_info: TypeInfo::Base {
                            name: "int".to_string(),
                            byte_size: 4,
                            signed: true,
                        },
                    },
                    FieldInfo {
                        name: "mode".to_string(),
                        offset: 4,
                        type_info: TypeInfo::Enum {
                            type_name: "demo_mode_E".to_string(),
                            byte_size: 4,
                        },
                    },
                    FieldInfo {
                        name: "ratio".to_string(),
                        offset: 8,
                        type_info: TypeInfo::Float {
                            name: "float".to_string(),
                            byte_size: 4,
                        },
                    },
                    FieldInfo {
                        name: "flag".to_string(),
                        offset: 12,
                        type_info: TypeInfo::Bitfield {
                            bit_offset: 0,
                            bit_size: 1,
                            storage_size: 4,
                            signed: false,
                        },
                    },
                    FieldInfo {
                        name: "letter".to_string(),
                        offset: 16,
                        type_info: TypeInfo::Base {
                            name: "char".to_string(),
                            byte_size: 1,
                            signed: true,
                        },
                    },
                    FieldInfo {
                        name: "label".to_string(),
                        offset: 17,
                        type_info: TypeInfo::Array {
                            element_type: Box::new(TypeInfo::Base {
                                name: "char".to_string(),
                                byte_size: 1,
                                signed: true,
                            }),
                            count: 8,
                        },
                    },
                    FieldInfo {
                        name: "samples".to_string(),
                        offset: 28,
                        type_info: TypeInfo::Array {
                            element_type: Box::new(TypeInfo::Base {
                                name: "int".to_string(),
                                byte_size: 4,
                                signed: true,
                            }),
                            count: 4,
                        },
                    },
                ],
            },
        );

        // Public variable of the struct type.
        fw.variables.insert(
            "demo_data".to_string(),
            VariableInfo {
                name: "demo_data".to_string(),
                type_info: TypeInfo::Struct {
                    type_name: "demo_data_S".to_string(),
                    byte_size: 64,
                },
                source_file: None,
            },
        );

        // Leading-underscore variable that must be skipped.
        fw.variables.insert(
            "_internal".to_string(),
            VariableInfo {
                name: "_internal".to_string(),
                type_info: TypeInfo::Base {
                    name: "int".to_string(),
                    byte_size: 4,
                    signed: true,
                },
                source_file: None,
            },
        );

        fw
    }

    #[test]
    fn is_char_type_matches_only_one_byte_char() {
        // Private helper: only a 1-byte type whose name contains "char".
        assert!(is_char_type(&TypeInfo::Base {
            name: "char".to_string(),
            byte_size: 1,
            signed: true,
        }));
        assert!(is_char_type(&TypeInfo::Base {
            name: "unsigned char".to_string(),
            byte_size: 1,
            signed: false,
        }));
        // A 4-byte int is not a char even though logic is similar.
        assert!(!is_char_type(&TypeInfo::Base {
            name: "int".to_string(),
            byte_size: 4,
            signed: true,
        }));
        // A 2-byte "char16" would not match the 1-byte requirement.
        assert!(!is_char_type(&TypeInfo::Base {
            name: "char16_t".to_string(),
            byte_size: 2,
            signed: false,
        }));
    }

    #[test]
    fn set_firmware_info_builds_sorted_catalog_with_expected_leaves() {
        let _g = lock_or_recover();
        test_setup();
        set_firmware_info(&sample_fw());
        let cat = firmware_catalog();
        let names: Vec<&str> = cat.iter().map(|v| v.signal_name.as_str()).collect();

        // Included scalar/enum/float/bitfield leaves.
        assert!(names.contains(&"demo_data.count"), "int field included");
        assert!(names.contains(&"demo_data.mode"), "enum field included");
        assert!(names.contains(&"demo_data.ratio"), "float field included");
        assert!(names.contains(&"demo_data.flag"), "bitfield included");
        // Numeric array (count <= 16) expands to one leaf per element.
        assert!(names.contains(&"demo_data.samples[0]"));
        assert!(names.contains(&"demo_data.samples[3]"));

        // Excluded: char scalar and char-array leaves.
        assert!(!names.contains(&"demo_data.letter"), "char scalar excluded");
        assert!(
            !names.iter().any(|n| n.starts_with("demo_data.label")),
            "char array excluded entirely"
        );
        // Excluded: leading-underscore variable.
        assert!(
            !names.iter().any(|n| n.starts_with("_internal")),
            "underscore-prefixed variable skipped"
        );

        // Catalog is sorted by signal_name.
        let mut sorted = names.clone();
        sorted.sort();
        assert_eq!(names, sorted, "firmware catalog is sorted by signal_name");
    }

    #[test]
    fn set_firmware_info_carries_enum_type_on_enum_leaves() {
        let _g = lock_or_recover();
        test_setup();
        set_firmware_info(&sample_fw());
        let cat = firmware_catalog();
        let mode = cat
            .iter()
            .find(|v| v.signal_name == "demo_data.mode")
            .expect("mode leaf exists");
        assert_eq!(mode.enum_type.as_deref(), Some("demo_mode_E"));
        // A non-enum leaf carries no enum_type.
        let count = cat
            .iter()
            .find(|v| v.signal_name == "demo_data.count")
            .unwrap();
        assert!(count.enum_type.is_none());
    }

    #[test]
    fn enum_definitions_returns_variants_of_referenced_types() {
        let _g = lock_or_recover();
        test_setup();
        set_firmware_info(&sample_fw());
        let defs = enum_definitions();
        let variants = defs.get("demo_mode_E").expect("referenced enum is collected");
        assert_eq!(
            variants,
            &vec![("DEMO_OFF".to_string(), 0), ("DEMO_ON".to_string(), 1)]
        );
    }

    #[test]
    fn set_firmware_info_field_path_is_relative_to_var() {
        let _g = lock_or_recover();
        test_setup();
        set_firmware_info(&sample_fw());
        let cat = firmware_catalog();
        let count = cat.iter().find(|v| v.signal_name == "demo_data.count").unwrap();
        assert_eq!(count.var_name, "demo_data");
        assert_eq!(count.field_path, "count", "field_path is struct-relative");
    }

    // ── activate_firmware_signal ──

    #[test]
    fn activate_firmware_signal_moves_catalog_entry_into_active() {
        let _g = lock_or_recover();
        test_setup();
        set_firmware_info(&sample_fw());
        assert!(catalog().is_empty(), "discovery does not auto-activate");
        assert!(activate_firmware_signal("demo_data.count"), "known leaf activates");
        // Now it's an active signal with a C watch.
        assert!(catalog().iter().any(|s| s.name == "demo_data.count"));
        assert!(c_watches().iter().any(|w| w.signal_name == "demo_data.count"));
    }

    #[test]
    fn activate_firmware_signal_unknown_returns_false() {
        let _g = lock_or_recover();
        test_setup();
        set_firmware_info(&sample_fw());
        assert!(!activate_firmware_signal("demo_data.nope"), "unknown leaf → false");
        assert!(c_watches().is_empty());
    }

    #[test]
    fn activate_firmware_signal_idempotent_when_already_active() {
        let _g = lock_or_recover();
        test_setup();
        set_firmware_info(&sample_fw());
        assert!(activate_firmware_signal("demo_data.mode"));
        // Second activation short-circuits on the already-active check (true),
        // and does not add a duplicate watch.
        assert!(activate_firmware_signal("demo_data.mode"));
        let n = c_watches()
            .iter()
            .filter(|w| w.signal_name == "demo_data.mode")
            .count();
        assert_eq!(n, 1, "no duplicate watch on re-activation");
    }

    // ── clear() resets everything ──

    #[test]
    fn clear_resets_signals_data_watches_and_firmware_catalog() {
        let _g = lock_or_recover();
        test_setup();
        register(Signal::new("a", groups::MODEL));
        record_at("a", 1, 1.0);
        register_c_variable("v", "f", groups::FIRMWARE);
        set_firmware_info(&sample_fw());
        // Sanity: things are populated.
        assert!(!catalog().is_empty());
        assert!(!c_watches().is_empty());
        assert!(!firmware_catalog().is_empty());
        assert!(!enum_definitions().is_empty());

        clear();

        assert!(catalog().is_empty(), "signals cleared");
        assert!(c_watches().is_empty(), "watches cleared");
        assert!(firmware_catalog().is_empty(), "firmware catalog cleared");
        assert!(enum_definitions().is_empty(), "enum defs cleared");
        assert_eq!(catalog_version(), 0, "version reset");
        let (data, _c) = read_new_samples(&["a".to_string()], &HashMap::new());
        assert!(data.is_empty(), "sample data cleared");
    }

    // ── SignalData / TraceStore defaults (pure construction) ──

    #[test]
    fn signal_data_new_starts_empty() {
        // A fresh SignalData has no samples, zero writes, and no latest value.
        let sd = SignalData::new();
        assert!(sd.samples.is_empty());
        assert_eq!(sd.total_written, 0);
        assert!(sd.latest_value.is_none());
    }

    #[test]
    fn trace_store_new_has_default_capacity_and_empty_collections() {
        // Defaults the public API depends on (100k ring, empty everything).
        let ts = TraceStore::new();
        assert_eq!(ts.max_samples, 100_000);
        assert_eq!(ts.catalog_version, 0);
        assert!(ts.signals.is_empty());
        assert!(ts.signal_order.is_empty());
        assert!(ts.data.is_empty());
        assert!(ts.c_watches.is_empty());
        assert!(ts.firmware_catalog.is_empty());
        assert!(ts.enum_definitions.is_empty());
    }
}

