//! Reference side of the QEMU differential harness.
//!
//! Loads a generated test program into hub at 0x1000, runs it one instruction
//! at a time, and prints the same `P2STATE` line `qemu-system-p2` prints from
//! its dump_state. Diffing the two traces localises a semantic divergence to
//! the exact instruction that caused it.
use p2core::{Machine, SmartPins};

fn main() {
    let path = std::env::args().nth(1).expect("usage: p2state <program.bin> [n]");
    let n: u64 = std::env::args().nth(2).and_then(|s| s.parse().ok()).unwrap_or(256);
    let prog = std::fs::read(&path).expect("read program");

    // Two shapes. A generated test program goes in at $1000 and the PC is set
    // directly, exactly as the QEMU loader does. A real FIRMWARE image goes in
    // at $0 and boots the way silicon does -- the first $1F8 longs become cog
    // 0's RAM and it runs them from cog $000 -- which is what Machine::new
    // already implements, and what the QEMU board does at reset.
    let firmware = std::env::var_os("P2STATE_FIRMWARE").is_some();
    let mut hub = vec![0u8; 0x80000];
    let base = if firmware { 0 } else { 0x1000 };
    hub[base..base + prog.len()].copy_from_slice(&prog);

    // `SmartPins`, not `Board`: the QEMU target mirrors this small bring-up
    // bus in C (target/p2/pinbus.c) so the two engines can be diffed through
    // the pin instructions. The real peripherals live on embsim's side of the
    // PinBus seam and are deliberately not duplicated in the target.
    let mut m = Machine::new(&hub, SmartPins::default());
    if !firmware {
        for c in m.cogs.iter_mut() {
            c.running = false;
        }
        m.cogs[0].running = true;
        m.cogs[0].pc = 0x1000;
    }
    m.strict_hub = false;

    for _ in 0..n {
        let c = &m.cogs[0];
        print!("P2STATE cog=0 pc={:05X} c={} z={} sp={} clk={}",
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
