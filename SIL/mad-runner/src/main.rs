//! mad-runner: the embsim command over this project's catalog crates, which
//! `embsim check` and `embsim run` build and run for a project whose [catalog]
//! runner names this crate (PROJECTS.md §10). A catalog crate the project adds
//! joins the list below and the dependencies, as it joins [catalog] crates.

use std::process::ExitCode;

fn main() -> ExitCode {
    embsim_cli::runner_main(&[embsim_cli::CatalogCrate::new(
        "mad-catalog",
        concat!(env!("CARGO_MANIFEST_DIR"), "/../mad-catalog"),
        mad_catalog::register,
    )])
}
