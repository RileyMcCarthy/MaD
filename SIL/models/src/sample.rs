//! Model: Sample — material model converting extension to force.
//!
//! Simulates a test sample's mechanical response. Receives sample extension
//! updates in mm via `on_extension()` callback, calculates force in Newtons,
//! and fires `on_change` so downstream models (strain gauge) get updated.
//!
//! Has no knowledge of MCU peripherals or drivers.

use embsim_core::event::Observers;
use std::sync::{Arc, Mutex};
use tracing::trace;

// ============================================================
// Configuration
// ============================================================

/// Sample force model configuration.
#[derive(Debug, Clone)]
pub struct Config {
    /// Linear stiffness in N/mm.
    ///
    /// If `material` is provided, stiffness is derived from
    /// `E * A / L0` and this field is ignored.
    pub stiffness_n_per_mm: f64,
    /// If true, tensile motion is toward decreasing machine position (moving up).
    pub tension_on_decreasing_position: bool,
    /// Optional physically-meaningful material definition.
    pub material: Option<MaterialProperties>,
}

/// Material properties for a 1D tensile sample model.
#[derive(Debug, Clone)]
pub struct MaterialProperties {
    /// Optional label for logging/UI diagnostics.
    pub name: &'static str,
    /// Young's modulus in MPa (N/mm²).
    pub youngs_modulus_mpa: f64,
    /// Effective cross-sectional area in mm².
    pub area_mm2: f64,
    /// Gauge length in mm.
    pub gauge_length_mm: f64,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            stiffness_n_per_mm: 2.5,
            tension_on_decreasing_position: true,
            material: None,
        }
    }
}

// ============================================================
// Sample instance
// ============================================================

pub struct Sample {
    config: Config,
    /// Legacy support only: used by `on_position`.
    baseline_position_mm: Mutex<Option<f64>>,
    on_change: Observers<f64>,
}

impl Sample {
    /// Create a new sample model instance.
    pub fn new(config: Config) -> Arc<Self> {
        Arc::new(Self {
            config,
            baseline_position_mm: Mutex::new(None),
            on_change: Observers::new(),
        })
    }

    /// Subscribe to force-change updates (Newtons). Multiple subscribers allowed.
    pub fn on_change(&self, cb: impl Fn(f64) + Send + 'static) {
        self.on_change.subscribe(cb);
    }

    /// Called when sample extension changes (mm). Calculates force and fires on_change.
    pub fn on_extension(&self, extension_mm: f64) {
        let force_n = calculate_force(extension_mm, &self.config);
        trace!(
            "sample: extension={:.3}mm → force={:.3}N",
            extension_mm, force_n
        );

        self.on_change.emit(force_n);
    }

    /// Legacy convenience path: convert absolute position to extension and forward
    /// to `on_extension`. New code should compute extension in a gantry model.
    pub fn on_position(&self, position_mm: f64) {
        // Capture the first observed position as the zero-force baseline.
        let baseline = {
            let mut guard = self.baseline_position_mm.lock().unwrap();
            match *guard {
                Some(v) => v,
                None => {
                    *guard = Some(position_mm);
                    position_mm
                }
            }
        };

        let extension_mm = if self.config.tension_on_decreasing_position {
            baseline - position_mm
        } else {
            position_mm - baseline
        };
        trace!(
            "sample(legacy): pos={:.3}mm baseline={:.3}mm ext={:.3}mm",
            position_mm, baseline, extension_mm
        );
        self.on_extension(extension_mm.max(0.0));
    }
}

// ============================================================
// Internal
// ============================================================

/// Calculate force in Newtons from extension in mm.
/// Linear elastic model:
///   force = max(0, extension) * k
fn calculate_force(extension_mm: f64, config: &Config) -> f64 {
    if extension_mm <= 0.0 {
        return 0.0;
    }
    let stiffness = if let Some(material) = &config.material {
        // F = (E * A / L0) * ΔL, with E in N/mm² (MPa), A in mm², L0 in mm.
        if material.area_mm2 > 0.0 && material.gauge_length_mm > 0.0 {
            (material.youngs_modulus_mpa * material.area_mm2) / material.gauge_length_mm
        } else {
            config.stiffness_n_per_mm
        }
    } else {
        config.stiffness_n_per_mm
    };

    extension_mm * stiffness
}

#[cfg(test)]
mod tests {
    use super::*;
    use rstest::rstest;
    use std::sync::atomic::{AtomicU32, Ordering as AtomicOrdering};
    use std::sync::Mutex;

    #[rstest]
    #[case::zero(0.0, 0.0)]
    #[case::negative(-1.0, 0.0)]
    #[case::one_mm(1.0, 2.5)]
    #[case::ten_mm(10.0, 25.0)]
    fn linear_stiffness_force(#[case] extension_mm: f64, #[case] expected_n: f64) {
        let cfg = Config {
            stiffness_n_per_mm: 2.5,
            tension_on_decreasing_position: true,
            material: None,
        };
        let got = calculate_force(extension_mm, &cfg);
        assert!((got - expected_n).abs() < 1e-9, "got {got} expected {expected_n}");
    }

    #[rstest]
    fn material_properties_override_stiffness() {
        // k = E * A / L0 = 100 * 2 / 10 = 20 N/mm
        let cfg = Config {
            stiffness_n_per_mm: 999.0, // ignored when material is valid
            tension_on_decreasing_position: true,
            material: Some(MaterialProperties {
                name: "test",
                youngs_modulus_mpa: 100.0,
                area_mm2: 2.0,
                gauge_length_mm: 10.0,
            }),
        };
        assert!((calculate_force(1.0, &cfg) - 20.0).abs() < 1e-9);
    }

    #[rstest]
    fn on_extension_notifies_subscribers() {
        let sample = Sample::new(Config::default());
        let last = std::sync::Arc::new(Mutex::new(None));
        let hits = std::sync::Arc::new(AtomicU32::new(0));
        {
            let last = std::sync::Arc::clone(&last);
            let hits = std::sync::Arc::clone(&hits);
            sample.on_change(move |f| {
                *last.lock().unwrap() = Some(f);
                hits.fetch_add(1, AtomicOrdering::Relaxed);
            });
        }
        sample.on_extension(4.0); // 4 * 2.5 = 10 N
        assert_eq!(hits.load(AtomicOrdering::Relaxed), 1);
        assert!((last.lock().unwrap().unwrap() - 10.0).abs() < 1e-9);
    }
}
