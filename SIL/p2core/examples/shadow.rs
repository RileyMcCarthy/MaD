//! Compare the 8-level hardware stack against an unbounded shadow.
//!
//! The P2's call stack is a ring: overflowing it silently returns a stale
//! address instead of faulting. Mirroring every push/pop into a Vec makes the
//! first divergence — and its depth — obvious.
use p2core::{Machine, SmartPins};

fn main() {
    let path = std::env::args().nth(1).expect("usage: shadow <image> [steps]");
    let steps: u64 = std::env::args().nth(2).and_then(|s| s.parse().ok()).unwrap_or(60_000_000);
    let image = std::fs::read(&path).expect("read image");
    let mut m = Machine::new(&image, SmartPins::default());
    m.trace_stack = true;
    let _ = m.step(steps);

    let mut shadow: Vec<u32> = Vec::new();
    let mut max_depth = 0usize;
    let mut first_bad: Option<(usize, u32, u32, u32)> = None;
    let mut underflows = 0usize;

    for (i, (_cog, pc, is_push, v)) in m.stack_log.iter().enumerate() {
        if *is_push {
            shadow.push(*v);
            max_depth = max_depth.max(shadow.len());
        } else {
            match shadow.pop() {
                None => {
                    if underflows < 8 {
                        println!("  UNDERFLOW at op {i}: pc=${pc:05X} popped {v:08X}");
                    }
                    underflows += 1;
                }
                Some(expect) if expect != *v && first_bad.is_none() => {
                    first_bad = Some((i, *pc, expect, *v));
                }
                _ => {}
            }
        }
    }

    println!("stack ops: {}", m.stack_log.len());
    println!("max depth: {max_depth}  (hardware ring holds 8)");
    println!("underflows: {underflows}");
    match first_bad {
        None => println!("no divergence: every pop matched its push"),
        Some((i, pc, expect, got)) => println!(
            "first divergence at op {i}: pc=${pc:05X} expected {expect:08X}, hardware gave {got:08X}"
        ),
    }
    // Show the traffic around the divergence.
    if let Some((i, _, _, _)) = first_bad {
        println!("\ncontext:");
        for (cog, pc, is_push, v) in m.stack_log.iter().skip(i.saturating_sub(12)).take(18) {
            println!("  cog{cog} ${pc:05X} {} {v:08X}", if *is_push { "PUSH" } else { "POP " });
        }
    }
}
