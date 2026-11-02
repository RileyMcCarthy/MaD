//! MaD's catalog, [`MadCatalog`]: the two boards as board kinds, and the
//! machine as its one bench component kind (`mad-machine`, built in
//! [`crate::machine`]).
//!
//! Each board kind bundles its KiCad netlist export
//! and starts from the base registrations embsim's catalogs make
//! ([`CatalogBoard::from_base`]), with the one entry every project of that
//! board would otherwise repeat:
//!
//! | Kind | Netlist | Its own entry |
//! |---|---|---|
//! | `mad-edge` | `netlists/mad_edge.net`, of `Hardware/EdgeBoard/KiCad/MaD_Edge.kicad_sch` (three sheets) | `J3`, the module socket, a connector (`boundary`): its symbol, `P2_EDGE_MODULE_SOCKET`, is from the carrier's own library, which no tier knows |
//! | `mad-ds2` | `netlists/ds2_addon.net`, of `Hardware/DS2Addon/KICAD/DS2_Addon.kicad_sch` | `U1`, the ADS122U04 converter (`ads122u04`): its export carries no manufacturer part number, so its part name places it |
//!
//! The catalog's base registrations ([`MadCatalog::register_base`]) add the
//! two carrier parts no catalog embsim ships places, each by its symbol's
//! part name:
//!
//! | Part | Symbol | What it is |
//! |---|---|---|
//! | `Q1` | `MMBT3904` (SOT-23: `1` B, `2` E, `3` C) | the NPN that switches `SC_ENA` with `JP1` on pads 2-3: embsim's 2N3904 figures in the SOT-23 pin order ([`mmbt3904_sot23`]) |
//! | `F1` | `Polyfuse_Small` | the encoder supply's PTC fuse between `J25.1` and `J25.2`: a closed pole, the fuse below its trip current |
//!
//! Every other part takes what embsim places by its class or its part
//! number: on the carrier the line driver `U24` (`am26ls31`), the line
//! receiver `U25` (`am26lv32`, by the part number `AM26LV32IDR` the
//! netlist's header explains), the isolators (`IC14` by its symbol's part
//! name, `ISO6741DWR`), the optocouplers, the regulators; on the add-on
//! the passives, the jumpers and the connectors. How a bench is set up (the
//! add-on's `JP1` and `JP2`, the carrier's `JP1`, `JP2`, `JP3`, `JP5` and
//! `JP6`, the supplies) stays in the project file: it is the bench, not the
//! board.

use embsim_board::{
    netlist, BoardSpec, Catalog, CatalogBoard, Component, ComponentRequest, KindInfo, ModelSpec,
    PartRegistry, ProjectError, PwlCurve, PwlSpec, RegionTest, SwitchPole,
};
use embsim_models::pwl_library::{MMBT3904_HFE_MIN, MMBT3904_R_SAT_OHMS, MMBT3904_VBE_VOLTS};

use crate::machine;

/// The Edge carrier's board kind.
pub const EDGE: &str = "mad-edge";
/// The DS2 add-on's board kind.
pub const DS2: &str = "mad-ds2";

/// The Edge carrier's netlist (its provenance is the file's header).
const MAD_EDGE: &str = include_str!("../netlists/mad_edge.net");
/// The DS2 add-on's netlist (its provenance is the file's header).
const DS2_ADDON: &str = include_str!("../netlists/ds2_addon.net");

/// The part name of KiCad's `Transistor_BJT:MMBT3904` symbol, the carrier's
/// `Q1`.
pub const MMBT3904_SOT23: &str = "MMBT3904";

/// The part name of KiCad's `Device:Polyfuse_Small` symbol, the carrier's
/// `F1`.
pub const POLYFUSE: &str = "Polyfuse_Small";

/// The MMBT3904 in the SOT-23 pin order of the symbol `Q1` is drawn with:
/// `1` base, `2` emitter, `3` collector (the netlist's `pinfunction`
/// labels; `Q1`'s NOTES field cites the JSCJ datasheet's p.1). Its figures
/// are embsim's 2N3904 entry's (`embsim_models::pwl_library`, onsemi
/// 2N3903/D): the base-emitter knee, the minimum gain and the saturated
/// resistance. The SOT-23 part is the same NPN in a smaller package, so its
/// figures are taken to be the TO-92's (inferred). The entry is embsim's
/// `mmbt3904` with the pins renamed: the base-emitter diode first, then the
/// collector-emitter branch it gates.
pub fn mmbt3904_sot23() -> PwlSpec {
    PwlSpec::new(["1", "2", "3"])
        .with_branch(
            "1",
            "2",
            PwlCurve::Diode {
                vf: MMBT3904_VBE_VOLTS,
                r_d: 0.0,
            },
        )
        .with_controlled_branch(
            "3",
            "2",
            PwlCurve::Bjt {
                hfe: MMBT3904_HFE_MIN,
                r_sat: MMBT3904_R_SAT_OHMS,
            },
            "1",
            RegionTest::AtLeast(MMBT3904_VBE_VOLTS),
        )
}

/// MaD's kinds: the two boards and the machine.
#[derive(Debug, Clone, Copy, Default)]
pub struct MadCatalog;

impl Catalog for MadCatalog {
    fn name(&self) -> &str {
        crate::NAME
    }

    fn board_kinds(&self) -> Vec<KindInfo> {
        vec![
            KindInfo::new(
                EDGE,
                "the MaD Edge carrier (Hardware/EdgeBoard): the P2 Edge module's socket J3, the \
                 isolated inputs, the servo drive's RS-422 pairs on J21, the encoder's on J20, \
                 the force cable J9 and the Raspberry Pi's serial port J4",
            ),
            KindInfo::new(
                DS2,
                "the DS2 force-gauge add-on (Hardware/DS2Addon): the ADS122U04 converter U1, \
                 the cable J1 and the bridge's terminals J2",
            ),
        ]
    }

    fn board(&self, spec: &BoardSpec) -> Result<CatalogBoard, ProjectError> {
        let parse = |text| {
            netlist::parse(text)
                .map_err(|err| ProjectError::message(format!("board {}: {err}", spec.name)))
        };
        match spec.kind.as_str() {
            EDGE => Ok(CatalogBoard::from_base(parse(MAD_EDGE)?)
                .with_model(ModelSpec::by_part("P2_EDGE_MODULE_SOCKET", "boundary"))),
            DS2 => Ok(CatalogBoard::from_base(parse(DS2_ADDON)?)
                .with_model(ModelSpec::by_part("ADS122U04", "ads122u04"))),
            other => Err(ProjectError::message(format!(
                "board {}: {other} is not a board kind of {}",
                spec.name,
                crate::NAME
            ))),
        }
    }

    fn register_base(&self, registry: &mut PartRegistry) {
        registry.register_pwl(MMBT3904_SOT23, mmbt3904_sot23());
        registry.register_switch(POLYFUSE, vec![SwitchPole::closed("1", "2")]);
    }

    fn component_kinds(&self) -> Vec<KindInfo> {
        vec![machine::kind_info()]
    }

    fn component(&self, request: ComponentRequest<'_>) -> Result<Box<dyn Component>, ProjectError> {
        if request.spec.kind == machine::MACHINE {
            return machine::component(request);
        }
        Err(request.error(format!(
            "{} is not a component kind of {}",
            request.spec.kind,
            crate::NAME
        )))
    }
}
