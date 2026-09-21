//! Reference side of the QEMU differential harness.
//!
//! Loads a generated test program into hub at 0x1000, runs it one instruction
//! at a time, and prints the same `P2STATE` line `qemu-system-p2` prints from
//! its dump_state. Diffing the two traces localises a semantic divergence to
//! the exact instruction that caused it.
use p2core::{Board, Machine, SdCard};

fn main() {
    let path = std::env::args().nth(1).expect("usage: p2state <program.bin> [n]");
    let n: u64 = std::env::args().nth(2).and_then(|s| s.parse().ok()).unwrap_or(256);
    let prog = std::fs::read(&path).expect("read program");

    // Hub image: the program at 0x1000, and a cog-0 trampoline is not needed --
    // we set the PC directly, exactly as the QEMU loader does.
    let mut hub = vec![0u8; 0x80000];
    hub[0x1000..0x1000 + prog.len()].copy_from_slice(&prog);

    let mut m = Machine::new(&hub, Board::new(SdCard::blank(1024)));
    for c in m.cogs.iter_mut() {
        c.running = false;
    }
    m.cogs[0].running = true;
    m.cogs[0].pc = 0x1000;
    m.strict_hub = false;

    for _ in 0..n {
        let c = &m.cogs[0];
        print!("P2STATE pc={:05X} c={} z={} sp={} clk={}",
               c.pc, c.c as u32, c.z as u32, c.sp, c.clocks);
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
