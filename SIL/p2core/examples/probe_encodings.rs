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

fn dump_jsonl() {
    for e in probe_encodings() {
        println!(
            "{{\"enc\":\"{:08x}\",\"op\":\"{}\",\"hub\":{}}}",
            e.word,
            e.op.mnemonic(),
            if e.hub { "true" } else { "false" }
        );
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
