//! Force-path system description — the board-engine successor to the
//! hand-wired ADS122U04 force path that used to live in `wiring.rs`, and the
//! owner of the P2's firmware entry.
//!
//! A *system description* (boards + bench components + harness + scenario,
//! per `SIL/embsim/BOARD_ENGINE.md` and
//! `docs/dev/sil-board-simulation-design.md`) replaces wiring code: the DS2
//! Addon board is ingested from its committed KiCad netlist, the ADS122U04
//! protocol model mounts on U1 as a live component, the P2 becomes a bench
//! [`McuComponent`] named `P2EVAL` whose FORCE_GAUGE serial channel is
//! bridged to stream pins (wiring and baud decoded from the firmware's own
//! HAL config tables in `libfirmware.a`), and the load cell drives the
//! bridge terminals through the net engine's MNA solve:
//!
//! ```text
//!   strain_gauge.on_change (mV)            [wiring.rs keeps the plant]
//!     └─> BridgeDrive::set_differential_mv
//!           ├─> LoadCell S+ drive: 1.65 V + v/2 (350 Ω) ─┐ harness → J2.3/J2.4
//!           └─> LoadCell S− drive: 1.65 V − v/2 (350 Ω) ─┤ (A0/A1, JP1/JP2
//!                                                        ▼  closed)
//!                                              MNA solve: AIN0/AIN1 senses
//!                                                        │
//!                                              Ads122u04Component (U1)
//!                                                        │ UART, 115.2 kbaud
//!               firmware HAL FORCE_GAUGE channel         ▼ (from the table)
//!                 ◄── P2EVAL stream pins ── R3/R4 (47 Ω, collapsed) ── J1.3/4
//! ```
//!
//! # Owned execution: the engine spawns the firmware
//!
//! The `P2EVAL` component is built **with an entry** (`mad_begin`), so it runs
//! in `embsim_board::mcu`'s owned-execution mode — the "engine spawns the
//! firmware entry" inversion of `BOARD_ENGINE.md` ("The MCU as a component",
//! point 1). Two consequences the rest of the emulator must respect:
//!
//! - The component creates its **own** [`PeripheralInstance`] at build time
//!   and `Component::start` binds the firmware thread to it, so the firmware
//!   no longer runs against the process-default instance. Everything that
//!   talks to *this* MCU — the runtime's peripheral sizing and host-PTY
//!   bridge, `wiring.rs`' GPIO/encoder/pulse callbacks, the machine
//!   visualizer's GPIO snapshot — must target that instance
//!   ([`ForcePathDescription::mcu_instance`]); peripheral free functions on
//!   an unbound thread would silently hit the *default* instance instead
//!   (the `CONTRACT.md` "Peripheral instances & thread routing" obligation).
//! - [`System::start`] must therefore run **after** that instance is sized
//!   (the peripheral serial bank in particular), and it is now what boots the
//!   firmware — so it *is* the emulator's "hand control to the firmware"
//!   step. `main.rs` calls it from the `Emulator` entry hook, i.e. strictly
//!   after `Machine::wire`.
//!
//! # Slice scope (and what is deferred)
//!
//! This slice migrates the **force path only**. GPIO, encoder, and pulse-out
//! stay hand-wired in `wiring.rs` (against the MCU's instance); the GPIO
//! table is still decoded here so the pin-facade truth is read from the
//! archive, but no GPIO pins are declared.
//!
//! # Bench provenance
//!
//! The harness and scenario mirror the July 2026 physical bring-up rig
//! (P2-EVAL + DS2 Addon + Wishiot load cell), bugs-fixed configuration:
//! see the per-wire comments in [`describe`].

use std::path::Path;
use std::sync::{Arc, Mutex};

use embsim_board::mcu::{McuComponent, SerialChannelConfig};
use embsim_board::{
    netlist, AttachError, Board, Component, ComponentNetIo, EndpointRef, Harness, JumperState,
    PartRegistry, PinDecl, PinHandle, PinKind, Scenario, System, SystemHandle, TheveninDrive,
};
use embsim_memory_inspect::{hal_tables, ArchiveValueReader, FirmwareInfo};
use embsim_models::ads122u04;
use embsim_models::ads122u04_component::Ads122u04Component;
use embsim_peripherals::instance::PeripheralInstance;
use tracing::info;

// ============================================================
// Committed board netlist
// ============================================================

