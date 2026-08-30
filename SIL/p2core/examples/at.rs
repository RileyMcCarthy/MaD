//! Trace N instructions starting the Kth time a PC is reached, with values.
use p2core::{decode, Machine, SmartPins};

fn main() {
    let mut a = std::env::args().skip(1);
    let path = a.next().expect("usage: at <image> <pc> [count] [skip]");
    let target = u32::from_str_radix(a.next().expect("pc").trim_start_matches('$'), 16).unwrap();
    let count: usize = a.next().and_then(|s| s.parse().ok()).unwrap_or(20);
    let mut skip: u32 = a.next().and_then(|s| s.parse().ok()).unwrap_or(0);

    let image = std::fs::read(&path).expect("read image");
    let mut m = Machine::new(&image, SmartPins::default());
    m.strict_hub = false;
    for _ in 0..30_000_000u64 {
        if m.cogs[0].pc == target {
            if skip > 0 { skip -= 1; } else { break; }
        }
        if m.step(1).is_err() { break; }
    }
    if m.cogs[0].pc != target {
        println!("never reached ${target:05X}");
        return;
    }
    println!("clocks={} (hi={} lo={}) clkfreq={}",
        m.cogs[0].clocks, (m.cogs[0].clocks >> 32) as u32,
        m.cogs[0].clocks as u32, m.clkfreq());
    for _ in 0..count {
        let pc = m.cogs[0].pc;
        let w = if pc < 0x200 { m.cogs[0].regs[pc as usize] } else {
            let o = pc as usize;
            u32::from_le_bytes([m.hub[o], m.hub[o+1], m.hub[o+2], m.hub[o+3]])
        };
        let d = decode(w);
        let txt = d.map(|d| format!("{:8} D=${:03X} S=${:03X}{}{}", d.op.mnemonic(), d.d, d.s,
                                    if d.i {" #"} else {"  "}, if d.c {" wc"} else {""}))
                   .unwrap_or_else(|| "?".into());
        let (dv, sv) = match d {
            Some(d) => (m.cogs[0].regs[(d.d & 0x1FF) as usize],
                        if d.i { d.s as u32 } else { m.cogs[0].regs[(d.s & 0x1FF) as usize] }),
            None => (0, 0),
        };
        println!("${pc:05X} {w:08X} {txt}  D={dv:12} S={sv:12}");
        if m.step(1).is_err() { break; }
    }
}
