//! embsim-trace — Live trace recording and web-based visualization.
//!
//! Records timestamped signal values from model callbacks, peripheral state,
//! and C firmware variables. Provides a browser-based trace viewer as an
//! `embsim-ui` view plugin.
//!
//! # Usage
//!
//! ```rust,ignore
//! use embsim_trace::{self, Signal, groups};
//!
//! // Register trace view with embsim-ui (call before start_server)
//! embsim_trace::register_view();
//!
//! // Start the shared UI server
//! embsim_ui::start_server(3000);
//!
//! // Register signals (groups are free-form strings; `groups` has conventions)
//! embsim_trace::register(Signal::new("motor.position", groups::MODEL));
//!
//! // Record values from callbacks — this updates the signal's LATEST value.
//! embsim_trace::record("motor.position", 12.345);
//!
//! // Provide firmware DWARF info for on-demand C variable discovery
//! let fw = embsim_memory_inspect::FirmwareInfo::from_archive("libfirmware.a").unwrap();
//! embsim_trace::set_firmware_info(&fw);
//!
//! // Start the poller — THIS is what turns `record()` calls and C variables
//! // into the time-series the viewer plots. Without it there is no trace.
//! embsim_trace::spawn_poller(&fw);
//! ```

mod recorder;
#[cfg(feature = "web")]
mod server;
#[cfg(feature = "web")]
mod ui;

pub use recorder::{
    Signal, groups, CVariableWatch, FirmwareVariable,
    record, record_at, register, register_c_variable,
    c_watches, catalog, catalog_version, read_new_samples,
    set_firmware_info, firmware_catalog, enum_definitions,
    activate_firmware_signal, deactivate_signal,
    poll_interval_us, set_poll_interval_us, resample_all, spawn_poller, clear,
};
#[cfg(feature = "web")]
pub use server::register_view;
