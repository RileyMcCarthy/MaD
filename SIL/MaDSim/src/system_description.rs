//! The load-cell bridge the ISS bench drives.
//!
//! The cell is a bench component: two analog terminals whose Thevenin drives
//! the strain-gauge model updates through [`BridgeDrive`]. The DS2 Addon
//! netlist is the committed board those terminals plug into. The P2 itself is
//! not described here — the ISS is a pin-named component in
//! [`crate::iss_description`], because it executes the firmware's own
//! `WRPIN`/`DIR`/`OUT` and a pin is all it has.

use std::sync::{Arc, Mutex};

use embsim_board::{
    AttachError, Component, ComponentNetIo, Drive, PinDecl, PinHandle, TheveninDrive,
};

// ============================================================
// Committed board netlist
// ============================================================

/// DS2 Addon netlist — committed simulation artifact (provenance and
/// regeneration policy in the file's own header comment).
pub(crate) const DS2_NETLIST: &str = include_str!("../boards/ds2_addon.net");

// ============================================================
// Load-cell bridge (bench component with live Thevenin drives)
// ============================================================

/// Bridge excitation voltage: the bench straps feed the analog domain (and
/// therefore the bridge) from the 3.3 V rail. Must match the strain-gauge
/// model config in `main.rs` (`excitation_v: 3.3`) — the ADC runs
/// ratiometric (VREF = AVDD = excitation), so both sides cancel.
pub(crate) const BRIDGE_EXCITATION_V: f64 = 3.3;

/// Common-mode voltage of the bridge output: both signal terminals sit at
/// half the excitation, ±v/2 differential (standard four-arm Wheatstone
/// bridge — see the provenance header in `SIL/models/src/strain_gauge.rs`).
const BRIDGE_COMMON_MODE_V: f64 = BRIDGE_EXCITATION_V / 2.0;

/// Thevenin source impedance of each signal terminal. The Wishiot 10 kg
/// cell (Amazon B0C3QJ8J59; provenance header in
/// `SIL/models/src/strain_gauge.rs`) is a standard 350 Ω full bridge, so
/// each output terminal looks like ~350 Ω into the ADC's high-Z inputs.
const BRIDGE_SOURCE_OHMS: f64 = 350.0;

/// Cloneable handle onto the load cell's two engine pin drives. Filled in at
/// attach; `main.rs` hooks `strain_gauge.on_change` to it.
#[derive(Clone, Default)]
pub struct BridgeDrive {
    /// `(S+, S−)` pin handles, present once the component has attached.
    pins: Arc<Mutex<Option<(PinHandle, PinHandle)>>>,
}

impl BridgeDrive {
    /// Present a differential output of `diff_mv` millivolts across the
    /// bridge terminals: S+ = 1.65 + v_mv/2000 volts, S− = 1.65 − v_mv/2000
    /// volts, each through the cell's ~350 Ω source impedance. Drives are
    /// enqueued to the net engine; the MNA solve delivers the resulting AIN
    /// voltages to the ADS component's senses. Sign convention matches the
    /// component's AIN0−AIN1 differential (and the firmware MUX, AINP=AIN0 /
    /// AINN=AIN1): S+ lands on AIN0 and S− on AIN1, so the solved
    /// differential equals `diff_mv`.
    ///
    /// A no-op before the component attaches: there are no drives to update
    /// until the engine hands out pin handles.
    pub fn set_differential_mv(&self, diff_mv: f64) {
        let half_v = diff_mv / 2_000.0;
        if let Some((sig_p, sig_n)) = &*self.pins.lock().unwrap() {
            sig_p.drive(Drive::Thevenin(TheveninDrive {
                volts: BRIDGE_COMMON_MODE_V + half_v,
                impedance: BRIDGE_SOURCE_OHMS,
            }));
            sig_n.drive(Drive::Thevenin(TheveninDrive {
                volts: BRIDGE_COMMON_MODE_V - half_v,
                impedance: BRIDGE_SOURCE_OHMS,
            }));
        }
    }
}

/// The load cell's electrical boundary: two analog signal terminals whose
/// Thevenin drives the physics plant (strain-gauge model) updates through
/// [`BridgeDrive`]. A bench component — the Wishiot cell's signal wires
/// (green S+ / white S−) plug straight into the J2 header, no PCB of their
/// own. Excitation is ratiometric and carried by the J2 supply straps (the
/// bench rig strapped AVDD/AGND, which *is* the bridge excitation), so
/// E+/E− need no pins here. A two-source Thevenin equivalent is exact for
/// the ADC's high-Z inputs.
pub(crate) struct LoadCellBridge {
    pub(crate) drive: BridgeDrive,
}

/// S+/S− terminal declarations: linear sources, released until
/// [`BridgeDrive`] publishes the quiescent output at attach.
const LOAD_CELL_PINS: [PinDecl; 2] = [PinDecl::analog_source("S+"), PinDecl::analog_source("S-")];

impl Component for LoadCellBridge {
    fn pins(&self) -> &[PinDecl] {
        &LOAD_CELL_PINS
    }

    fn attach(&mut self, io: ComponentNetIo) -> Result<(), AttachError> {
        *self.drive.pins.lock().unwrap() = Some((io.pin("S+")?, io.pin("S-")?));
        // A real bridge always presents its quiescent output — drive the
        // zero-force differential immediately so the AIN nets solve
        // numerically before the firmware's first conversion.
        self.drive.set_differential_mv(0.0);
        Ok(())
    }
}
