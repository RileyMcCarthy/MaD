//! p2core vs a console captured from a real P2.
//!
//! `hwtest/golden/oracle.binary` is the exact FlexC image RAM-loaded onto a
//! P2-EVAL. `hwtest/golden/oracle.txt` is what that chip printed on P62.
//! This test interprets the same bytes and demands the same report, so a
//! p2core change is checked against silicon without the board.
//!
//! Recapture (needs the eval on `P2_PORT` or the default FTDI):
//!
//! ```text
//! python3 tools/hw_compare.py --capture
//! ```

use std::path::PathBuf;

use p2core::{Machine, SmartPins};

fn crate_path(rel: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(rel)
}

fn report_lines(console: &str) -> Vec<String> {
    console
        .replace('\r', "\n")
        .lines()
        .map(str::trim)
        .filter(|line| {
            line.starts_with("P2CORE-HW")
                || line.starts_with("CLKFREQ ")
                || line.starts_with("PASS ")
                || line.starts_with("FAIL ")
                || line.starts_with("RESULT ")
        })
        .map(str::to_string)
        .collect()
}

fn read_golden(path: &std::path::Path) -> Vec<String> {
    std::fs::read_to_string(path)
        .unwrap_or_else(|e| panic!("read {}: {e}", path.display()))
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.starts_with('#'))
        .map(str::to_string)
        .collect()
}

fn run_iss(image: &[u8]) -> Result<Vec<String>, String> {
    let mut m = Machine::new(image, SmartPins::default());
    const CHUNK: u64 = 10_000;
    const BUDGET: u64 = 50_000_000;
    let mut ran = 0u64;
    while ran < BUDGET {
        let n = CHUNK.min(BUDGET - ran);
        match m.step(n) {
            Ok(k) => {
                ran += k;
                if k < n {
                    break;
                }
            }
            Err(t) => return Err(format!("TRAP: {t}")),
        }
        if m.pins.console().contains("RESULT") {
            break;
        }
    }
    let lines = report_lines(&m.pins.console());
    if !lines.iter().any(|l| l.starts_with("RESULT")) {
        return Err(format!(
            "no RESULT after {ran} instructions (clkfreq {})\n{}",
            m.clkfreq(),
            m.pins.console()
        ));
    }
    Ok(lines)
}

#[test]
fn silicon_oracle_matches_golden() {
    let bin_path = crate_path("hwtest/golden/oracle.binary");
    let txt_path = crate_path("hwtest/golden/oracle.txt");
    if !bin_path.is_file() || !txt_path.is_file() {
        eprintln!(
            "skipping: no silicon golden at hwtest/golden/; capture with:\n  python3 tools/hw_compare.py --capture"
        );
        return;
    }

    let image = std::fs::read(&bin_path).expect("read golden binary");
    let golden = read_golden(&txt_path);
    let got = run_iss(&image).unwrap_or_else(|e| panic!("{e}"));

    if got == golden {
        return;
    }

    let n = got.len().max(golden.len());
    let mut diff = String::from("p2core ISS does not match the silicon golden\n");
    for i in 0..n {
        let a = got.get(i).map(String::as_str).unwrap_or("<missing>");
        let b = golden.get(i).map(String::as_str).unwrap_or("<missing>");
        if a == b {
            continue;
        }
        diff.push_str(&format!("  iss     {a}\n  silicon {b}\n"));
    }
    diff.push_str("recapture (if oracle.c changed): python3 tools/hw_compare.py --capture\n");
    panic!("{diff}");
}
