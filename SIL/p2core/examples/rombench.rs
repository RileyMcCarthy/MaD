//! How long the ROM boot chain takes, and where it finishes.
//!
//! Two separate numbers people conflate: how many instructions the boot COSTS,
//! and how fast an engine retires them. The first is a property of the ROM, the
//! second of the simulator, and only the second is worth comparing between
//! engines.
use std::time::Instant;

use p2core::{Board, Machine, SdCard};

fn main() {
    let steps: u64 = std::env::args()
        .nth(1)
        .and_then(|s| s.parse().ok())
        .unwrap_or(4_000_000);
    let rom = std::fs::read(std::env::var_os("P2STATE_ROM").expect("P2STATE_ROM")).expect("rom");
    let flash = std::env::var_os("P2STATE_FLASH")
        .map(|p| std::fs::read(p).expect("flash"))
        .unwrap_or_default();

    let mut m = Machine::with_boot_rom(&rom, Board::new(SdCard::blank(0)).with_flash(flash));
    m.pins.set_input_level(61, true);
    m.strict_hub = false;

    let start = Instant::now();
    let mut n = 0u64;
    let mut done_at = None;
    for _ in 0..steps {
        if m.step(1).unwrap_or(0) == 0 {
            break;
        }
        n += 1;
        // The payload's byte is the end of the chain; keep running afterwards so
        // the throughput number is not dominated by the boot's slow start.
        if done_at.is_none() && m.pins.console().contains('B') {
            done_at = Some(n);
        }
    }
    let dt = start.elapsed();

    println!("boot completed at   : {:?} instructions", done_at);
    println!("flash reads         : {:?}", m.pins.flash.reads);
    println!("console             : {:?}", m.pins.console());
    println!("ran                 : {n} instructions in {dt:.3?}");
    println!("throughput          : {:.2} M instr/s", n as f64 / dt.as_secs_f64() / 1e6);
    // The P2 runs 2 clocks per instruction at 20 MHz stock, so a "real time"
    // ratio needs the cog's own clock rather than an instruction count.
    let clocks = m.cogs[0].clocks;
    println!("cog 0 virtual clocks: {clocks}  ({:.3} s of P2 time at 20 MHz)",
             clocks as f64 / 20e6);
    println!("speed vs a 20 MHz P2: {:.2}x real time",
             (clocks as f64 / 20e6) / dt.as_secs_f64());
}
