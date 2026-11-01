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
//! Every other part takes what embsim places by its class or its part
//! number: on the carrier the line driver `U24` (`am26ls31`) and the line
//! receiver `U25` (`am26lv32`, by its part number `AM26LV32IDR`), the
//! isolators, the optocouplers, the regulators; on the add-on the
//! passives, the jumpers and the connectors. How a bench is set up (the
//! add-on's `JP1` and `JP2`, the carrier's `JP1`–`JP5`, the supplies) stays
//! in the project file: it is the bench, not the board.

use embsim_board::{
    netlist, BoardSpec, Catalog, CatalogBoard, Component, ComponentRequest, KindInfo, ModelSpec,
    ProjectError,
};

use crate::machine;

/// The Edge carrier's board kind.
pub const EDGE: &str = "mad-edge";
/// The DS2 add-on's board kind.
pub const DS2: &str = "mad-ds2";

/// The Edge carrier's netlist (its provenance is the file's header).
const MAD_EDGE: &str = include_str!("../netlists/mad_edge.net");
/// The DS2 add-on's netlist (its provenance is the file's header).
const DS2_ADDON: &str = include_str!("../netlists/ds2_addon.net");

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
