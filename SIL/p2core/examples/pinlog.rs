//! Log smart-pin traffic in order, to discover which pin plays which role.
use p2core::{Machine, PinBus};

#[derive(Default)]
struct Log {
    ops: Vec<String>,
    mode: std::collections::BTreeMap<u8, u32>,
}
impl PinBus for Log {
    fn wrpin(&mut self, pin: u8, cfg: u32) {
        self.mode.insert(pin, cfg);
        self.ops.push(format!("wrpin  p{pin:2} cfg={cfg:08X}"));
    }
    fn wxpin(&mut self, pin: u8, x: u32) {
        self.ops.push(format!("wxpin  p{pin:2} x={x:08X}"));
    }
    fn wypin(&mut self, pin: u8, y: u32) {
        self.ops.push(format!("wypin  p{pin:2} y={y:08X}"));
    }
    fn rdpin(&mut self, pin: u8) -> (u32, bool) {
        self.ops.push(format!("rdpin  p{pin:2} -> FF"));
        (0xFF, false)
    }
    fn testp(&self, _pin: u8) -> bool {
        true
    }
    fn dir_out_changed(&mut self, reg: u16, v: u32) {
        if reg == 0x1FB || reg == 0x1FD {
            // DIRB/OUTB cover pins 32..63, where the SD and serial pins live.
            self.ops.push(format!("{}B    = {v:08X}", if reg == 0x1FB { "dir" } else { "out" }));
        }
    }
}

fn main() {
    let path = std::env::args().nth(1).expect("usage: pinlog <image> [skip] [count]");
    let skip: usize = std::env::args().nth(2).and_then(|s| s.parse().ok()).unwrap_or(0);
    let count: usize = std::env::args().nth(3).and_then(|s| s.parse().ok()).unwrap_or(40);
    let image = std::fs::read(&path).expect("read image");
    let mut m = Machine::new(&image, Log::default());
    m.strict_hub = false;
    let _ = m.step(30_000_000);
    println!("{} pin ops; showing {}..{}", m.pins.ops.len(), skip, skip + count);
    for op in m.pins.ops.iter().skip(skip).take(count) {
        println!("  {op}");
    }
    println!("configured: {:?}", m.pins.mode.keys().collect::<Vec<_>>());
}
