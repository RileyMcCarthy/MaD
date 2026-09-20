//! Spike 0b, workload half: how much of the real MaD firmware run is
//! cog-exec, and how often does a cog-register write land on an address that
//! is ALSO executed?
//!
//! That last number is decisive. In QEMU a write into a page holding
//! translated code is only expensive if it actually overlaps a translation
//! block. If the firmware's executed cog addresses and its written cog
//! addresses are disjoint (FlexC's kernel at the bottom, its registers above),
//! cog RAM can be ordinary guest RAM. If they overlap on every iteration, a
//! MemoryRegion is hopeless and the hybrid is required.

use p2core::{Board, Machine, SdCard, COG_LONGS, LUT_LONGS, NUM_COGS};

fn span(counts: &[u64]) -> (usize, usize, usize) {
    let used: Vec<usize> = counts
        .iter()
        .enumerate()
        .filter(|(_, n)| **n != 0)
        .map(|(i, _)| i)
        .collect();
    match (used.first(), used.last()) {
        (Some(&lo), Some(&hi)) => (used.len(), lo, hi),
        _ => (0, 0, 0),
    }
}

fn main() {
    let path = std::env::args().nth(1).expect("usage: characterize <image> [budget]");
    let budget: u64 = std::env::args()
        .nth(2)
        .and_then(|s| s.parse().ok())
        .unwrap_or(200_000_000);
    let image = std::fs::read(&path).expect("read image");
    let mut m = Machine::new(&image, Board::new(SdCard::blank(32 * 1024 * 1024)));
    let ran = m.step(budget).unwrap_or_else(|t| {
        println!("TRAP: {t}");
        0
    });
    println!("ran {ran} instructions, guest {:.3} s\n", m.now_us() as f64 / 1e6);

    // ---- where do instructions come from? ---------------------------------
    let mut tot_cog = 0u64;
    let mut tot_lut = 0u64;
    let mut tot_hub = 0u64;
    for c in 0..NUM_COGS {
        tot_cog += m.exec_cog[c].iter().sum::<u64>();
        tot_lut += m.exec_lut[c].iter().sum::<u64>();
        tot_hub += m.exec_hub[c];
    }
    let tot = (tot_cog + tot_lut + tot_hub).max(1);
    println!("instruction fetch source (all cogs):");
    println!("  cog RAM  {:>12}  {:>6.2}%", tot_cog, 100.0 * tot_cog as f64 / tot as f64);
    println!("  LUT      {:>12}  {:>6.2}%", tot_lut, 100.0 * tot_lut as f64 / tot as f64);
    println!("  hub      {:>12}  {:>6.2}%", tot_hub, 100.0 * tot_hub as f64 / tot as f64);

    // ---- the decisive overlap --------------------------------------------
    let mut tot_wr_cog = 0u64;
    let mut tot_wr_lut = 0u64;
    for c in 0..NUM_COGS {
        tot_wr_cog += m.wr_cog[c].iter().sum::<u64>();
        tot_wr_lut += m.wr_lut[c].iter().sum::<u64>();
    }
    println!("\ncog-RAM writes: {tot_wr_cog}  ({:.2} per instruction)", tot_wr_cog as f64 / tot as f64);
    println!(
        "  of those, landing on an address ALSO executed: {} ({:.4}% of writes, {:.4}% of instructions)",
        m.wr_on_exec_cog,
        100.0 * m.wr_on_exec_cog as f64 / tot_wr_cog.max(1) as f64,
        100.0 * m.wr_on_exec_cog as f64 / tot as f64
    );
    println!("LUT writes: {tot_wr_lut}");
    println!(
        "  of those, landing on an address ALSO executed: {} ({:.4}% of LUT writes)",
        m.wr_on_exec_lut,
        100.0 * m.wr_on_exec_lut as f64 / tot_wr_lut.max(1) as f64
    );

    // ---- per-cog layout: is code separable from registers? ----------------
    println!("\nper-cog cog-RAM layout (addresses are longs, $000-$1FF):");
    println!(
        "  {:>3}  {:>10} {:>10} {:>10}   {:<18} {:<18} {:>9}",
        "cog", "exec", "hubexec", "writes", "executed span", "written span", "overlap"
    );
    for c in 0..NUM_COGS {
        let e: u64 = m.exec_cog[c].iter().sum();
        let w: u64 = m.wr_cog[c].iter().sum();
        if e == 0 && w == 0 && m.exec_hub[c] == 0 {
            continue;
        }
        let (ec, elo, ehi) = span(&m.exec_cog[c][..]);
        let (wc, wlo, whi) = span(&m.wr_cog[c][..]);
        let overlap = (0..COG_LONGS)
            .filter(|&i| m.exec_cog[c][i] != 0 && m.wr_cog[c][i] != 0)
            .count();
        println!(
            "  {c:>3}  {e:>10} {:>10} {w:>10}   {:<18} {:<18} {:>9}",
            m.exec_hub[c],
            format!("{ec:>3} @ ${elo:03X}-${ehi:03X}"),
            format!("{wc:>3} @ ${wlo:03X}-${whi:03X}"),
            overlap
        );
    }

    // ---- which addresses are both executed and written? -------------------
    println!("\nhot both-executed-and-written cog addresses (top 12 by writes):");
    let mut both: Vec<(usize, usize, u64, u64)> = Vec::new();
    for c in 0..NUM_COGS {
        for i in 0..COG_LONGS {
            if m.exec_cog[c][i] != 0 && m.wr_cog[c][i] != 0 {
                both.push((c, i, m.exec_cog[c][i], m.wr_cog[c][i]));
            }
        }
    }
    both.sort_by_key(|&(_, _, _, w)| std::cmp::Reverse(w));
    if both.is_empty() {
        println!("  (none — executed and written cog addresses are DISJOINT)");
    }
    for (c, i, e, w) in both.iter().take(12) {
        println!("  cog {c} ${i:03X}  executed {e:>9}  written {w:>9}");
    }

    // ---- LUT, same question ----------------------------------------------
    let lut_overlap: usize = (0..NUM_COGS)
        .map(|c| (0..LUT_LONGS).filter(|&i| m.exec_lut[c][i] != 0 && m.wr_lut[c][i] != 0).count())
        .sum();
    println!("\nLUT addresses both executed and written: {lut_overlap}");
    tb_report(&m, tot, m.now_us() as f64 / 1e6);

    println!("\n=== region transitions (cost driver for an interpret-cog-exec hybrid) ===");
    let sw: u64 = m.region_switch.iter().sum();
    println!("  PC crossings between cog/LUT/hub: {sw} = 1 per {:.1} instructions", tot as f64 / sw.max(1) as f64);
    for (i, name) in ["cog", "lut", "hub"].iter().enumerate() {
        let entries = m.region_runs[i];
        let insns = match i { 0 => tot_cog, 1 => tot_lut, _ => tot_hub };
        println!("  {:<4} entries {:>9}  mean run {:>8.1} instructions", name, entries,
            insns as f64 / entries.max(1) as f64);
    }
    println!("  per-cog crossings: {:?}", m.region_switch);
}

// Appended by the TB-lifecycle pass: printed from main via this helper.
pub fn tb_report(m: &Machine<Board>, tot: u64, guest_s: f64) {
    println!("\n=== modelled QEMU TB lifecycle (per-long granularity) ===");
    println!("  {:<8} {:>14} {:>14} {:>14}", "region", "translations", "invalidations", "re-translations");
    for (i, name) in ["cog", "lut", "hub"].iter().enumerate() {
        println!("  {:<8} {:>14} {:>14} {:>14}", name, m.tb_xlate[i], m.tb_inval[i], m.tb_rexlate[i]);
    }
    let rex: u64 = m.tb_rexlate.iter().sum();
    let inval: u64 = m.tb_inval.iter().sum();
    println!(
        "\n  re-translations: {rex} = 1 per {:.0} instructions ({:.0}/s of guest time)",
        tot as f64 / rex.max(1) as f64,
        rex as f64 / guest_s.max(1e-9)
    );
    println!(
        "  invalidations:   {inval} = 1 per {:.0} instructions",
        tot as f64 / inval.max(1) as f64
    );
    println!("\n  NOTE: per-long is the FINEST possible granularity. A real TB spans many");
    println!("  instructions, so one write kills a whole block: fewer events, each costlier.");
}
