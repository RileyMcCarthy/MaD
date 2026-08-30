//! Run N instructions, then dump cog registers and the memory a register points at.
use p2core::{Machine, SmartPins};

fn main() {
    let mut a = std::env::args().skip(1);
    let path = a.next().expect("usage: regs <image> [budget] [reg]");
    let budget: u64 = a.next().and_then(|s| s.parse().ok()).unwrap_or(400_000);
    let reg = usize::from_str_radix(
        a.next().unwrap_or_else(|| "16A".into()).trim_start_matches('$'),
        16,
    )
    .unwrap();
    let image = std::fs::read(&path).expect("read image");
    let mut m = Machine::new(&image, SmartPins::default());
    let _ = m.step(budget);

    println!("pc=${:05X}", m.cogs[0].pc);
    for r in (0x160..0x172).step_by(1) {
        println!("  cog${r:03X} = {:08X}", m.cogs[0].regs[r]);
    }
    let p = m.cogs[0].regs[reg];
    println!("\nreg ${reg:03X} = ${p:08X}; 48 bytes of hub there:");
    let base = (p as usize) & (512 * 1024 - 1);
    let bytes: Vec<u8> = (0..48).map(|i| m.hub[(base + i) & (512 * 1024 - 1)]).collect();
    let txt: String = bytes
        .iter()
        .map(|&b| if (0x20..0x7F).contains(&b) { b as char } else { '.' })
        .collect();
    println!("  {}", bytes.iter().map(|b| format!("{b:02X}")).collect::<Vec<_>>().join(" "));
    println!("  \"{txt}\"");
}
