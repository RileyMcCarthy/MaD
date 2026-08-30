//! Inspect one FCACHE load: PA (block length), PTRB, and what landed in cog RAM.
use p2core::{decode, Machine, NullPins};

fn main() {
    let path = std::env::args().nth(1).expect("usage: fcache <image> [skip]");
    let mut skip: u32 = std::env::args().nth(2).and_then(|s| s.parse().ok()).unwrap_or(0);
    let image = std::fs::read(&path).expect("read image");
    let mut m = Machine::new(&image, NullPins);
    m.strict_hub = false;

    // cog $114 is FCACHE_LOAD_'s `jmp #\$0`: the load has just completed.
    for _ in 0..20_000_000u64 {
        if m.cogs[0].pc == 0x114 {
            if skip > 0 { skip -= 1; } else { break; }
        }
        if m.step(1).is_err() { break; }
    }
    let pa = m.cogs[0].regs[0x1F6];
    let ptrb = m.cogs[0].regs[0x1F9];
    println!("at FCACHE jmp: PA(len)={pa}  PTRB(next)=${ptrb:05X}  src=${:05X}", ptrb - (pa + 1) * 4);
    println!("cog RAM after the load:");
    for i in 0..(pa + 3).min(10) {
        let w = m.cogs[0].regs[i as usize];
        let d = decode(w)
            .map(|d| format!("{:8} cond={:2} D=${:03X} S=${:03X}", d.op.mnemonic(), d.cond, d.d, d.s))
            .unwrap_or_else(|| "<undecoded>".into());
        let tag = if i == pa { "  <-- cog[PA], where ALTD put the _ret_ terminator" } else { "" };
        println!("   cog${i:03X} {w:08X}  {d}{tag}");
    }
}
