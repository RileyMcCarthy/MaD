//! Slice B probe: capture what the firmware transmits.
//!
//! An async-TX smart pin receives its byte through `WYPIN` — that is the real
//! hardware interface, not a shim — so capturing there proves the whole path
//! from `printf` down to the pin. Shifting the byte out bit-by-bit at the
//! configured baud onto a net is the *next* step, and is what will make a
//! wrong `clkfreq` or bit period visible; this only proves the path exists.

use p2core::{Machine, PinBus};

struct SerialCapture {
    /// Mode word last written to each pin by `WRPIN`.
    mode: [u32; 64],
    /// Bytes handed to each pin via `WYPIN`.
    out: Vec<(u8, u8)>,
}

impl Default for SerialCapture {
    fn default() -> Self {
        Self { mode: [0; 64], out: Vec::new() }
    }
}

impl PinBus for SerialCapture {
    fn wrpin(&mut self, pin: u8, cfg: u32) {
        self.mode[pin as usize & 63] = cfg;
    }
    fn wypin(&mut self, pin: u8, y: u32) {
        // WYPIN is how a byte actually reaches an async-TX smart pin, so this
        // is the hardware interface, not a shim. `_txraw` drives pin 62.
        self.out.push((pin, y as u8));
    }
    /// C reports the pin BUSY, not ready: `_txraw` spins on
    /// `rdpin #62 wc` / `if_b jmp`, so returning true here means "still
    /// transmitting" and hangs the guest forever. This model completes each
    /// byte instantly, so it is never busy.
    fn rdpin(&mut self, _pin: u8) -> (u32, bool) {
        (0, false)
    }
    fn testp(&self, _pin: u8) -> bool {
        false
    }
}

fn main() {
    let path = std::env::args().nth(1).expect("usage: serial <image>");
    let budget: u64 = std::env::args()
        .nth(2)
        .and_then(|s| s.parse().ok())
        .unwrap_or(50_000_000);
    let image = std::fs::read(&path).expect("read image");
    let mut m = Machine::new(&image, SerialCapture::default());

    match m.step(budget) {
        Ok(n) => println!("ran {n} instructions"),
        Err(t) => println!("TRAP: {t}"),
    }

    let configured: Vec<usize> = (0..64).filter(|&p| m.pins.mode[p] != 0).collect();
    println!("configured pins: {configured:?}");
    println!("captured {} bytes", m.pins.out.len());

    let mut by_pin: std::collections::BTreeMap<u8, Vec<u8>> = Default::default();
    for (pin, byte) in &m.pins.out {
        by_pin.entry(*pin).or_default().push(*byte);
    }
    for (pin, bytes) in by_pin {
        let text: String = bytes
            .iter()
            .map(|&b| if (0x20..0x7F).contains(&b) || b == b'\n' { b as char } else { '.' })
            .collect();
        println!("--- pin {pin} ({} bytes):\n{text}", bytes.len());
        println!("    hex: {}", bytes.iter().map(|b| format!("{b:02X}")).collect::<Vec<_>>().join(" "));
    }
}
