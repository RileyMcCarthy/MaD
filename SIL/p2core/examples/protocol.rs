//! Run the firmware with a full board and report the protocol link traffic.
use p2core::{Board, Machine, SdCard};

fn main() {
    let path = std::env::args().nth(1).expect("usage: protocol <image> [budget]");
    let budget: u64 = std::env::args().nth(2).and_then(|s| s.parse().ok()).unwrap_or(400_000_000);
    let image = std::fs::read(&path).expect("read image");
    let mut m = Machine::new(&image, Board::new(SdCard::blank(32 * 1024 * 1024)));
    // Let the machine finish booting, then ask for the firmware version:
    // [SYNC, READ, READ_FIRMWARE_VERSION] per the generated runtime.
    let r = m.step(budget / 2);
    let before = m.pins.proto_tx.len();
    m.pins.send_protocol(&[0x55, 0x00, 0x03]);
    let r = r.and(m.step(budget / 2));
    println!("protocol TX before request: {before} bytes");

    match r {
        Ok(n) => println!("ran {n} instructions"),
        Err(t) => println!("TRAP: {t}"),
    }
    println!("virtual time: {} us", m.now_us());
    println!("cogs running: {}", m.cogs.iter().filter(|c| c.running).count());

    let clk = m.clkfreq();
    println!("\nsmart pins as the firmware programmed them (clkfreq {clk}):");
    for pin in 0..64u8 {
        if !m.pins.is_configured(pin) {
            continue;
        }
        let baud = match m.pins.baud_of(pin, clk) {
            Some(b) => format!("{b} baud"),
            None => "-".to_string(),
        };
        println!("  pin {pin:2}: {:?}  {baud}", m.pins.mode_of(pin));
    }
    let unmodelled = m.pins.unmodelled_modes();
    if !unmodelled.is_empty() {
        println!("  UNMODELLED: {unmodelled:02X?}");
    }

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
