//! Watch the guest compute `_getus`: the two GETCT halves and the divisor.
use p2core::{Machine, SmartPins};

fn main() {
    let path = std::env::args().nth(1).expect("usage: getus <image>");
    let image = std::fs::read(&path).expect("read image");
    let mut m = Machine::new(&image, SmartPins::default());
    // __system___getus entry, from program.p2asm.
    let target: u32 = std::env::var("GETUS_PC")
        .ok()
        .and_then(|s| u32::from_str_radix(s.trim_start_matches('$'), 16).ok())
        .unwrap_or(0);
    let mut seen = 0;
    for _ in 0..40_000_000u64 {
        if target != 0 && m.cogs[0].pc == target {
            seen += 1;
            if seen > 3 {
                println!("at _getus entry #{seen}: clocks={} (hi={} lo={})",
                    m.cogs[0].clocks,
                    (m.cogs[0].clocks >> 32) as u32,
                    m.cogs[0].clocks as u32);
                // step through the two getct reads
                for i in 0..2 {
                    m.step(1).unwrap();
                    println!("  after getct #{i}: result2=${:08X} _var01=${:08X}",
                        m.cogs[0].regs[0x14F], m.cogs[0].regs[0x166]);
                }
                return;
            }
        }
        if m.step(1).is_err() { break; }
    }
    println!("never reached target");
}
