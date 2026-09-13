//! Every `Op` has a test bucket. Required buckets have silicon goldens.

use std::collections::HashSet;
use std::path::PathBuf;

use p2core::{decode, probe_encodings};

fn crate_path(rel: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(rel)
}

fn golden_ops_from_probe() -> (HashSet<&'static str>, HashSet<&'static str>) {
    let text = std::fs::read_to_string(crate_path("hwtest/golden/probe.txt")).unwrap_or_default();
    let mut as_op = HashSet::new();
    let mut as_pre = HashSet::new();
    for line in text.lines() {
        let line = line.trim();
        let Some(rest) = line.strip_prefix("IN ") else {
            continue;
        };
        for tok in rest.split_whitespace() {
            if let Some(hex) = tok.strip_prefix("enc=") {
                if let Ok(w) = u32::from_str_radix(hex, 16) {
                    if let Some(d) = decode(w) {
                        as_op.insert(d.op.mnemonic());
                    }
                }
            }
            if let Some(hex) = tok.strip_prefix("pre=") {
                if let Ok(w) = u32::from_str_radix(hex, 16) {
                    if w != 0 {
                        if let Some(d) = decode(w) {
                            as_pre.insert(d.op.mnemonic());
                        }
                    }
                }
            }
        }
    }
    (as_op, as_pre)
}

fn report_has(name: &str, needle: &str) -> bool {
    let p = crate_path(&format!("hwtest/golden/{name}.txt"));
    std::fs::read_to_string(p)
        .map(|t| t.contains(needle))
        .unwrap_or(false)
}

#[test]
fn every_op_has_a_bucket_and_required_goldens() {
    let (probe_ops, prefix_ops) = golden_ops_from_probe();
    let mut missing = Vec::new();

    let planned: HashSet<_> = probe_encodings()
        .into_iter()
        .map(|e| e.op.mnemonic())
        .collect();
    for mn in &planned {
        if !probe_ops.contains(mn) {
            missing.push(format!("probe golden missing {mn}"));
        }
    }
    for mn in ["setq", "augs", "augd", "altd", "alts"] {
        if !prefix_ops.contains(mn) {
            missing.push(format!("prefix golden missing {mn}"));
        }
    }
    if !report_has("locks", "PASS locknew") {
        missing.push("locks.txt missing locknew".into());
    }
    if !report_has("cogs", "PASS mailbox") {
        missing.push("cogs.txt missing mailbox".into());
    }
    if !report_has("timed", "PASS waitx_") || !report_has("timed", "PASS getct_pair") {
        missing.push(
            "timed.txt missing waitx/getct (python3 tools/hw_compare.py --capture --prog timed)"
                .into(),
        );
    }

    assert!(
        missing.is_empty(),
        "op coverage gaps:\n  {}\n",
        missing.join("\n  ")
    );
}
