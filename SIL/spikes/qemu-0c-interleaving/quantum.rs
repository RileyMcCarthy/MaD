//! Spike 0c, half 1: does the firmware actually REQUIRE 1-instruction cog
//! interleaving, or will it tolerate a quantum?
//!
//! `p2core` schedules the running cog with the smallest clock, one instruction
//! at a time. QEMU's round-robin TCG cannot do that — it interleaves vCPUs at
//! translation-block / icount-budget granularity. If the firmware's observable
//! behaviour is identical at a quantum of Q instructions, QEMU may use Q. If it
//! diverges at Q=2, the whole approach is dead.
//!
//! "Observable behaviour" here is everything that leaves the CPU: the bytes on
//! every pin, the console text, the pin edge count, guest time, and where each
//! cog ended up. Anything a peripheral or the host could see.

use p2core::{Board, Machine, SdCard, NUM_COGS};

/// Run `budget` instructions, stepping the frontier cog `q` at a time.
fn run(image: &[u8], budget: u64, q: u64) -> Sig {
    let mut m = Machine::new(image, Board::new(SdCard::blank(32 * 1024 * 1024)));
    let mut ran = 0u64;
    'outer: while ran < budget {
        // Same frontier choice p2core makes; only the run length differs.
        let Some(cog) = (0..NUM_COGS)
            .filter(|&i| m.cogs[i].running)
            .min_by_key(|&i| m.cogs[i].clocks)
        else {
            break;
        };
        for _ in 0..q {
            if ran >= budget || !m.cogs[cog].running {
                break;
            }
            if m.step_one_pub(cog).is_err() {
                break 'outer;
            }
            ran += 1;
        }
    }
    Sig {
        ran,
        guest_us: m.now_us(),
        console: m.pins.console(),
        bytes: m.pins.byte_counts,
        edges: m.pins.edge_count,
        drives: m.drives,
        pin_reads: m.pin_reads,
        pcs: std::array::from_fn(|i| m.cogs[i].pc),
        running: std::array::from_fn(|i| m.cogs[i].running),
    }
}

struct Sig {
    ran: u64,
    guest_us: u64,
    console: String,
    bytes: [u64; 64],
    edges: u64,
    drives: u64,
    pin_reads: u64,
    pcs: [u32; NUM_COGS],
    running: [bool; NUM_COGS],
}

impl Sig {
    fn tx_pins(&self) -> Vec<(usize, u64)> {
        self.bytes
            .iter()
            .enumerate()
            .filter(|(_, n)| **n != 0)
            .map(|(i, n)| (i, *n))
            .collect()
    }
}

fn main() {
    let path = std::env::args().nth(1).expect("usage: quantum <image> [budget]");
    let budget: u64 = std::env::args()
        .nth(2)
        .and_then(|s| s.parse().ok())
        .unwrap_or(60_000_000);
    let image = std::fs::read(&path).expect("read image");

    let base = run(&image, budget, 1);
    println!(
        "reference (quantum=1): {} instructions, guest {:.4} s, console {} B, \
         {} pin bytes on {} pins, {} drives, {} pin reads",
        base.ran,
        base.guest_us as f64 / 1e6,
        base.console.len(),
        base.bytes.iter().sum::<u64>(),
        base.tx_pins().len(),
        base.drives,
        base.pin_reads
    );
    println!("  per-pin bytes: {:?}", base.tx_pins());
    println!();
    println!(
        "{:>8}  {:>10}  {:>9}  {:>8}  {:>9}  {:>7}  {:>8}",
        "quantum", "guest us", "vs ref", "console", "pin bytes", "drives", "verdict"
    );

    for q in [1u64, 8, 16, 24, 32, 48, 64] {
        let s = run(&image, budget, q);
        let same_console = s.console == base.console;
        let same_bytes = s.bytes == base.bytes;
        let same_pcs = s.pcs == base.pcs && s.running == base.running;
        let drift = (s.guest_us as f64 - base.guest_us as f64) / base.guest_us.max(1) as f64;
        let verdict = if same_console && same_bytes && same_pcs {
            "identical"
        } else if same_console && same_bytes {
            "same I/O"
        } else if same_console {
            "console ok"
        } else {
            "DIVERGED"
        };
        println!(
            "{q:>8}  {:>10}  {:>8.3}%  {:>8}  {:>9}  {:>7}  {:>8}",
            s.guest_us,
            drift * 100.0,
            if same_console { "same" } else { "DIFF" },
            if same_bytes { "same" } else { "DIFF" },
            s.drives,
            verdict
        );
        if !same_console {
            let common = base
                .console
                .bytes()
                .zip(s.console.bytes())
                .take_while(|(a, b)| a == b)
                .count();
            println!(
                "           first console divergence at byte {common} of {} (ref) / {} (this)",
                base.console.len(),
                s.console.len()
            );
        }
        if !same_bytes {
            let diffs: Vec<String> = (0..64)
                .filter(|&i| base.bytes[i] != s.bytes[i])
                .map(|i| format!("pin{i}: {} -> {}", base.bytes[i], s.bytes[i]))
                .collect();
            println!("           pin byte diffs: {}", diffs.join(", "));
        }
    }
    println!("\nedges ref={} ; a quantum is USABLE only where I/O is identical.", base.edges);
}
