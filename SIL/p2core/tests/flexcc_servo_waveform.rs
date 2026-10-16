//! The servo's waveform planner, compiled by flexcc and run on this ISS.
//!
//! The firmware's native unit tests run the planner under the host compiler
//! and the host's own `sqrtf`. The board runs the same source compiled by
//! flexcc, whose float square root ends in the CORDIC `QSQRT` instruction,
//! executed by this ISS in the end-to-end nightly. A fault in either -- the
//! compiler or the simulator -- passes natively and refuses waveforms on the
//! board. MaD #164 was the simulator: `QSQRT` rooted the wrong operand, every
//! `sqrtf` came back a bare power of two, and the triangle planner refused
//! both catalog triangles, which the nightly saw as the test ending after the
//! move to the centre.
//!
//! `tests/flexcc/servo_waveform_probe.c` #includes the shipped
//! `dev_servo.c`, so this checks the exact planner the board runs.
//!
//! Not a Vibes suite member: the behaviour-ledger job has no flexcc, so there
//! it could only skip, and a skip would file a claim it never checked. The
//! claims it guards are made by `cordic_qsqrt.rs` (the instruction) and the
//! firmware's own `servo.catalog-triangles-run-full-duration` (the planner);
//! this runs in `sil-rust`, where MAD_REQUIRE_P2_IMAGE makes a missing flexcc
//! a failure rather than a skip.

use std::path::{Path, PathBuf};
use std::process::Command;

use p2core::{Machine, SmartPins};

fn repo() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")
}

/// The flexcc PlatformIO installs with the Propeller platform -- the compiler
/// that builds the shipped image. `FLEXCC` overrides it.
fn flexcc() -> Option<PathBuf> {
    if let Some(p) = std::env::var_os("FLEXCC") {
        return Some(PathBuf::from(p));
    }
    let home = std::env::var_os("HOME").map(PathBuf::from)?;
    let os = if cfg!(target_os = "macos") {
        "macos-amd64"
    } else {
        "linux-amd64"
    };
    let pkg = home.join(".platformio/packages/toolchain-flexcc");
    let p = pkg.join("bin").join(os).join("flexcc");
    p.exists().then_some(p)
}

/// Compile the probe to `out`. `None` when flexcc is not installed -- a skip
/// on a laptop, a failure wherever the P2 image is required (CI installs the
/// same flexcc to build that image).
fn build_probe(out: &Path) -> Option<()> {
    let Some(cc) = flexcc() else {
        if std::env::var_os("MAD_REQUIRE_P2_IMAGE").is_some() {
            panic!(
                "MAD_REQUIRE_P2_IMAGE is set but flexcc is not installed. Install the Propeller \
                 platform (`pio pkg install --platform https://github.com/RileyMcCarthy/platform-propeller.git`) \
                 or point FLEXCC at the compiler."
            );
        }
        return None;
    };
    let src = repo().join("Firmware/MaDCore/src");
    let include = cc.parent()?.parent()?.parent()?.join("include");
    let mut cmd = Command::new(&cc);
    cmd.args(["-2", "-O1", "--nostdlib"])
        .arg(format!("-I{}", include.display()));
    for dir in [
        "Main",
        "APP",
        "DEV",
        "DEV/Config",
        "HAL/Include",
        "IO",
        "IO/Config",
        "Library",
        "HAL/config",
    ] {
        cmd.arg(format!("-I{}", src.join(dir).display()));
    }
    cmd.arg("-o").arg(out);
    cmd.arg(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/flexcc/servo_waveform_probe.c"));
    let o = cmd.output().expect("run flexcc");
    assert!(
        o.status.success() && out.exists(),
        "flexcc failed to build the probe:\n{}\n{}",
        String::from_utf8_lossy(&o.stdout),
        String::from_utf8_lossy(&o.stderr)
    );
    Some(())
}

/// Boot the probe and return its console between BEGIN and END.
fn run_probe(image: &[u8]) -> String {
    let mut m = Machine::new(image, SmartPins::default());
    for _ in 0..200 {
        m.step(1_000_000).expect("the probe never traps");
        if m.pins.console().contains("END") {
            break;
        }
    }
    let console = m.pins.console();
    assert!(
        console.contains("BEGIN") && console.contains("END"),
        "the probe did not finish; console:\n{console}"
    );
    console
}

fn f32_hex(h: &str) -> f32 {
    f32::from_bits(u32::from_str_radix(h, 16).expect("hex float"))
}

#[test]
fn the_flexcc_planner_accepts_the_catalog_triangles_on_the_iss() {
    let dir = PathBuf::from(env!("CARGO_TARGET_TMPDIR"));
    let image_path = dir.join("servo_waveform_probe.binary");
    if build_probe(&image_path).is_none() {
        eprintln!(
            "\n*** SKIPPED: {} needs flexcc (the Propeller platform's toolchain-flexcc).\n\
             *** This test asserted NOTHING.\n",
            module_path!()
        );
        return;
    }
    let console = run_probe(&std::fs::read(&image_path).expect("read probe image"));

    let mut sqrts = 0;
    let mut waves = std::collections::HashMap::new();
    for line in console.lines() {
        let f: Vec<&str> = line.split_whitespace().collect();
        match f.as_slice() {
            ["sqrtf", input, out] => {
                let (x, got) = (f32_hex(input), f32_hex(out));
                assert_eq!(
                    got.to_bits(),
                    x.sqrt().to_bits(),
                    "flexcc sqrtf({x}) on the ISS gave {got}, want {}",
                    x.sqrt()
                );
                sqrts += 1;
            }
            ["wave", name, ok, down, up] => {
                waves.insert(name.to_string(), (*ok == "1", f32_hex(down), f32_hex(up)));
            }
            _ => {}
        }
    }
    assert_eq!(
        sqrts, 6,
        "the probe reports six square roots; console:\n{console}"
    );

    for name in ["WAVE-tri", "WAVE-tri-slow"] {
        let (ok, down, up) = waves
            .get(name)
            .copied()
            .unwrap_or_else(|| panic!("{name} missing; console:\n{console}"));
        assert!(
            ok,
            "{name} was refused by the flexcc-built planner on the ISS"
        );
        for r in [down, up] {
            assert!(
                r > 0.0 && r <= 0.5,
                "{name} ramp share {r} is outside (0, 0.5]"
            );
        }
    }
    for name in ["WAVE-sine", "WAVE-sine-fast"] {
        let ok = waves.get(name).map(|w| w.0);
        assert_eq!(ok, Some(true), "{name} was refused; console:\n{console}");
    }
}
