//! Catch the instant the PC leaves valid code, and print the trail that led
//! there. A wrong branch or return shows up as a plausible-looking jump a few
//! instructions before the PC lands somewhere impossible.

use p2core::{decode, Machine, SmartPins};

fn main() {
    let path = std::env::args().nth(1).expect("usage: runaway <image>");
    let image = std::fs::read(&path).expect("read image");
    let mut m = Machine::new(&image, SmartPins::default());
    let img_end = image.len() as u32;

    // Optional: stop as soon as any cog reaches this PC, and print the trail.
    let stop_at: Option<u32> = std::env::var("P2CORE_STOP_AT")
        .ok()
        .and_then(|s| u32::from_str_radix(s.trim_start_matches('$'), 16).ok());
    // Skip the first N hits: an address reached legitimately during boot is
    // only interesting the *second* time something returns to it.
    let mut skip_hits: u32 = std::env::var("P2CORE_SKIP_HITS")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(0);

    let mut trail: Vec<(usize, u32, u32)> = Vec::new();
    let dump = |why: &str, trail: &Vec<(usize, u32, u32)>| {
        println!("{why}; transfer trail:");
        for (c, p, w) in trail.iter().rev().take(20).rev() {
            let t = decode(*w)
                .map(|d| format!("{} D=${:03X} S=${:03X}{}", d.op.mnemonic(), d.d, d.s,
                                 if d.i { " #" } else { "" }))
                .unwrap_or_else(|| "<undecoded>".into());
            println!("   cog{c} ${p:05X} {w:08X}  {t}");
        }
    };
    for _ in 0..60_000_000u64 {
        let Some(cog) = (0..8).find(|&i| m.cogs[i].running) else {
            dump("all cogs stopped", &trail);
            return;
        };
        if Some(m.cogs[cog].pc) == stop_at && {
            if skip_hits > 0 {
                skip_hits -= 1;
                false
            } else {
                true
            }
        } {
            dump(&format!("reached ${:05X}", m.cogs[cog].pc), &trail);
            return;
        }
        let pc = m.cogs[cog].pc;
        // Valid: cog RAM, LUT holding real code, or hub inside the image.
        let sane = pc < 0x200 || (pc >= 0x400 && pc < img_end);
        if !sane {
            println!("PC left valid code at ${pc:05X} (cog {cog}); trail:");
            for (c, p, w) in trail.iter().rev().take(16).rev() {
                let t = decode(*w)
                    .map(|d| format!("{} D=${:03X} S=${:03X}{}", d.op.mnemonic(), d.d, d.s,
                                     if d.i { " #" } else { "" }))
                    .unwrap_or_else(|| "<undecoded>".into());
                println!("   cog{c} ${p:05X} {w:08X}  {t}");
            }
            return;
        }
        let word = if pc < 0x200 {
            m.cogs[cog].regs[pc as usize]
        } else {
            let a = pc as usize;
            u32::from_le_bytes([m.hub[a], m.hub[a + 1], m.hub[a + 2], m.hub[a + 3]])
        };
        // Record only non-sequential transfers: a NOP slide through zeroed cog
        // RAM would otherwise flush the real cause out of the trail.
        if let Err(err) = m.step(1) {
            println!("TRAP: {err}\ntrail (calls/returns then last instructions):");
            for (c, p, w) in trail.iter().rev().take(14).rev() {
                let t = decode(*w)
                    .map(|d| format!("{} D=${:03X} S=${:03X}{}", d.op.mnemonic(), d.d, d.s,
                                     if d.i { " #" } else { "" }))
                    .unwrap_or_else(|| "<undecoded>".into());
                println!("   cog{c} ${p:05X} {w:08X}  {t}");
            }
            return;
        }
        // Only calls and returns: a tight FCACHE loop would otherwise flush
        // the call chain out of the trail.
        if true {
            trail.push((cog, pc, word));
            if trail.len() > 24 {
                trail.remove(0);
            }
        }
    }
    println!("no runaway within budget; pc=${:05X}", m.cogs[0].pc);
}
