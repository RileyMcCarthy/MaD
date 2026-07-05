//! embsim-models — Reusable, generic hardware component models.
//!
//! Generic device/IC-level models and shared primitives with NO knowledge of
//! any specific machine, MCU driver, or HAL:
//! - [`ads122u04`] — TI ADS122U04 UART ADC IC protocol model
//! - [`limit_switch`] — position-threshold limit switch
//! - [`edge`] — edge-detection primitive shared by threshold models
//!
//! Models communicate through [`embsim_core::event::Observers`]: each accepts
//! input via setter functions and emits output to any number of subscribers
//! when state changes. The project wiring layer connects these chains together.
//!
//! Project-specific physics (e.g. the MaD tensile tester's gantry/sample/strain
//! gauge) lives in the consumer — see the `embsim-mad-models` crate.

pub mod ads122u04;
pub mod edge;
pub mod limit_switch;
