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

    // Same bargain as the one-instruction gate: a burn-down baseline, keyed on
    // the PASS label, so a program whose silicon behaviour the ISS does not
    // model yet can still be CAPTURED and committed. Without it the only way
    // to add a new harness is to implement everything it measures first, which
    // is backwards -- the capture is what tells you what to implement.
    let baseline_path = format!("hwtest/{name}-baseline.txt");
    let baseline = embsim_cpu_oracle::Baseline::parse(
        &std::fs::read_to_string(crate_path(&baseline_path)).unwrap_or_default(),
    );
    let diverged: Vec<&str> = misses.iter().filter_map(|m| pass_label(m)).collect();
    let verdict = embsim_cpu_oracle::evaluate(diverged.iter().copied(), &baseline);

    if let Some(why) = verdict.failure(&baseline_path) {
        let mut msg = format!("p2core ISS vs silicon {name}\n{why}\n");
        for m in &misses {
            msg.push_str(&format!("{m}\n"));
        }
        panic!("{msg}");
    }
    if !misses.is_empty() {
        eprintln!(
            "{name}: {} line(s) differ from silicon, all baselined ({})",
            misses.len(),
            baseline_path
        );
    }
}

/// The label of a `PASS <label> <value>` line inside a mismatch, which is what
/// the baseline is keyed on.
fn pass_label(m: &embsim_cpu_oracle::Mismatch) -> Option<&str> {
    for side in [m.iss.as_str(), m.silicon.as_str()] {
        if let Some(rest) = side.strip_prefix("PASS ") {
            return rest.split_whitespace().next();
        }
    }
    None
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

/// The smart-pin surface: drive/readback, the step-pulse generator, the async
/// transmit path, an on-chip TX->RX loopback, and the NCO step train sampled
/// into a bit pattern. None of this is reachable through the one-instruction
/// probe, and all of it is where p2core has previously been wrong.
#[test]
fn pins_match_silicon() {
    replay("pins");
}
