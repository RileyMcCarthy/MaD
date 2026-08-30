//! Report the pin the guest is polling and that pin's model state.
use p2core::{Machine, SmartPins};

fn main() {
    let path = std::env::args().nth(1).expect("usage: pinstate <image>");
    let image = std::fs::read(&path).expect("read image");
    let mut m = Machine::new(&image, SmartPins::default());
    let _ = m.step(20_000_000);

    println!("stuck at pc=${:05X}", m.cogs[0].pc);
    for r in [0x155usize, 0x156, 0x157, 0x158, 0x159, 0x15A] {
        println!("  cog${r:03X} = {:08X}", m.cogs[0].regs[r]);
    }
    println!("\nconfigured pins and IN flags:");
    for p in 0..64usize {
        if m.pins.mode[p] != 0 || m.pins.in_flag[p] {
            println!(
                "  pin {p:2}: mode={:08X} x={:08X} in={}",
                m.pins.mode[p], m.pins.x[p], m.pins.in_flag[p]
            );
        }
    }
}
