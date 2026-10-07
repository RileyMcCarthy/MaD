//! Reference side of the QEMU differential harness.
//!
//! Runs a program one instruction at a time and prints the same `P2STATE` line
//! `qemu-system-p2` prints from its `dump_state`. Diffing the two traces
//! localises a semantic divergence to the exact instruction that caused it.
//!
//! Three shapes, because the target has three ways in:
//!
//! | mode | how | QEMU's equivalent |
//! |---|---|---|
//! | default | a generated test program at hub `$1000`, PC set directly | `-device loader` with an entry PC |
//! | `P2STATE_FIRMWARE=1` | a real image at `$0`, first `$1F8` longs seeded into cog 0 | `-kernel` |
//! | `P2STATE_ROM=<rom>` | the boot ROM at the top of hub, all 512 longs seeded, everything else off the flash | `-bios` + `-M p2,flash=` |
//!
//! The ROM mode is the one that needs a diff most. A boot chain produces no
//! output at all until the very end — the payload writes one byte — so
//! "it did not boot" is the only thing a functional test can tell you, and it
//! tells you nothing about where.
use p2core::pins::PinBus;
use p2core::{Board, Machine, SdCard, SmartPins};

/// Print one `P2STATE` line per instruction, for `n` instructions or until the
/// machine stops.
fn trace<P: PinBus>(m: &mut Machine<P>, n: u64) {
    for _ in 0..n {
        let c = &m.cogs[0];
        print!(
            "P2STATE cog=0 pc={:05X} c={} z={} sp={} clk={}",
            c.pc, c.c as u32, c.z as u32, c.sp, c.clocks
        );
        for i in 0..32 {
            print!(" {:08X}", c.regs[i]);
        }
        // PA/PB/PTRA/PTRB and the rest of the special block: CALLPA writes PA
        // and every PTR expression writes PTRA/PTRB, so without these a whole
        // class of divergence is invisible to the diff.
        print!(" |");
        for i in 0x1F0..0x200 {
            print!(" {:08X}", c.regs[i]);
        }
        println!();
        if m.step(1).unwrap_or(0) == 0 {
            break;
        }
    }
}

fn main() {
    let n: u64 = std::env::args()
        .nth(2)
        .and_then(|s| s.parse().ok())
        .unwrap_or(256);

    // ROM boot. Nothing is preloaded into hub but the boot ROM at the top; the
    // chip seeds cog 0 from the ROM's base and everything else arrives over the
    // bit-banged flash bus.
    if let Some(rom_path) = std::env::var_os("P2STATE_ROM") {
        let rom = std::fs::read(&rom_path).expect("read boot ROM");
        let flash = std::env::var_os("P2STATE_FLASH")
            .map(|p| std::fs::read(&p).expect("read flash image"))
            .unwrap_or_default();
        let board = Board::new(SdCard::blank(0)).with_flash(flash);
        let mut m = Machine::with_boot_rom(&rom, board);
        // The flash-boot strap: a pull-up on P61 tells the ROM the flash is the
        // boot source. Without it the ROM falls through to the serial loader,
        // which looks exactly like a flash that failed to answer.
        m.pins.set_input_level(61, true);
        m.strict_hub = false;
        trace(&mut m, n);
        return;
    }

    let path = std::env::args()
        .nth(1)
        .expect("usage: p2state <program.bin> [n]  (or P2STATE_ROM=<rom> p2state - [n])");
    let prog = std::fs::read(&path).expect("read program");

    // A generated test program goes in at $1000 and the PC is set directly,
    // exactly as the QEMU loader does. A real FIRMWARE image goes in at $0 and
    // boots the way silicon does -- the first $1F8 longs become cog 0's RAM and
    // it runs them from cog $000 -- which is what `Machine::new` already
    // implements, and what the QEMU board does at reset.
    let firmware = std::env::var_os("P2STATE_FIRMWARE").is_some();
    let mut hub = vec![0u8; 0x80000];
    let base = if firmware { 0 } else { 0x1000 };
    hub[base..base + prog.len()].copy_from_slice(&prog);

    // `SmartPins`, not `Board`: the QEMU target mirrors this small bring-up bus
    // in C (target/p2/pinbus.c) so the two engines can be diffed through the pin
    // instructions. The ROM boot's flash is the node on the EC32MB nets
    // (`romtest.sh`), not a device of the standalone binary.
    let mut m = Machine::new(&hub, SmartPins::default());
    if !firmware {
        for c in m.cogs.iter_mut() {
            c.running = false;
        }
        m.cogs[0].running = true;
        m.cogs[0].pc = 0x1000;
    }
    m.strict_hub = false;

    trace(&mut m, n);
}
