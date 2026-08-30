//! Measure what an edge-level transport would actually cost.
//!
//! Reports wall time for the run, and how many bit-edges each serial pin would
//! generate if every byte were carried as start + data + stop transitions.
use std::time::Instant;

use p2core::{Board, Machine, SdCard};

fn main() {
    let path = std::env::args().nth(1).expect("usage: cost <image> [budget]");
    let budget: u64 = std::env::args().nth(2).and_then(|s| s.parse().ok()).unwrap_or(400_000_000);
    let image = std::fs::read(&path).expect("read image");
    let edge = std::env::var_os("P2CORE_EDGE_LEVEL").is_some();
    let mut m = Machine::new(&image, Board::new(SdCard::blank(32 * 1024 * 1024)));
    m.pins.edge_level = edge;
    m.pins.edge_mult = std::env::var("P2CORE_EDGE_MULT").ok().and_then(|s| s.parse().ok()).unwrap_or(1);
    println!("transport: {}", if edge { "bit edges" } else { "whole bytes" });

    let t0 = Instant::now();
    let _ = m.step(budget);
    let elapsed = t0.elapsed();

    println!(
        "baseline: {} instructions in {:.2}s ({:.1} M inst/s)",
        m.retired,
        elapsed.as_secs_f64(),
        m.retired as f64 / elapsed.as_secs_f64() / 1e6
    );
    println!("virtual time: {:.3} s", m.now_us() as f64 / 1e6);
    println!("edges actually carried: {}\n", m.pins.edge_count);

    let mut total_bytes = 0u64;
    let mut total_edges = 0u64;
    println!("{:>4}  {:>12}  {:>14}", "pin", "bytes", "edges (x10)");
    for pin in 0..64u8 {
        let n = m.pins.byte_counts[pin as usize];
        if n == 0 {
            continue;
        }
        // A UART byte is start + 8 data + stop; worst case every bit toggles.
        let edges = n * 10;
        total_bytes += n;
        total_edges += edges;
        println!("{pin:>4}  {n:>12}  {edges:>14}");
    }
    println!("\ntotal bytes: {total_bytes}");
    println!("total edges if bit-level: {total_edges}");
    println!(
        "edges per second of wall time at this rate: {:.0}",
        total_edges as f64 / elapsed.as_secs_f64()
    );
    println!(
        "edges as a share of instructions: {:.4}%",
        total_edges as f64 / m.retired as f64 * 100.0
    );
}
