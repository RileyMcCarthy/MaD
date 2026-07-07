//! models — MaD tensile-tester physics models.
//!
//! Project-specific physics for the MaD uniaxial tensile tester, built on the
//! generic embsim framework. These model the machine-level mechanics that are
//! NOT reusable across projects:
//! - [`gantry`] — carriage position → sample extension + travel limits
//! - [`sample`] — material model (extension → force, `F = E·A/L₀`)
//! - [`strain_gauge`] — load-cell force → output voltage
//!
//! Device/IC-level models that *are* reusable (e.g. the ADS122U04 ADC) and
//! shared primitives (e.g. `EdgeDetector`) live in the generic `embsim-models`
//! crate; this crate depends on them.

pub mod gantry;
pub mod sample;
pub mod strain_gauge;
