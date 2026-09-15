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
    let tested: std::collections::BTreeSet<&str> = tested.iter().copied().collect();
    let missing = embsim_cpu_oracle::never_captured(planned.iter().copied(), &tested);
    assert!(
        missing.is_empty(),
        "probe-safe ops with no silicon golden ({}/{} ops covered): {missing:?}\nrecapture: python3 tools/hw_probe.py --capture",
        planned.len() - missing.len(),
        planned.len()
    );
}

/// The hole that reports as green: an op whose every record says the same
/// thing, so the corpus cannot separate a correct implementation from a wrong
/// one that happens to agree.
///
/// This is not hypothetical. `SAL` passed 50 records while being plainly wrong,
/// because both destination operands in the original sweep had bit 0 clear and
/// `SAL` fills from bit 0. Widening the operands turned it red immediately.
/// Listing the undiscriminated ops says where that could still be true.
#[test]
fn report_ops_the_corpus_cannot_discriminate() {
    let txt = crate_path("hwtest/golden/probe.txt");
    if !txt.is_file() {
        eprintln!("skipping: no probe.txt");
        return;
    }
    let text = std::fs::read_to_string(&txt).unwrap();
    let records = embsim_cpu_oracle::parse_records(&text).expect("parse probe.txt");

    let mnemonic_of = |r: &embsim_cpu_oracle::Record| {
        r.input
            .get("enc")
            .and_then(|hex| u32::from_str_radix(hex, 16).ok())
            .and_then(decode)
            .map(|d| d.op.mnemonic().to_string())
            .unwrap_or_else(|| "?".to_string())
    };
    let weak = embsim_cpu_oracle::undiscriminated(
        &records,
        mnemonic_of,
        embsim_cpu_oracle::coverage::record_output,
    );

    // Reported, not asserted: some of these are genuinely constant functions
    // (an op that always returns 0 for every input this sweep can express), so
    // a hard failure would be wrong. The number is what matters -- it should
    // fall as the operand vectors improve.
    eprintln!(
        "corpus cannot discriminate {} of {} ops:",
        weak.len(),
        records.len()
    );
    for u in &weak {
        eprintln!(
            "  {:10} {:3} records -- {}",
            u.mnemonic, u.records, u.reason
        );
    }
}

/// p2core's own bucket names, mapped onto the generic taxonomy.
///
/// The library stays dependency-free (see `Cargo.toml`), so it keeps its own
/// `OpBucket` and the correspondence is asserted here instead. The point is
/// that "which instructions can a one-instruction probe observe" is not a P2
/// question — every ISA has instructions whose answer is a duration, a pin, or
/// a coprocessor queue — so the classification a new adapter needs is the
/// generic one, and this test is what stops the two drifting apart.
#[test]
fn every_p2_bucket_maps_onto_the_generic_taxonomy() {
    use embsim_cpu_oracle::Observability as O;
    use p2core::{op_bucket, probe_skip_reason, OpBucket};

    fn generic(b: OpBucket) -> O {
        match b {
            OpBucket::Probe => O::OneInstruction,
            OpBucket::Prefix => O::Prefix,
            OpBucket::Timed => O::Timing,
            OpBucket::Pin => O::Io,
            OpBucket::Fifo => O::Streaming,
            OpBucket::Cordic => O::Coprocessor,
            OpBucket::Control => O::ControlFlow,
            OpBucket::Stack => O::Stack,
            OpBucket::System => O::System,
            OpBucket::Locks | OpBucket::Cogs => O::Concurrency,
        }
    }

    // Probe-safety must mean the same thing on both sides: if p2core says an
    // op needs no dedicated program, the generic taxonomy must agree, and vice
    // versa. A disagreement here is how an op ends up wedging the worker.
    for enc in p2core::probe_encodings() {
        let bucket = op_bucket(enc.op);
        assert_eq!(
            probe_skip_reason(enc.op).is_none(),
            generic(bucket).one_instruction(),
            "{:?}: p2core bucket {:?} disagrees with generic {:?}",
            enc.op,
            bucket,
            generic(bucket)
        );
    }

    // And every excluded bucket must be able to say why, in words a coverage
    // report can print.
    for b in [
        OpBucket::Prefix,
        OpBucket::Timed,
        OpBucket::Pin,
        OpBucket::Fifo,
        OpBucket::Cordic,
        OpBucket::Control,
        OpBucket::Stack,
        OpBucket::System,
        OpBucket::Locks,
        OpBucket::Cogs,
    ] {
        assert!(generic(b).needs_program().is_some(), "{b:?} needs a reason");
    }
}
