//! Which instruction wrote a given hub byte, and with what value.
use p2core::{Board, Machine, SdCard};

fn main() {
    let mut a = std::env::args().skip(1);
    let path = a.next().expect("usage: watchbuf <image> <addr> [len]");
    let addr = u32::from_str_radix(a.next().expect("addr").trim_start_matches('$'), 16).unwrap();
    let len: u32 = a.next().and_then(|s| s.parse().ok()).unwrap_or(1);

    let image = std::fs::read(&path).expect("read image");
    let mut m = Machine::new(&image, Board::new(SdCard::blank(32 * 1024 * 1024)));
    m.strict_hub = false;
    m.watch_range(addr, len);
    let _ = m.step(60_000_000);

    println!("{} writes to ${addr:05X}..+{len}:", m.watch_hits.len());
    for h in m.watch_hits.iter().take(24) {
        println!(
            "  pc=${:05X} (after) wrote {:0width$X} to ${:05X}  [w{}]",
            h.pc, h.value, h.effective, h.width,
            width = (h.width * 2) as usize
        );
    }
}
