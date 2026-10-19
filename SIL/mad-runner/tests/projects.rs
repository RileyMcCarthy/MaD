//! MaD's bench projects checked by the built `mad-runner` program: the
//! binary `embsim check` builds and runs for a project whose `[catalog]`
//! runner names this crate. Each check runs in a process of its own, so the
//! catalog crate the runner lists in its `main`, and the directory it lists it
//! from, are the ones a project's `[catalog] crates` is compared with.

use std::path::PathBuf;
use std::process::Command;

use vibes_behaviour::{behaviour, expect, Test};

/// A bench project in the catalog crate beside this one.
fn project_file(name: &str) -> PathBuf {
    [
        env!("CARGO_MANIFEST_DIR"),
        "..",
        "mad-catalog",
        "projects",
        name,
    ]
    .iter()
    .collect()
}

#[test]
fn the_bench_projects_check_through_mads_runner() {
    behaviour!(Test {
        id: "catalog.bench-projects-check",
        covers: Some("SIL/mad-runner/src/main.rs#main"),
        given: "the add-on's and the carrier's bench project files, each checked by MaD's \
                runner program",
    });
    expect!(
        "ds2-checks",
        "the add-on's project builds, its catalogs those embsim ships and MaD's"
    );
    expect!(
        "edge-checks",
        "the carrier's project builds, its catalogs those embsim ships and MaD's"
    );
    for file in ["ds2-bench.toml", "edge-bench.toml"] {
        let path = project_file(file);
        let run = Command::new(env!("CARGO_BIN_EXE_mad-runner"))
            .arg("check")
            .arg(&path)
            .output()
            .expect("mad-runner starts");
        let (out, err) = (
            String::from_utf8_lossy(&run.stdout),
            String::from_utf8_lossy(&run.stderr),
        );
        assert!(run.status.success(), "{file}: {}\n{err}\n{out}", run.status);
        assert!(
            out.contains("catalogs: embsim-boards, embsim-p2-qemu, embsim-cdp, mad-catalog"),
            "{file}: {out}"
        );
        assert!(
            out.contains(&format!("ok: {} builds", path.display())),
            "{file}: {out}"
        );
    }
}
