//! Report the PCs at which a given mnemonic executes, with counts.
//!
//! `findop <image> <mnemonic> [steps]`
use std::collections::BTreeMap;

use p2core::{decode, Machine, SmartPins};

fn main() {
    let mut a = std::env::args().skip(1);
    let path = a.next().expect("usage: findop <image> <mnemonic> [steps]");
    let want = a.next().expect("mnemonic");
    let steps: u64 = a.next().and_then(|s| s.parse().ok()).unwrap_or(5_000_000);

    let image = std::fs::read(&path).expect("read image");
    let mut m = Machine::new(&image, SmartPins::default());
    m.strict_hub = false;
    let mut hits: BTreeMap<u32, (u64, bool)> = BTreeMap::new();

    for _ in 0..steps {
        let pc = m.cogs[0].pc;
        let w = if pc < 0x200 {
            m.cogs[0].regs[pc as usize]
        } else if pc < 0x400 {
            m.cogs[0].lut[(pc - 0x200) as usize]
        } else {
            let o = pc as usize;
            u32::from_le_bytes([m.hub[o], m.hub[o + 1], m.hub[o + 2], m.hub[o + 3]])
        };
        if let Some(d) = decode(w) {
            if d.op.mnemonic() == want {
                let e = hits.entry(pc).or_insert((0, d.c));
                e.0 += 1;
            }
        }
        if m.step(1).is_err() {
            break;
        }
    }
    println!("{} distinct PCs executing `{want}`:", hits.len());
    for (pc, (n, wc)) in hits.iter().take(20) {
        println!("  ${pc:05X}  x{n}{}", if *wc { "  (WC)" } else { "" });
    }
}
