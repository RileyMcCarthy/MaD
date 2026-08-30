//! Show the hardware-stack traffic leading to a bad return.
//!
//! `stack <image> <bad_target_hex>` — runs until a return lands on the target
//! (skipping the first, legitimate arrival) and prints the surrounding traffic.
use p2core::{Machine, NullPins};

fn main() {
    let mut a = std::env::args().skip(1);
    let path = a.next().expect("usage: stack <image> <target> [skip]");
    let target =
        u32::from_str_radix(a.next().expect("target").trim_start_matches('$'), 16).unwrap();
    let mut skip: u32 = a.next().and_then(|s| s.parse().ok()).unwrap_or(1);

    let image = std::fs::read(&path).expect("read image");
    let mut m = Machine::new(&image, NullPins);
    m.trace_stack = true;
    m.strict_hub = false;

    for _ in 0..20_000_000u64 {
        if m.cogs[0].pc == target {
            if skip > 0 {
                skip -= 1;
            } else {
                break;
            }
        }
        if m.step(1).is_err() {
            break;
        }
    }
    println!("stopped at ${:05X}; last 24 stack ops:", m.cogs[0].pc);
    let n = m.stack_log.len();
    for (cog, pc, is_push, v) in m.stack_log.iter().skip(n.saturating_sub(24)) {
        println!(
            "  cog{cog} at ${pc:05X}  {}  {v:08X}{}",
            if *is_push { "PUSH" } else { "POP " },
            if *v == target { "   <-- the bad address" } else { "" }
        );
    }
}
