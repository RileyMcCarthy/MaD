//! How many instructions does p2core's idle-poll fast-forward SKIP?
//!
//! Decisive for the QEMU plan: p2core's "0.19x real time" is achieved while
//! ELIDING spin-loop instructions. A TCG target has no such mechanism and must
//! execute every one of them, so the instruction budget for 1.0x real time is
//! this multiplier times larger than the naive figure.
use std::time::Instant;
use p2core::{Board, Machine, SdCard};

fn main() {
    let path = std::env::args().nth(1).unwrap();
    let ms: u64 = std::env::args().nth(2).and_then(|s| s.parse().ok()).unwrap_or(100);
    let image = std::fs::read(&path).unwrap();
    let mut m = Machine::new(&image, Board::new(SdCard::blank(32 * 1024 * 1024)));
    let t = Instant::now();
    let _ = m.step_until(ms * 1000);
    let wall = t.elapsed().as_secs_f64();
    println!(
        "guest {:.4} s | retired {} | wall {:.2} s | {:.2} M inst/s | {:.4}x real | ff {}",
        m.now_us() as f64 / 1e6,
        m.retired,
        wall,
        m.retired as f64 / wall / 1e6,
        (m.now_us() as f64 / 1e6) / wall,
        if std::env::var_os("P2CORE_NO_FF").is_some() { "OFF" } else { "on" }
    );
    println!("  instructions per second of GUEST time: {:.1} M",
        m.retired as f64 / (m.now_us() as f64 / 1e6) / 1e6);
}
