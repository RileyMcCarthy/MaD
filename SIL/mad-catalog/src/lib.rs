//! MaD's own embsim kinds: what MaD's SIL adds to the catalogs embsim ships
//! (embsim `PROJECTS.md` §10, "Extending embsim from a project"), so the
//! machine is a project file the `embsim` command runs (embsim
//! `MIGRATING-MAD.md`).
//!
//! | Kind | Sort | What it is |
//! |---|---|---|
//! | `mad-edge` | a board | the MaD Edge carrier, from its KiCad netlist ([`boards`]) |
//! | `mad-ds2` | a board | the DS2 force-gauge add-on, from its KiCad netlist ([`boards`]) |
//! | `mad-machine` | a bench component | the tensile tester's mechanism, electrical pins outside ([`machine`]) |
//! | `mad-p2iss` | a P2 core | MaD's instruction-set simulator inside the `p2` package, booting its ROM off the board ([`iss`]) |
//!
//! `embsim new --catalog mad-catalog --own-runner` started this crate and
//! `mad-runner` beside it. [`register`] is what `mad-runner` hands
//! `embsim_cli::runner_main`: keep its name and signature.

use embsim_board::ProjectError;
use embsim_boards::catalog::CatalogSet;

pub mod boards;
pub mod iss;
pub mod machine;

/// The catalog's name, as `embsim check` lists it and an error naming two
/// catalogs prints it: the crate's.
pub const NAME: &str = "mad-catalog";

/// Add MaD's kinds to `set`: the two board kinds and the machine as one
/// catalog ([`boards::MadCatalog`]), the ISS as a core catalog
/// ([`iss::IssCores`]). Called once by the runner, after the catalogs embsim
/// ships are in the set and before the project is read. Starts nothing.
pub fn register(set: &mut CatalogSet) -> Result<(), ProjectError> {
    set.add(boards::MadCatalog)?;
    set.add_cores(iss::IssCores)?;
    Ok(())
}
