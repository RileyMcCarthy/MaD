//! Every probe-safe op that `probe_encodings()` emits must appear in the
//! silicon golden. Recapture with `python3 tools/hw_probe.py --capture`.

use std::collections::HashSet;
use std::path::PathBuf;

use p2core::{decode, probe_encodings};

fn crate_path(rel: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(rel)
}

#[test]
fn every_probe_safe_op_has_a_silicon_golden() {
    let txt = crate_path("hwtest/golden/probe.txt");
    if !txt.is_file() {
        eprintln!("skipping: no probe.txt");
        return;
    }
    let mut tested = HashSet::new();
    for line in std::fs::read_to_string(&txt).unwrap().lines() {
        let line = line.trim();
        let Some(rest) = line.strip_prefix("IN ") else {
            continue;
        };
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
    let planned: HashSet<_> = probe_encodings()
        .into_iter()
        .map(|e| e.op.mnemonic())
        .collect();
    let mut missing: Vec<_> = planned.difference(&tested).copied().collect();
    missing.sort_unstable();
    assert!(
        missing.is_empty(),
        "probe-safe ops with no silicon golden ({}/{} ops covered): {missing:?}\nrecapture: python3 tools/hw_probe.py --capture",
        planned.len() - missing.len(),
        planned.len()
    );
}
