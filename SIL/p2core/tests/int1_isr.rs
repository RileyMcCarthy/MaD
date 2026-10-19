//! INT1 beside running code: what an interrupt must leave untouched.
//!
//! The firmware's protocol receiver (HAL/P2/HAL_serial.c) takes each byte by
//! INT1 on the SERIAL cog, in the middle of compiled FlexC code. On silicon the
//! interrupt branch is `CALLD IRET1, IJMP1 WCZ`, so the interrupted code's C and
//! Z come back with `RETI1`, and an interrupt never lands between a prefix
//! (`AUGS`, `SETQ`, `ALTx`) and the instruction it modifies. The ISS must do
//! the same, or the SIL runs firmware whose flags and wide immediates change
//! under it whenever a byte arrives.
//!
//! Encodings follow the P2 word layout (PNut-TS table, vendor/parseUtils.ts)
//! and are checked with `decode()` before they are trusted:
//! `EEEE 0110000 CZI DDDDDDDDD SSSSSSSSS` MOV, `EEEE 0010000 CZI ...` CMP,
//! `EEEE 1010100 C1I ...` RDPIN, `EEEE 11110NN NNNN...` AUGS, and `reti1` is
//! `CALLD INB, IRET1 WCZ`.

use p2core::{decode, Machine, Op, PinBus};
use vibes_behaviour::{behaviour, expect, Test};

/// The pin the interrupt watches.
const RX_PIN: u32 = 53;
/// Where the ISR lives in hub, and where the interrupted code runs.
const MAIN: u32 = 0x400;
const ISR: u32 = 0x500;
/// `jmp #$`: the interrupted code spins here.
const JMP_SELF: u32 = 0xFD9F_FFFC;
/// `reti1`.
const RETI1: u32 = 0xFB3B_FFF5;
const REG_IJMP1: usize = 0x1F4;

/// `mov d, #s`.
fn mov_imm(d: u32, s: u32) -> u32 {
    0xF600_0000 | (1 << 18) | ((d & 0x1FF) << 9) | (s & 0x1FF)
}
/// `cmp d, s wcz`.
fn cmp_wcz(d: u32, s: u32) -> u32 {
    0xF200_0000 | (0b11 << 19) | ((d & 0x1FF) << 9) | (s & 0x1FF)
}
/// `rdpin d, s` with the pin number in register `s`.
fn rdpin(d: u32, s: u32) -> u32 {
    0xFA88_0000 | ((d & 0x1FF) << 9) | (s & 0x1FF)
}
/// `augs #n`: the upper 23 bits of the next instruction's S immediate.
fn augs(n: u32) -> u32 {
    0xFF00_0000 | (n & 0x7F_FFFF)
}

fn check_encodings() {
    let m = decode(mov_imm(10, 7)).expect("mov decodes");
    assert_eq!((m.op, m.d, m.s, m.i), (Op::Mov, 10, 7, true));
    let c = decode(cmp_wcz(12, 12)).expect("cmp decodes");
    assert_eq!((c.op, c.c, c.z), (Op::Cmp, true, true));
    assert_eq!(decode(rdpin(12, 13)).expect("rdpin decodes").op, Op::Rdpin);
    assert_eq!(decode(augs(1)).expect("augs decodes").op, Op::Augs);
    let r = decode(RETI1).expect("reti1 decodes");
    assert_eq!(
        (r.op, r.d, r.s, r.c, r.z),
        (Op::Calld, 0x1FF, 0x1F5, true, true)
    );
}

/// One receive pin whose IN flag the test raises; `RDPIN` takes the byte and
/// lowers it, as an async-RX smart pin does.
#[derive(Default)]
struct OneRxPin {
    waiting: bool,
}

impl PinBus for OneRxPin {
    fn testp(&self, pin: u8) -> bool {
        u32::from(pin) == RX_PIN && self.waiting
    }
    fn rdpin(&mut self, pin: u8) -> (u32, bool) {
        if u32::from(pin) == RX_PIN {
            self.waiting = false;
            (0x41 << 24, false)
        } else {
            (0, false)
        }
    }
}

