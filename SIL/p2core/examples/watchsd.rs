//! Watch the SD command-frame buffer and report every write to its first byte.
//!
//! `send_cmd` builds the frame with `buf[0] = 0x40 | cmd`, so exactly one write
//! should land there per command. Anything else is the corruption.
use p2core::{Board, Machine, SdCard};

fn main() {
    let path = std::env::args().nth(1).expect("usage: watchsd <image> <addr>");
    let addr = u32::from_str_radix(
        std::env::args().nth(2).unwrap_or_else(|| "4B914".into()).trim_start_matches('$'),
        16,
    )
    .unwrap();
    let image = std::fs::read(&path).expect("read image");
    let mut m = Machine::new(&image, Board::new(SdCard::blank(32 * 1024 * 1024)));
    m.strict_hub = false;
    m.watch_range(addr, 1);
    let _ = m.step(60_000_000);

    println!("{} writes to ${addr:05X} ({} byte-wide):", m.watch_hits.len(), m.watch_hits.iter().filter(|h| h.width == 1).count());
    for h in m.watch_hits.iter().filter(|h| h.width == 1).take(24) {
        println!(
            "  pc=${:05X}  value={:08X} (byte {:02X})  width={}",
            h.pc, h.value, h.value as u8, h.width
        );
    }
}
