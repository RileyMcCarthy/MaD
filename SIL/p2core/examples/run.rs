//! Run the firmware with the bring-up smart-pin model and print its console.
use p2core::{Machine, SmartPins};

fn main() {
    let path = std::env::args().nth(1).expect("usage: run <image> [budget]");
    let budget: u64 = std::env::args().nth(2).and_then(|s| s.parse().ok()).unwrap_or(200_000_000);
    let image = std::fs::read(&path).expect("read image");
    let mut m = Machine::new(&image, SmartPins::default());
    if std::env::var_os("P2CORE_LAX_HUB").is_some() {
        m.strict_hub = false;
    }
    let r = m.step(budget);

    println!("--- console ---\n{}\n--- ---", m.pins.console());
    match r {
        Ok(n) => println!("ran {n} instructions"),
        Err(t) => println!("TRAP: {t}"),
    }
    println!("clkfreq {} | virtual time {} us", m.clkfreq(), m.now_us());
    for (i, c) in m.cogs.iter().enumerate() {
        if c.running || c.clocks > 0 {
            println!("  cog {i}: running={} pc=${:05X}", c.running, c.pc);
        }
    }
}
