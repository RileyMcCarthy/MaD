//! Find who writes a hub address. `watch <image> <hub_addr> [budget]`
use p2core::{Machine, SmartPins};

fn main() {
    let mut a = std::env::args().skip(1);
    let path = a.next().expect("usage: watch <image> <addr> [budget]");
    let addr = u32::from_str_radix(
        a.next().expect("addr").trim_start_matches('$'),
        16,
    )
    .expect("hex addr");
    let budget: u64 = a.next().and_then(|s| s.parse().ok()).unwrap_or(50_000_000);

    let image = std::fs::read(&path).expect("read image");
    let mut m = Machine::new(&image, SmartPins::default());
    m.watch_range(addr, 4);
    let r = m.step(budget);
    println!("{:?}", r.map(|n| format!("{n} instructions")));
    println!("{} writes hit ${addr:05X}:", m.watch_hits.len());
    let a = addr as usize;
    let now = u32::from_le_bytes([m.hub[a], m.hub[a + 1], m.hub[a + 2], m.hub[a + 3]]);
    let orig = u32::from_le_bytes([image[a], image[a + 1], image[a + 2], image[a + 3]]);
    println!("value now {now:08X}, image had {orig:08X}{}", if now == orig { "" } else { "  <-- CHANGED" });
    for h in m.watch_hits.iter().take(20) {
        println!(
            "   cog{} after pc=${:05X}  addr=${:08X} -> ${:05X} <- {:08X} ({} bytes){}",
            h.cog, h.pc, h.addr, h.effective, h.value, h.width,
            if h.addr != h.effective { "  <-- OUT OF RANGE, wrapped" } else { "" }
        );
    }
}
