//! Slice-A probe: boot the real flexcc image and report where it stops.
//!
//! Run with the debug image (MAIN on the hardware UART rather than FlexC's
//! `_txraw`):
//!
//! ```text
//! cargo run -p p2core --release --example boot -- \
//!     ../../Firmware/MaDCore/.pio/build/propeller2_debug/program
//! ```
//!
//! Also prints sustained instruction throughput, which is the number that
//! decides whether this approach survives contact with the e2e suite.

use std::time::Instant;

use p2core::{Machine, NullPins};

fn main() {
    let path = std::env::args().nth(1).unwrap_or_else(|| {
        "../Firmware/MaDCore/.pio/build/propeller2_debug/program".to_string()
    });
    let budget: u64 = std::env::args()
        .nth(2)
        .and_then(|s| s.parse().ok())
        .unwrap_or(5_000_000);

    let image = match std::fs::read(&path) {
        Ok(b) => b,
        Err(e) => {
            eprintln!("cannot read {path}: {e}");
            eprintln!("build it first: cd Firmware/MaDCore && pio run -e propeller2_debug");
            std::process::exit(2);
        }
    };
    println!("image {path}: {} bytes", image.len());

    let mut m = Machine::new(&image, NullPins);
    // Silicon wraps hub addresses; opt out of the bring-up trap with an env var.
    if std::env::var_os("P2CORE_LAX_HUB").is_some() {
        m.strict_hub = false;
    }
    let start = Instant::now();
    let outcome = m.step(budget);
    let elapsed = start.elapsed();

    match outcome {
        Ok(n) => println!("ran {n} instructions with no trap"),
        Err(t) => println!("TRAP: {t}"),
    }

    let mips = m.retired as f64 / elapsed.as_secs_f64() / 1e6;
    println!(
        "retired {} instructions in {:.3}s = {:.1} M inst/s",
        m.retired,
        elapsed.as_secs_f64(),
        mips
    );
    println!("clkfreq recorded: {}", m.clkfreq());
    println!("virtual time: {} us", m.now_us());
    if std::env::var_os("P2CORE_DUMP_COG").is_some() {
        println!("cog 0 RAM $000..$008 (the FCACHE landing zone):");
        for i in 0..8u32 {
            let w = m.cogs[0].regs[i as usize];
            let d = p2core::decode(w)
                .map(|d| format!("{:9} D=${:03X} S=${:03X}{}", d.op.mnemonic(), d.d, d.s,
                                 if d.i { " #" } else { "" }))
                .unwrap_or_else(|| "<undecoded>".into());
            println!("   cog${i:03X} {w:08X}  {d}");
        }
    }
    for (i, c) in m.cogs.iter().enumerate() {
        if c.running || c.clocks > 0 {
            println!(
                "  cog {i}: running={} pc=${:05X} clocks={}",
                c.running, c.pc, c.clocks
            );
        }
    }
}

// (histogram helper lives in examples/hot.rs)
