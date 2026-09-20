//! Spike 0c: WHAT diverges when the cog quantum grows? Dumps each quantum's
//! console so the difference can be read, not just counted.
use p2core::{Board, Machine, SdCard, NUM_COGS};

fn run(image: &[u8], budget: u64, q: u64) -> String {
    let mut m = Machine::new(image, Board::new(SdCard::blank(32 * 1024 * 1024)));
    let mut ran = 0u64;
    'outer: while ran < budget {
        let Some(cog) = (0..NUM_COGS).filter(|&i| m.cogs[i].running).min_by_key(|&i| m.cogs[i].clocks) else { break };
        for _ in 0..q {
            if ran >= budget || !m.cogs[cog].running { break }
            if m.step_one_pub(cog).is_err() { break 'outer }
            ran += 1;
        }
    }
    m.pins.console()
}

fn main() {
    let path = std::env::args().nth(1).unwrap();
    let budget: u64 = std::env::args().nth(2).and_then(|s| s.parse().ok()).unwrap_or(60_000_000);
    let image = std::fs::read(&path).unwrap();
    for q in [1u64, 32, 48, 64] {
        let c = run(&image, budget, q);
        std::fs::write(format!("/tmp/console-q{q}.txt"), &c).unwrap();
        println!("q={q}: {} bytes -> /tmp/console-q{q}.txt", c.len());
    }
}