/// DS2 Addon netlist — committed simulation artifact (provenance and
/// regeneration policy in the file's own header comment).
const DS2_NETLIST: &str = include_str!("../boards/ds2_addon.net");

// ============================================================
// Load-cell bridge (bench component with live Thevenin drives)
// ============================================================

/// Bridge excitation voltage: the bench straps feed the analog domain (and
/// therefore the bridge) from the 3.3 V rail. Must match the strain-gauge
/// model config in `wiring.rs` (`excitation_v: 3.3`) — the ADC runs
/// ratiometric (VREF = AVDD = excitation), so both sides cancel.
const BRIDGE_EXCITATION_V: f64 = 3.3;

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
/// attach; `wiring.rs` hooks `strain_gauge.on_change` to it.
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
    /// differential equals `diff_mv` — the exact value the hand-wired path
    /// passed to `set_voltage(v_mv)` (tension sign preserved).
    ///
    /// A no-op before the component attaches: there are no drives to update
    /// until the engine hands out pin handles.
    pub fn set_differential_mv(&self, diff_mv: f64) {
        let half_v = diff_mv / 2_000.0;
        if let Some((sig_p, sig_n)) = &*self.pins.lock().unwrap() {
            sig_p.set_drive(Some(TheveninDrive {
                volts: BRIDGE_COMMON_MODE_V + half_v,
                impedance: BRIDGE_SOURCE_OHMS,
            }));
            sig_n.set_drive(Some(TheveninDrive {
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
/// E+/E− need no pins this slice. The transducer-primitive form (bridge
/// legs contributed to the cluster) is a later engine slice; a two-source
/// Thevenin equivalent is exact for the ADC's high-Z inputs.
struct LoadCellBridge {
    drive: BridgeDrive,
}

/// S+/S− terminal declarations.
const LOAD_CELL_PINS: [PinDecl; 2] = [
    PinDecl {
        number: "S+",
        name: None,
        kind: PinKind::Analog,
        stream: None,
        drive_impedance: None,
    },
    PinDecl {
        number: "S-",
        name: None,
        kind: PinKind::Analog,
        stream: None,
        drive_impedance: None,
    },
];

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

// ============================================================
// Force path (assembled description → live system)
// ============================================================

/// The assembled-but-not-yet-started force path: the configured board-engine
/// [`System`], the peripheral instance the `P2EVAL` component's firmware will
/// run against, and the bridge drive handle the wiring layer feeds.
///
/// Split from [`ForcePath`] because of the ordering owned execution forces:
/// the MCU's [`PeripheralInstance`] must exist — so the runtime can size it
/// and bridge the host PTY into it — *before* [`System::start`] boots the
/// firmware on it.
pub struct ForcePathDescription {
    system: System,
    instance: Arc<PeripheralInstance>,
    bridge: BridgeDrive,
}

impl ForcePathDescription {
    /// The peripheral instance the P2's firmware runs against. Every
    /// peripheral touch aimed at this MCU must go through it (see the module
    /// docs); free functions on an unbound thread hit the default instance.
    pub fn mcu_instance(&self) -> &Arc<PeripheralInstance> {
        &self.instance
    }

    /// A clone of the load-cell bridge drive handle, for the wiring layer.
    pub fn bridge(&self) -> BridgeDrive {
        self.bridge.clone()
    }

    /// Start the live system: spawn the net engine, attach every component
    /// (the ADS model, the MCU serial bridges, the load cell), then let
    /// components begin the execution they own — which for `P2EVAL` means
    /// spawning the firmware entry on a thread bound to
    /// [`Self::mcu_instance`].
    ///
    /// # Panics
    ///
    /// Panics when the system fails to assemble or attach: a broken force
    /// path must fail the boot loudly, exactly like the Phase-0 CI
    /// table-presence check.
    pub fn start(self) -> ForcePath {
        let ForcePathDescription {
            system,
            instance: _,
            bridge,
        } = self;

        let system = system.start().expect("force-path system starts");
        for finding in system.findings() {
            info!(?finding, "force path: board-engine finding");
        }

        ForcePath {
            _system: system,
            _bridge: bridge,
        }
    }
}

/// The running force path. Owns the net-engine thread and every attached
/// component: the ADS model + its protocol pump, the MCU's serial bridge
/// pumps and firmware entry thread, and the load cell.
///
/// Dropping it shuts the engine down and disconnects the firmware's bridged
/// serial channels, so it must live as long as the firmware does — i.e. for
/// the life of the process. `main.rs` holds it on the parked main thread.
pub struct ForcePath {
    _system: SystemHandle,
    _bridge: BridgeDrive,
}

/// Assemble the force-path system description. `entry` is the firmware entry
/// the `P2EVAL` component owns (owned-execution mode); it is spawned by
/// [`ForcePathDescription::start`], never by the caller.
///
/// `firmware_lib` is the same `libfirmware.a` the caller parsed `fw` from;
/// the HAL serial/GPIO config tables are decoded from its data sections, so
/// the MCU pin facade and wire baud derive from the exact bytes that run on
/// hardware.
///
/// # Panics
///
/// Panics (with an actionable message) when the archive tables, the committed
/// netlist, or the component configuration are inconsistent — a broken force
/// path must fail the boot loudly.
pub fn describe(
    fw: &FirmwareInfo,
    firmware_lib: &Path,
    entry: impl FnOnce() + Send + 'static,
) -> ForcePathDescription {
    // ── HAL config tables, from the firmware archive (Phase 0 read path) ──

    let values = ArchiveValueReader::from_archive(firmware_lib)
        .expect("libfirmware.a readable for HAL config tables");
    let serial_table =
        hal_tables::read_serial_table(&values, fw, hal_tables::DEFAULT_SERIAL_TABLE_SYMBOL)
            .expect("HAL serial config table decodes from the firmware archive");
    // The GPIO table is decoded from the same archive so the facade truth is
    // available, but GPIO channels stay hand-wired in wiring.rs this slice
    // (declaring their pins comes with the GPIO-bridging slice).
    let gpio_table =
        hal_tables::read_gpio_table(&values, fw, hal_tables::DEFAULT_GPIO_TABLE_SYMBOL)
            .expect("HAL GPIO config table decodes from the firmware archive");

    let fg_channel = fw.enum_channel("HAL_SERIAL_CHANNEL_FORCE_GAUGE");
    let fg = *serial_table
        .get(fg_channel)
        .expect("FORCE_GAUGE channel present in the HAL serial table");
    info!(
        channel = fg_channel,
        rx = format!("P{}", fg.rx_pin),
        tx = format!("P{}", fg.tx_pin),
        baud = fg.baud,
        gpio_channels = gpio_table.len(),
        "force path: HAL tables decoded (FORCE_GAUGE bridged; GPIO stays hand-wired this slice)"
    );

    // ── Part registry (netlist-mounted parts) ──

    // Ratiometric like the firmware config: VREF = AVDD = bridge excitation,
    // PGA gain 128. Firmware recovers signal[nV/V] = counts * 1e9 / (128 * 2^23),
    // so the excitation cancels and force = signal * capacity / sensitivity.
    let mut registry = PartRegistry::new();
    registry.register("ADS122U04", |_decl| {
        Box::new(Ads122u04Component::new(ads122u04::Config {
            vref_mv: 1_000.0 * BRIDGE_EXCITATION_V,
            gain: 128.0,
            zero_offset: 0,
        }))
    });

    // ── Boards + bench components ──

    let ds2 = Board::from_netlist(
        netlist::parse(DS2_NETLIST).expect("committed DS2 Addon netlist parses"),
        &registry,
    )
    .expect("DS2 Addon board builds");

    // The P2 as a bench McuComponent: pins named from the DECODED HAL serial
    // table, never hardcoded. Only the FORCE_GAUGE channel is bridged this
    // slice; the MAIN/host channel stays PTY-wired by the runtime
    // (`Emulator::run`) — into *this component's* instance, because main.rs
    // binds the thread that runs the runtime's init. Board-side config
    // structs deliberately duplicate the memory-inspect ones (board must not
    // depend on memory-inspect); the consumer maps field-by-field — see
    // `embsim_board::mcu` docs.
    let mcu_table: Vec<SerialChannelConfig> = serial_table
        .iter()
        .map(|c| SerialChannelConfig {
            rx_pin: c.rx_pin,
            tx_pin: c.tx_pin,
            baud: c.baud,
        })
        .collect();
    let mcu = McuComponent::builder("P2EVAL")
        .serial_table(mcu_table)
        .bridge_serial(fg_channel)
        // Owned execution: this component — not `Emulator::run` — spawns the
        // firmware, on a thread bound to the instance cloned out below.
        .entry(entry)
        .build()
        .expect("P2 MCU component builds from the HAL serial table");
    // Cloned out before the component is moved into the system: everything
    // that speaks to this MCU's peripherals needs it.
    let instance = Arc::clone(
        mcu.instance()
            .expect("owned-execution mode always builds its own instance"),
    );

    let bridge = BridgeDrive::default();
    let load_cell = LoadCellBridge {
        drive: bridge.clone(),
    };

    // ── Bench harness (mirrors the July 2026 physical rig; netlist truth) ──

    let ep = |s: &str| EndpointRef::parse(s).expect("harness endpoint parses");
    // The FG TX/RX endpoints come from the decoded table (bare bench-pin
    // endpoints on the P2EVAL component — never hardcoded pin numbers).
    let fg_tx = format!("P2EVAL.P{}", fg.tx_pin);
    let fg_rx = format!("P2EVAL.P{}", fg.rx_pin);
    let harness = Harness::new()
        // J1 "MCU" header digital straps: the P2-EVAL's regulator rail and
        // ground feed DVDD/DGND (netlist: J1.1 = +3V3 → U1.13, J1.2 = GND →
        // U1.4). The rail is a bench power endpoint — the MCU facade
        // declares no supply pins this slice.
        .power(ep("P2EVAL.3V3"), ep("DS2Addon.J1.1"), BRIDGE_EXCITATION_V)
        .power(ep("P2EVAL.GND"), ep("DS2Addon.J1.2"), 0.0)
        // Serial cross-wires, netlist truth: J1.3 → R3 (47 Ω) → U1.16 (RX)
        // takes the P2's FG TX; U1.15 (TX) → R4 (47 Ω) → J1.4 feeds the
        // P2's FG RX. The series resistors collapse into the stream route.
        .connect(ep(&fg_tx), ep("DS2Addon.J1.3"))
        .connect(ep("DS2Addon.J1.4"), ep(&fg_rx))
        // J2 analog straps. Bench bug made live: the analog domain is fully
        // isolated on the PCB (even grounds), and POR requires BOTH supplies
        // — without these straps AVDD is unsourced and the chip is silent
        // (`PowerNetUnsourced`). On the strapped rig these rails are also
        // the ratiometric bridge excitation (netlist: J2.1 = VDDA → U1.12,
        // J2.2 = VSS → U1.5).
        .power(ep("BENCH.3V3A"), ep("DS2Addon.J2.1"), BRIDGE_EXCITATION_V)
        .power(ep("BENCH.GNDA"), ep("DS2Addon.J2.2"), 0.0)
        // Strain-gauge bridge terminals: the load cell's live Thevenin
        // drives land on the A0/A1 header pins (netlist: J2.3 = A0 → JP1 →
        // AIN0, J2.4 = A1 → JP2 → AIN1).
        .connect(ep("LoadCell.S+"), ep("DS2Addon.J2.3"))
        .connect(ep("LoadCell.S-"), ep("DS2Addon.J2.4"));

    // ── Scenario (the bugs-fixed bench board) ──

    let scenario = Scenario::default()
        // Bench bug: R6/R7 are DNP, so the A0/A1 signal path is OPEN as
        // fabbed — the input jumpers must be closed or the ADC inputs float
        // (the "wild readings" bring-up symptom). The bench boards have
        // JP1/JP2 solder-bridged.
        .jumper("DS2Addon.JP1", JumperState::Closed)
        .jumper("DS2Addon.JP2", JumperState::Closed)
        // Bench bug: the stock PCB leaves ~RESET (U1.3) on a one-pin net —
        // a floating reset is a silent chip (two boards were condemned
        // before a multimeter found it). The physical fix ties it to the
        // DVDD rail (drag-bridge U1 pins 1-2-3 + 3.3 V via J3; the R10
        // pull-up on the next board rev). Modeled as a solder bridge from
        // U1.3 (~RESET) to U1.13 (DVDD).
        .pin_short("DS2Addon.U1.3", "DS2Addon.U1.13");

    // ── Assemble only; ForcePathDescription::start goes live ──

    let system = System::new()
        .board("DS2Addon", ds2)
        .component("P2EVAL", Box::new(mcu))
        .component("LoadCell", Box::new(load_cell))
        .harness(harness)
        .scenario(scenario);

    ForcePathDescription {
        system,
        instance,
        bridge,
    }
}
