//! Run until a trap, then dump the faulting context: the cached block that was
//! executing, and the registers it was using.
use p2core::{decode, Machine, SmartPins};

fn main() {
    let path = std::env::args().nth(1).expect("usage: attrap <image>");
    let image = std::fs::read(&path).expect("read image");
    let mut m = Machine::new(&image, SmartPins::default());
    if let Some(r) = std::env::args().nth(2) {
        m.reg_watch = u16::from_str_radix(r.trim_start_matches('$'), 16).ok();
    }

    let err = match m.step(600_000_000) {
        Ok(n) => {
            println!("no trap in {n} instructions");
            return;
        }
        Err(e) => e,
    };
    println!("TRAP: {err}\n");

    let cog = err.cog() as usize;
    println!("cog RAM around the fault:");
    for i in 0..10u32 {
        let w = m.cogs[cog].regs[i as usize];
        let t = decode(w)
            .map(|d| {
                format!(
                    "{:8} cond={:2} D=${:03X} S=${:03X}{}",
                    d.op.mnemonic(), d.cond, d.d, d.s, if d.i { " #" } else { "" }
                )
            })
            .unwrap_or_else(|| "<undecoded>".into());
        let mark = if i == m.cogs[cog].pc { " <-- pc" } else { "" };
        println!("  cog${i:03X} {w:08X}  {t}{mark}");
    }
    println!("\nregisters referenced by the faulting instruction:");
    let pc = m.cogs[cog].pc as usize;
    if let Some(d) = decode(m.cogs[cog].regs[pc]) {
        println!("  D ${:03X} = {:08X}", d.d, m.cogs[cog].regs[(d.d & 0x1FF) as usize]);
        println!("  S ${:03X} = {:08X}", d.s, m.cogs[cog].regs[(d.s & 0x1FF) as usize]);
    }
    if m.reg_watch.is_some() {
        let n = m.reg_hits.len();
        println!("\nlast writes to the watched register:");
        let target = std::env::var("P2CORE_REG_VALUE").ok().and_then(|s| u32::from_str_radix(s.trim_start_matches('$'), 16).ok());
        let _ = n;
        for (pc, v) in m.reg_hits.iter().filter(|(_, v)| target.is_none_or(|t| *v == t)).take(10) {
            println!("  pc=${pc:05X}  <- {v:08X}");
        }
    }
    println!("\nlocals $145..$16C:");
    for r in (0x145..0x16D).step_by(1) {
        let v = m.cogs[cog].regs[r];
        if v != 0 {
            println!("  ${r:03X} = {v:08X}");
        }
    }
}
