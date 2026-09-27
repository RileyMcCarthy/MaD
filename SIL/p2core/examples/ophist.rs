//! Histogram the instructions the firmware actually *executes*, so the QEMU
//! target can be built in frequency order rather than opcode order.
//!
//! A static dump over the image (see `dumpdec.rs`) answers a different
//! question: it covers every word that might be an instruction, including ones
//! on paths the firmware never takes. What decides when the QEMU target can
//! boot is the dynamic mix.
use std::collections::HashMap;

use p2core::{Machine, SmartPins};
use p2core::generated::decode::decode;

fn main() {
    let path = std::env::args().nth(1).expect("usage: ophist <image> [steps]");
    let steps: u64 = std::env::args()
        .nth(2)
        .and_then(|s| s.parse().ok())
        .unwrap_or(20_000_000);
    let image = std::fs::read(&path).expect("read image");
    let mut m = Machine::new(&image, SmartPins::default());
    m.strict_hub = false;
    // Split by fetch region: the QEMU target translates hub-exec and
    // interprets cog-exec, so "which instructions does the interpreter have to
    // implement" is a different question from the overall mix.
    let mut hist: HashMap<&'static str, u64> = HashMap::new();
    let mut cog_hist: HashMap<&'static str, u64> = HashMap::new();
    let mut n = 0u64;
    let mut n_cog = 0u64;

    for _ in 0..steps {
        let cog = m.cogs.iter().position(|c| c.running).unwrap_or(0);
        let pc = m.cogs[cog].pc;
        // Fetch the way the cog would: below $200 the PC indexes cog RAM.
        let w = if pc < 0x200 {
            m.cogs[cog].regs[pc as usize]
        } else if pc < 0x400 {
            m.cogs[cog].lut[(pc - 0x200) as usize]
        } else {
            let a = (pc & !3) as usize;
            u32::from_le_bytes([m.hub[a], m.hub[a + 1], m.hub[a + 2], m.hub[a + 3]])
        };
        let mn = match decode(w) {
            Some(d) => d.op.mnemonic(),
            None => "<undecoded>",
        };
        *hist.entry(mn).or_default() += 1;
        if pc < 0x400 {
            *cog_hist.entry(mn).or_default() += 1;
            n_cog += 1;
        }
        n += 1;
        if let Err(t) = m.step(1) {
            eprintln!("TRAP after {n}: {t}");
            break;
        }
    }

    if std::env::var_os("P2CORE_COG_ONLY").is_some() {
        hist = cog_hist;
        eprintln!("cog-space fetches: {n_cog} of {n} ({:.2}%)",
                  100.0 * n_cog as f64 / n as f64);
        n = n_cog.max(1);
    }
    let mut v: Vec<_> = hist.into_iter().collect();
    v.sort_by_key(|&(_, c)| std::cmp::Reverse(c));
    eprintln!("{n} instructions, {} distinct mnemonics", v.len());
    let mut cum = 0u64;
    for (m_, c) in &v {
        cum += c;
        println!("{:>12} {:>10} {:6.2}% {:6.2}% cum", m_, c,
                 100.0 * *c as f64 / n as f64, 100.0 * cum as f64 / n as f64);
    }
}
