//! Decoder golden test: every hub instruction, against flexcc's own listing.
//!
//! The compiler that produced the image also printed what it thinks each word
//! is. With no public RTL and no cycle table, that listing is the strongest
//! instruction-level oracle available offline, and it covers all ~27k
//! instructions rather than a hand-picked sample.
//!
//! Regenerate the golden after rebuilding the firmware:
//!
//! ```text
//! cd Firmware/MaDCore && pio run -e propeller2_debug
//! cd SIL/p2core && python3 tools/gen_golden.py
//! ```

use std::collections::BTreeMap;
use std::path::PathBuf;

fn crate_path(rel: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(rel)
}

/// Mnemonics the listing spells differently from the encoding table, or that
/// share one encoding. Both spellings are accepted for these.
fn equivalent(golden: &str, got: &str) -> bool {
    if golden == got {
        return true;
    }
    matches!(
        (golden, got),
        // The listing prints the alias; the table carries the base encoding.
        ("ret", "call")
            | ("nop", "ror")
            // Signed/unsigned pairs sharing an encoding.
            | ("cmp", "cmps")
            | ("cmps", "cmp")
            // AKPIN is literally `WRPIN #1,S`.
            | ("akpin", "wrpin")
    )
}

#[test]
fn decoder_matches_flexcc_listing() {
    let img = crate_path("../../Firmware/MaDCore/.pio/build/propeller2_debug/program");
    let gold = crate_path("tests/golden/hub_mnemonics.txt");
    let (Ok(image), Ok(golden)) = (std::fs::read(&img), std::fs::read_to_string(&gold)) else {
        eprintln!("skipping: build the firmware and run tools/gen_golden.py");
        return;
    };

    let mut mismatch: Vec<(u32, String, String)> = Vec::new();
    let mut undecoded: Vec<(u32, u32, String)> = Vec::new();
    let mut checked = 0usize;

    for line in golden.lines() {
        let Some((addr, want)) = line.split_once(' ') else { continue };
        let Ok(addr) = u32::from_str_radix(addr, 16) else { continue };
        let a = addr as usize;
        if a + 4 > image.len() {
            continue;
        }
        let word = u32::from_le_bytes([image[a], image[a + 1], image[a + 2], image[a + 3]]);
        checked += 1;

        match p2core::decode(word) {
            None => undecoded.push((addr, word, want.to_string())),
            Some(d) => {
                let got = d.op.mnemonic();
                if !equivalent(want, got) {
                    mismatch.push((addr, want.to_string(), got.to_string()));
                }
            }
        }
    }

    assert!(checked > 20_000, "golden file looks truncated: {checked}");

    // The first divergence in address order localizes drift: everything below
    // it agrees, so a systematic offset shows up as one clean cut point.
    if !mismatch.is_empty() {
        let mut first = mismatch.clone();
        first.sort_by_key(|(a, _, _)| *a);
        eprintln!("first 12 divergences by address:");
        for (a, w, g) in first.iter().take(12) {
            eprintln!("   ${a:05X}  listing {w:9} decoded {g}");
        }
    }

    if !mismatch.is_empty() || !undecoded.is_empty() {
        let mut by_kind: BTreeMap<(String, String), (usize, u32)> = BTreeMap::new();
        for (addr, want, got) in &mismatch {
            by_kind.entry((want.clone(), got.clone())).or_insert((0, *addr)).0 += 1;
        }
        let mut msg = format!(
            "decoder disagrees with flexcc on {} of {checked} instructions ({} undecoded)\n",
            mismatch.len(),
            undecoded.len()
        );
        for ((want, got), (n, first)) in &by_kind {
            msg += &format!("  listing {want:9} -> decoded {got:9}  x{n} (first ${first:05X})\n");
        }
        for (addr, word, want) in undecoded.iter().take(8) {
            msg += &format!("  listing {want:9} -> UNDECODED at ${addr:05X} = {word:08X}\n");
        }
        panic!("{msg}");
    }
}
