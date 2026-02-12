//! embsim-trace — Live trace recording and web-based visualization.
//!
//! Records timestamped signal values from model callbacks, peripheral state,
//! and C firmware variables. Provides a browser-based trace viewer as an
//! `embsim-ui` view plugin.
//!
//! # Usage
//!
//! ```rust,ignore
//! use embsim_trace::{self, Signal, SignalGroup};
//!
//! // Register trace view with embsim-ui (call before start_server)
//! embsim_trace::register_view();
//!
//! // Start the shared UI server
//! embsim_ui::start_server(3000);
//!
//! // Register model/peripheral signals (always active)
//! embsim_trace::register(Signal::new("stepper.position_mm", SignalGroup::Model));
//!
//! // Record values from callbacks
//! embsim_trace::record("stepper.position_mm", 12.345);
//!
//! // Provide firmware DWARF info for on-demand C variable discovery
//! let fw = embsim_memory_inspect::FirmwareInfo::from_archive("libfirmware.a").unwrap();
//! embsim_trace::set_firmware_info(&fw);
//! // C variables are activated on-demand from the UI, not at startup.
//! ```

mod recorder;
mod server;
mod ui;

pub use recorder::{
    Signal, SignalGroup, CVariableWatch, FirmwareVariable,
    record, record_at, register, register_c_variable,
    c_watches, catalog, catalog_version, read_new_samples,
    set_firmware_info, firmware_catalog, enum_definitions,
    activate_firmware_signal, deactivate_signal,
    poll_interval_us, set_poll_interval_us, resample_all,
};
pub use server::register_view;
