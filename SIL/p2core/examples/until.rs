//! Run an image until the debug console contains a needle, then print it.
//!
//! Used by `tools/hw_compare.py` to capture the hardware-oracle report from
//! the ISS without burning a fixed instruction budget after the program
//! stops.

use p2core::{Machine, SmartPins};

fn main() {
    let path = std::env::args()
        .nth(1)
        .expect("usage: until <image> [needle] [budget]");
    let needle = std::env::args()
        .nth(2)
        .unwrap_or_else(|| "RESULT".to_string());
    let budget: u64 = std::env::args()
        .nth(3)
        .and_then(|s| s.parse().ok())
        .unwrap_or(50_000_000);
    let image = std::fs::read(&path).expect("read image");
    let mut m = Machine::new(&image, SmartPins::default());

    const CHUNK: u64 = 10_000;
    let mut ran = 0u64;
    let mut trap: Option<p2core::Trap> = None;
    while ran < budget {
        let n = CHUNK.min(budget - ran);
        match m.step(n) {
            Ok(k) => {
                ran += k;
                if k < n {
                    break;
                }
            }
            Err(t) => {
                trap = Some(t);
                break;
            }
        }
        if m.pins.console().contains(&needle) {
            break;
        }
    }

    print!("{}", m.pins.console());
    if let Some(t) = trap {
        eprintln!("TRAP: {t}");
    }
    if !m.pins.console().contains(&needle) {
        eprintln!(
            "until: needle {needle:?} not found after {ran} instructions (clkfreq {})",
            m.clkfreq()
        );
        std::process::exit(1);
    }
}
