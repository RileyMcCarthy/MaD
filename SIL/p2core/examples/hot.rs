//! Where is the guest spending its instructions? Tells "making progress" from
//! "spinning on a peripheral that never becomes ready".
use std::collections::HashMap;

use p2core::{Machine, SmartPins};

fn main() {
    let path = std::env::args().nth(1).expect("usage: hot <image> [steps]");
    let steps: u64 = std::env::args().nth(2).and_then(|s| s.parse().ok()).unwrap_or(2_000_000);
    let image = std::fs::read(&path).expect("read image");
    let mut m = Machine::new(&image, SmartPins::default());
    m.strict_hub = false;
    let mut hist: HashMap<u32, u64> = HashMap::new();

    for _ in 0..steps {
        *hist.entry(m.cogs[0].pc).or_default() += 1;
        if let Err(t) = m.step(1) {
            println!("TRAP: {t}");
            break;
        }
    }
    let mut v: Vec<_> = hist.into_iter().collect();
    v.sort_by_key(|&(_, n)| std::cmp::Reverse(n));
    println!("distinct PCs: {}", v.len());
    let show: usize = std::env::var("P2CORE_TOP").ok().and_then(|s| s.parse().ok()).unwrap_or(14);
    for (pc, n) in v.iter().take(show) {
        println!("  ${pc:05X}  {n:>9}");
    }
}