/// A cog running `main` from hub with INT1 armed on "RX pin has a byte",
/// vectored to `isr`.
fn machine(main: &[u32], isr: &[u32]) -> Machine<OneRxPin> {
    let mut m = Machine::new(&[0u8; 4096], OneRxPin::default());
    for (base, words) in [(MAIN, main), (ISR, isr)] {
        for (k, w) in words.iter().enumerate() {
            let a = base as usize + 4 * k;
            m.hub[a..a + 4].copy_from_slice(&w.to_le_bytes());
        }
    }
    let cog = &mut m.cogs[0];
    cog.running = true;
    cog.pc = MAIN;
    cog.regs[13] = RX_PIN;
    cog.regs[REG_IJMP1] = ISR;
    cog.se1_cfg = (0b110 << 6) | RX_PIN;
    cog.int1_src = 4;
    m
}

#[test]
fn an_interrupt_hands_back_the_flags_it_found() {
    behaviour!(Test {
        id: "p2.int1-keeps-flags",
        covers: Some("SIL/p2core/src/lib.rs#step_one"),
        given: "a cog spinning with carry set and zero clear when a serial byte arrives and its interrupt routine changes both flags",
    });
    expect!(
        "flags-restored",
        "once the routine returns, the interrupted code has carry set and zero clear again",
        "the hardware saves both flags beside the return address on entry and the return puts them back"
    );
    expect!(
        "resumes-where-interrupted",
        "the interrupted code carries on at the instruction it was about to run"
    );
    expect!("taken-once", "one byte is serviced by one interrupt");
    check_encodings();

    // ISR: take the byte, then clobber C and Z (`cmp x, x` sets Z, clears C).
    let mut m = machine(&[JMP_SELF], &[rdpin(12, 13), cmp_wcz(12, 12), RETI1]);
    m.cogs[0].c = true;
    m.cogs[0].z = false;
    m.pins.waiting = true;
    m.step(12).expect("runs");

    assert_eq!(
        (m.cogs[0].c, m.cogs[0].z),
        (true, false),
        "flags after the ISR returned"
    );
    assert_eq!(m.cogs[0].pc, MAIN, "back in the interrupted loop");
    assert!(!m.cogs[0].in_int1, "the ISR has ended");
    assert_eq!(m.int1_entries, 1, "interrupts taken for one byte");
}

#[test]
fn an_interrupt_waits_for_the_instruction_a_prefix_belongs_to() {
    behaviour!(Test {
        id: "p2.int1-after-prefix",
        covers: Some("SIL/p2core/src/lib.rs#step_one"),
        given: "a serial byte arriving between a wide-immediate prefix and the instruction it widens, with an interrupt routine that loads a small constant",
    });
    expect!(
        "prefixed-value-whole",
        "the widened instruction receives the full 32-bit constant its prefix built"
    );
    expect!(
        "isr-value-unwidened",
        "the interrupt routine's own constant keeps its 9-bit value",
        "the hardware takes an interrupt only after the prefixed instruction has run"
    );
    check_encodings();

    let mut m = machine(
        &[augs(0x12345), mov_imm(10, 0x67), JMP_SELF],
        &[mov_imm(11, 5), rdpin(12, 13), RETI1],
    );
    m.step(1).expect("the prefix runs"); // AUGS is pending now
    m.pins.waiting = true; // the byte lands before the MOV it modifies
    m.step(12).expect("runs");

    assert_eq!(
        m.cogs[0].regs[10],
        (0x12345 << 9) | 0x67,
        "the augmented MOV"
    );
    assert_eq!(m.cogs[0].regs[11], 5, "the ISR's MOV");
    assert_eq!(m.int1_entries, 1, "the byte was still serviced");
}
