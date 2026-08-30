//! How slow would carrying *everything* as bit edges actually be?
//!
//! Serial edges were measured in-situ (`examples/cost.rs`) and are free, but
//! serial is event-sparse. The continuous signals — the step pulse train and
//! its quadrature encoder — produce edges proportional to simulated time times
//! frequency, and the firmware isn't stepping in a plain boot, so their cost
//! has to be measured directly rather than read off a run.
//!
//! This pushes edges through the same queue-and-decode path the board uses, at
//! the volumes those signals imply, so the per-edge cost is measured at scale
//! (where cache behaviour differs from a 3M-edge run) rather than extrapolated.
use std::collections::VecDeque;
use std::time::Instant;

/// One edge: virtual timestamp and level, exactly as `Board` queues them.
fn run_edges(n: u64) -> (f64, u64) {
    let mut q: VecDeque<(u64, bool)> = VecDeque::with_capacity(1024);
    let mut sink = 0u64;
    let t0 = Instant::now();
    let mut i = 0u64;
    while i < n {
        // Produce a burst, then drain it — a queue that grows without bound is
        // not what an event loop does.
        for k in 0..64u64 {
            q.push_back((i + k, k & 1 == 0));
        }
        while let Some((t, level)) = q.pop_front() {
            sink = sink.wrapping_add(t + level as u64);
        }
        i += 64;
    }
    (t0.elapsed().as_secs_f64(), sink)
}

fn main() {
    // Baseline for reference: 400M instructions took ~11.9 s.
    const BASELINE_S: f64 = 11.92;
    const SIM_S: f64 = 1097.0;

    println!("edge-machinery cost at scale\n");
    println!("{:>16}  {:>10}  {:>12}", "edges", "wall", "ns/edge");
    let mut per_edge = 0.0;
    for n in [10_000_000u64, 100_000_000, 439_000_000] {
        let (secs, _) = run_edges(n);
        per_edge = secs / n as f64 * 1e9;
        println!("{n:>16}  {secs:>9.2}s  {per_edge:>11.1}");
    }

    println!("\nprojected cost of running everything per-edge");
    println!("(baseline {BASELINE_S:.1}s wall for {SIM_S:.0}s simulated)\n");
    println!("{:<30}{:>14}{:>12}{:>12}", "scenario", "edges", "added", "total");
    for (name, steps_per_s) in [
        ("idle (serial only)", 0.0),
        ("slow move, 10k steps/s", 10e3),
        ("fast move, 100k steps/s", 100e3),
        ("1M steps/s", 1e6),
    ] {
        // Two edges per step on the pulse train, four on the quadrature pair.
        let edges = (steps_per_s * 6.0 * SIM_S) + 3.147_910e6;
        let added = edges * per_edge / 1e9;
        println!(
            "{name:<30}{edges:>14.3e}{added:>11.1}s{:>11.1}s",
            BASELINE_S + added
        );
    }
}
