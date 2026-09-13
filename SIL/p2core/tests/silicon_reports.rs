//! Report-style silicon goldens (locks, two-cog mailbox) via embsim-cpu-oracle.

use std::path::PathBuf;

use embsim_cpu_oracle::{diff_report, parse_report};
use p2core::{Machine, SmartPins};

fn crate_path(rel: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(rel)
}

fn run_iss(image: &[u8]) -> Result<String, String> {
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
    Ok(m.pins.console().to_string())
}

fn replay(name: &str) {
    let bin = crate_path(&format!("hwtest/golden/{name}.binary"));
    let txt = crate_path(&format!("hwtest/golden/{name}.txt"));
    if !bin.is_file() || !txt.is_file() {
        eprintln!(
            "skipping {name}: capture with\n  python3 tools/hw_compare.py --capture --prog {name}"
        );
        return;
    }
    let image = std::fs::read(&bin).unwrap();
    let silicon = parse_report(&std::fs::read_to_string(&txt).unwrap());
    let console = run_iss(&image).unwrap_or_else(|e| panic!("{name}: {e}"));
    let iss = parse_report(&console);
    let misses = diff_report(&iss, &silicon);
    if !misses.is_empty() {
        let mut msg = format!("p2core ISS does not match silicon {name}\n");
        for m in misses {
            msg.push_str(&format!("{m}\n"));
        }
        panic!("{msg}");
    }
}

#[test]
fn locks_match_silicon() {
    replay("locks");
}

#[test]
fn cogs_match_silicon() {
    replay("cogs");
}

#[test]
fn timed_match_silicon() {
    replay("timed");
}
