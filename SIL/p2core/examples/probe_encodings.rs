//! Dump probe-safe encodings as JSONL, or print a coverage table.
//!
//! ```text
//! cargo run -p p2core --example probe_encodings
//! cargo run -p p2core --example probe_encodings -- --coverage hwtest/golden/probe.txt
//! ```

use std::collections::HashSet;

use p2core::{decode, probe_encodings, probe_grid_ops};

fn main() {
    let mut args = std::env::args().skip(1);
    match args.next().as_deref() {
        Some("--coverage") => {
            let path = args
                .next()
                .expect("usage: probe_encodings --coverage <probe.txt>");
            coverage(&path);
        }
        Some("--stats") => stats(),
        None => dump_jsonl(),
        Some(other) => {
            eprintln!("unknown arg {other:?}");
            std::process::exit(2);
        }
    }
}

/// Emit the PLANNED CASES, not just the encodings.
///
/// The operand and flag vectors used to live in the Python capture script,
/// which is the worst place for them: they are the single thing that decides
/// whether the corpus can tell a correct implementation from a wrong one, and
/// they were chosen once, by hand, untested. `SAL` passed fifty silicon
/// records while being plainly wrong because both destination operands had bit
/// 0 clear. The vectors now come from embsim-cpu-oracle, where they are
/// documented and have tests asserting the properties they exist for -- bit 0
/// varies, the sign varies, one pair has disjoint bits, and both branches of
/// every conditional are reachable.
///
/// Hub-observable ops keep their single scratch-addressed case: their answer
/// is in hub memory, not in D, so the operand sweep has nothing to vary.
fn dump_jsonl() {
    use embsim_cpu_oracle::sweep::{plan_cases, Encoding, DEFAULT_FLAG_STATES, DEFAULT_OPERANDS};

    for e in probe_encodings() {
        if e.hub {
            println!(
                "{{\"name\":\"{}_{:08x}\",\"enc\":\"{:08x}\",\"op\":\"{}\",\"hub\":true}}",
                e.op.mnemonic(),
                e.word,
                e.word,
                e.op.mnemonic()
            );
            continue;
        }
        let enc = [Encoding {
            word: e.word,
            mnemonic: e.op.mnemonic(),
        }];
        for c in plan_cases(&enc, DEFAULT_OPERANDS, DEFAULT_FLAG_STATES) {
            println!(
                "{{\"name\":\"{}\",\"enc\":\"{:08x}\",\"op\":\"{}\",\"hub\":false,\
                 \"din\":\"{:08x}\",\"sin\":\"{:08x}\",\"flags\":{}}}",
                c.name,
                c.encoding,
                e.op.mnemonic(),
                c.d,
                c.s,
                c.flags
            );
        }
    }
}

fn stats() {
    let encs = probe_encodings();
    let mut safe = HashSet::new();
    for e in &encs {
        safe.insert(e.op.mnemonic());
    }
    println!("probe-safe encodings: {}", encs.len());
    println!("probe-safe ops: {}", safe.len());
    println!("--- grid ops ---");
    for (op, skip) in probe_grid_ops() {
        match skip {
            None => println!("  SAFE  {}", op.mnemonic()),
            Some(r) => println!("  SKIP  {:<16} {r}", op.mnemonic()),
        }
    }
}

fn coverage(path: &str) {
    let text = std::fs::read_to_string(path).expect("read golden");
    let mut tested = HashSet::new();
    for line in text.lines() {
        let line = line.trim();
        if let Some(rest) = line.strip_prefix("IN ") {
            for tok in rest.split_whitespace() {
                if let Some(hex) = tok.strip_prefix("enc=") {
                    if let Ok(w) = u32::from_str_radix(hex, 16) {
                        if let Some(d) = decode(w) {
                            tested.insert(d.op.mnemonic());
                        }
                    }
                }
            }
        }
    }
    let planned: HashSet<_> = probe_encodings()
        .into_iter()
        .map(|e| e.op.mnemonic())
        .collect();
    let mut missing: Vec<_> = planned.difference(&tested).copied().collect();
    missing.sort_unstable();
    println!("planned probe-safe ops: {}", planned.len());
    println!("ops in golden:          {}", tested.len());
    if missing.is_empty() {
        println!("coverage: complete");
    } else {
        println!("missing from golden ({}):", missing.len());
        for m in &missing {
            println!("  {m}");
        }
        std::process::exit(1);
    }
}
