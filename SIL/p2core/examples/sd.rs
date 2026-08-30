//! Run the firmware against a modelled SD card and report what it asked for.
use p2core::{Board, Machine, SdCard};

fn main() {
    let path = std::env::args().nth(1).expect("usage: sd <image> [budget] [disk]");
    let budget: u64 = std::env::args().nth(2).and_then(|s| s.parse().ok()).unwrap_or(200_000_000);
    let disk = std::env::args().nth(3);

    let image = std::fs::read(&path).expect("read image");
    let card = match disk {
        Some(d) => SdCard::with_image(std::fs::read(d).expect("read disk image")),
        // 32 MB of zeros: the card answers, but there is no filesystem on it.
        None => SdCard::blank(32 * 1024 * 1024),
    };
    let mut card = card;
    card.trace = Some(Vec::new());
    let mut m = Machine::new(&image, Board::new(card));
    m.strict_hub = false;
    let r = m.step(budget);

    println!("--- console ---\n{}\n--- ---", m.pins.console());
    match r {
        Ok(n) => println!("ran {n} instructions"),
        Err(t) => println!("TRAP: {t}"),
    }
    println!("card initialised: {}", m.pins.card.initialised);
    let cmds = &m.pins.card.commands;
    println!("{} SD commands issued; first 24:", cmds.len());
    let names: Vec<String> = cmds
        .iter()
        .take(24)
        .map(|c| if c & 0x80 != 0 { format!("ACMD{}", c & 0x3F) } else { format!("CMD{c}") })
        .collect();
    println!("  {}", names.join(" "));
    println!("first 8 WYPIN values on DI (what the driver hands the shifter):");
    for v in m.pins.di_log.iter().take(8) {
        println!("  {v:08X}  -> wire bytes {:02X} {:02X} {:02X} {:02X}",
            (v.reverse_bits() >> 24) as u8, (v.reverse_bits() >> 16) as u8,
            (v.reverse_bits() >> 8) as u8, v.reverse_bits() as u8);
    }
    if let Some(log) = &m.pins.card.trace {
        println!("{} byte exchanges; first 32 (mosi -> miso):", log.len());
        let s: Vec<String> = log.iter().take(64).map(|(a, b)| format!("{a:02X}>{b:02X}")).collect();
        println!("  {}", s.join(" "));
    }
}
