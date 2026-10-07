//! Probe the ROM boot's cog state at a chosen instruction count.
//!
//! The `P2STATE` trace only carries cog registers 0..31 and the `$1F0` block,
//! which is the right window for diffing arithmetic but blind to the ROM's
//! self-load: it copies its own code into `cog[$100..]` and its LUT, and a
//! divergence there is invisible until the boot walks into it. This prints the
//! registers the trace cannot.
//!
//! usage: P2STATE_ROM=<rom> [P2STATE_FLASH=<img>] romprobe <steps> <from> <to>
use p2core::{Board, Machine, SdCard};

fn main() {
    let steps: u64 = std::env::args().nth(1).and_then(|s| s.parse().ok()).unwrap_or(3316);
    let from = usize::from_str_radix(&std::env::args().nth(2).unwrap_or("40".into()), 16).unwrap();
    let to = usize::from_str_radix(&std::env::args().nth(3).unwrap_or("50".into()), 16).unwrap();

    let rom = std::fs::read(std::env::var_os("P2STATE_ROM").expect("P2STATE_ROM")).expect("rom");
    let flash = std::env::var_os("P2STATE_FLASH")
        .map(|p| std::fs::read(p).expect("flash"))
        .unwrap_or_default();

    let mut m = Machine::with_boot_rom(&rom, Board::new(SdCard::blank(0)).with_flash(flash));
    m.pins.set_input_level(61, true);
    m.strict_hub = false;
    for _ in 0..steps {
        if m.step(1).unwrap_or(0) == 0 {
            break;
        }
    }
    println!("after {steps} steps: pc={:05X} c={} z={}", m.cogs[0].pc, m.cogs[0].c as u32, m.cogs[0].z as u32);
    for i in from..=to {
        println!("  cog[${i:03X}] = {:08X}", m.cogs[0].regs[i]);
    }
}
