//! embsim-models — Reusable hardware component models.
//!
//! These modules model real-world components (stepper motor, limit switches,
//! strain gauges, ADC ICs). They have NO knowledge of MCU drivers or HAL.
//! They communicate through callbacks: each model accepts input via setter
//! functions and fires output callbacks when state changes. The project
//! wiring layer connects these callback chains together.

pub mod ads122u04;
pub mod gantry;
pub mod limit_switch;
pub mod sample;
pub mod strain_gauge;
