//! Instruction trace, for bringing up the boot path.
//!
//! ```text
//! cargo run -p p2core --example trace -- <image> [count] [skip]
//! ```

use p2core::{decode, Machine, NullPins};

fn main() {
    let mut args = std::env::args().skip(1);
    let path = args.next().expect("usage: trace <image> [count] [skip]");
    let count: u64 = args.next().and_then(|s| s.parse().ok()).unwrap_or(40);
    let skip: u64 = args.next().and_then(|s| s.parse().ok()).unwrap_or(0);

    let image = std::fs::read(&path).expect("read image");
    let mut m = Machine::new(&image, NullPins);

    if skip > 0 {
        if let Err(t) = m.step(skip) {
            println!("trap during skip: {t}");
            return;
        }
    }

    for _ in 0..count {
        let Some(cog) = (0..8).find(|&i| m.cogs[i].running) else {
            println!("all cogs stopped");
            return;
        };
        let pc = m.cogs[cog].pc;
        let word = if pc < 0x200 {
            m.cogs[cog].regs[pc as usize]
        } else if pc < 0x400 {
            m.cogs[cog].lut[(pc - 0x200) as usize]
        } else {
            let a = pc as usize;
            u32::from_le_bytes([m.hub[a], m.hub[a + 1], m.hub[a + 2], m.hub[a + 3]])
        };
        let text = match decode(word) {
            Some(d) => format!(
                "{:9} cond={:2} D=${:03X} S=${:03X} {}{}{}",
                d.op.mnemonic(),
                d.cond,
                d.d,
                d.s,
                if d.i { "#" } else { "" },
                if d.c { " wc" } else { "" },
                if d.z { " wz" } else { "" }
            ),
            None => "<undecoded>".to_string(),
        };
        let (dv, sv) = match decode(word) {
            Some(d) => (
                m.cogs[cog].regs[(d.d & 0x1FF) as usize],
                if d.i { d.s as u32 } else { m.cogs[cog].regs[(d.s & 0x1FF) as usize] },
            ),
            None => (0, 0),
        };
        println!(
            "cog{cog} ${pc:05X} {word:08X}  {text}   D={dv:08X} S={sv:08X} [c={} z={}]",
            m.cogs[cog].c as u8,
            m.cogs[cog].z as u8,
        );
        if let Err(t) = m.step(1) {
            println!("TRAP: {t}");
            return;
        }
    }
}
