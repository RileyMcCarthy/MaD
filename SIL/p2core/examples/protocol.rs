//! Run the firmware with a full board and report the protocol link traffic.
use p2core::{Board, Machine, SdCard};

fn main() {
    let path = std::env::args().nth(1).expect("usage: protocol <image> [budget]");
    let budget: u64 = std::env::args().nth(2).and_then(|s| s.parse().ok()).unwrap_or(400_000_000);
    let image = std::fs::read(&path).expect("read image");
    let mut m = Machine::new(&image, Board::new(SdCard::blank(32 * 1024 * 1024)));
    let r = m.step(budget);

    match r {
        Ok(n) => println!("ran {n} instructions"),
        Err(t) => println!("TRAP: {t}"),
    }
    println!("virtual time: {} us", m.now_us());
    println!("cogs running: {}", m.cogs.iter().filter(|c| c.running).count());

    let tx = &m.pins.proto_tx;
    println!("\nprotocol TX: {} bytes", tx.len());
    if !tx.is_empty() {
        let n = tx.len().min(48);
        println!(
            "  first {n}: {}",
            tx[..n].iter().map(|b| format!("{b:02X}")).collect::<Vec<_>>().join(" ")
        );
        let txt: String = tx[..n]
            .iter()
            .map(|&b| if (0x20..0x7F).contains(&b) { b as char } else { '.' })
            .collect();
        println!("  as text: \"{txt}\"");
    }
}
