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
//! `CALLD INB, IRET1 WCZ`; `EEEE 0001000 CZI ...` ADD, `EEEE 1010001 SZI ...`
//! SCA/SCAS, `EEEE 1101011 00L DDDDDDDDD 00010100x` SETQ/SETQ2,
//! `EEEE 1100110 1LI ...` REP, `EEEE 1011001 CZI ...` CALLD and
//! `EEEE 1101100 RAA ...` JMP.
//!
//! The hold-off list is the P2 silicon document's (Interrupts): the branch
//! waits while ALTxx, SCA/SCAS or SETQ/SETQ2 is executing, while AUGS/AUGD wait
//! for their instruction, and while REP is executing or active.

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
const REG_IRET1: usize = 0x1F5;
/// Where an ISR's ordinary subroutine lives.
const SUB: u32 = 0x600;
/// Hub longs a block read takes, and what they hold.
const DATA: u32 = 0x80;
const BLOCK: [u32; 4] = [0x1111_1111, 0x2222_2222, 0x3333_3333, 0x4444_4444];

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

/// `mov d, s` (register S).
fn mov_reg(d: u32, s: u32) -> u32 {
    0xF600_0000 | ((d & 0x1FF) << 9) | (s & 0x1FF)
}
/// `add d, #s`.
fn add_imm(d: u32, s: u32) -> u32 {
    0xF100_0000 | (1 << 18) | ((d & 0x1FF) << 9) | (s & 0x1FF)
}
/// `sca d, #s` (or `scas` when `signed`): the product becomes the next S.
fn sca_imm(d: u32, s: u32, signed: bool) -> u32 {
    0xFA20_0000 | (u32::from(signed) << 20) | (1 << 18) | ((d & 0x1FF) << 9) | (s & 0x1FF)
}
/// `setq #d`.
fn setq_imm(d: u32) -> u32 {
    0xFD60_0028 | (1 << 18) | ((d & 0x1FF) << 9)
}
/// `setq2 #d`.
fn setq2_imm(d: u32) -> u32 {
    0xFD60_0029 | (1 << 18) | ((d & 0x1FF) << 9)
}
/// `rdlong d, #s` with a hub address below $100.
fn rdlong_imm(d: u32, s: u32) -> u32 {
    0xFB00_0000 | (1 << 18) | ((d & 0x1FF) << 9) | (s & 0xFF)
}
/// `rep #len, #count`: repeat the next `len` instructions `count` times.
fn rep_imm(len: u32, count: u32) -> u32 {
    0xFCD0_0000 | (0b11 << 18) | ((len & 0x1FF) << 9) | (count & 0x1FF)
}
/// `calld d, s` (register S), no flag writes.
fn calld_reg(d: u32, s: u32) -> u32 {
    0xFB20_0000 | ((d & 0x1FF) << 9) | (s & 0x1FF)
}
/// `jmp #\rel`: hub-relative jump by `bytes` from the next instruction.
fn jmp_rel(bytes: i32) -> u32 {
    0xFD90_0000 | (bytes as u32 & 0xF_FFFF)
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
    let m = decode(mov_reg(10, 21)).expect("mov decodes");
    assert_eq!((m.op, m.d, m.s, m.i), (Op::Mov, 10, 21, false));
    let a = decode(add_imm(20, 1)).expect("add decodes");
    assert_eq!(
        (a.op, a.d, a.s, a.i, a.c, a.z),
        (Op::Add, 20, 1, true, false, false)
    );
    let s = decode(sca_imm(20, 3, false)).expect("sca decodes");
    assert_eq!((s.op, s.d, s.s, s.i, s.z), (Op::Sca, 20, 3, true, false));
    assert_eq!(
        decode(sca_imm(20, 3, true)).expect("scas decodes").op,
        Op::Scas
    );
    let q = decode(setq_imm(3)).expect("setq decodes");
    assert_eq!((q.op, q.d, q.i), (Op::Setq, 3, true));
    let q2 = decode(setq2_imm(3)).expect("setq2 decodes");
    assert_eq!((q2.op, q2.d, q2.i), (Op::Setq2, 3, true));
    let r = decode(rdlong_imm(20, DATA)).expect("rdlong decodes");
    assert_eq!((r.op, r.d, r.s, r.i), (Op::Rdlong, 20, DATA as u16, true));
    let r = decode(rep_imm(2, 5)).expect("rep decodes");
    assert_eq!((r.op, r.d, r.s, r.i), (Op::Rep, 2, 5, true));
    let c = decode(calld_reg(30, 31)).expect("calld decodes");
    assert_eq!(
        (c.op, c.d, c.s, c.i, c.c, c.z),
        (Op::Calld, 30, 31, false, false, false)
    );
    assert_eq!(decode(jmp_rel(-16)).expect("jmp decodes").op, Op::Jmp);
    assert_eq!(jmp_rel(-4), JMP_SELF, "jmp #$ is a relative jump by -4");
}

/// Load the block a SETQ/SETQ2 read takes.
fn load_block(m: &mut Machine<OneRxPin>) {
    for (k, w) in BLOCK.iter().enumerate() {
        let a = DATA as usize + 4 * k;
        m.hub[a..a + 4].copy_from_slice(&w.to_le_bytes());
    }
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

#[test]
fn an_interrupt_waits_for_the_instruction_a_scaled_product_belongs_to() {
    behaviour!(Test {
        id: "p2.int1-after-sca",
        covers: Some("SIL/p2core/src/lib.rs#step_one"),
        given: "a serial byte arriving right after a scaled multiply, whose product the next instruction takes as its source, with an interrupt routine that loads a small constant",
    });
    expect!(
        "product-reaches-next",
        "the instruction after the multiply receives the product, for both the unsigned and the signed multiply",
        "the hardware takes an interrupt only after the instruction that uses the product has run"
    );
    expect!(
        "isr-value-own",
        "the interrupt routine's own constant keeps its value"
    );
    expect!(
        "serviced-after",
        "the byte is still serviced once that instruction has run"
    );
    check_encodings();

    for signed in [false, true] {
        // 0x33 * 3 = 0x99 either way; S of the MOV would otherwise be r21 = 0.
        let mut m = machine(
            &[sca_imm(20, 3, signed), mov_reg(10, 21), JMP_SELF],
            &[mov_imm(11, 5), rdpin(12, 13), RETI1],
        );
        m.cogs[0].regs[20] = 0x33;
        m.step(1).expect("the multiply runs"); // the product is pending now
        m.pins.waiting = true; // the byte lands before the MOV that takes it
        m.step(12).expect("runs");

        assert_eq!(
            m.cogs[0].regs[10], 0x99,
            "the MOV after sca (signed: {signed})"
        );
        assert_eq!(m.cogs[0].regs[11], 5, "the ISR's MOV (signed: {signed})");
        assert_eq!(
            m.int1_entries, 1,
            "the byte was still serviced (signed: {signed})"
        );
    }
}

#[test]
fn an_interrupt_waits_for_the_block_read_a_setq_sizes() {
    behaviour!(Test {
        id: "p2.int1-after-setq",
        covers: Some("SIL/p2core/src/lib.rs#step_one"),
        given: "a serial byte arriving between a block-length prefix and the hub read it sizes, with an interrupt routine that loads a small constant",
    });
    expect!(
        "block-whole",
        "the hub read fills every register of the block the prefix asked for",
        "the hardware takes an interrupt only after the instruction the prefix belongs to has run"
    );
    expect!(
        "serviced-after",
        "the byte is still serviced once the read has run"
    );
    check_encodings();

    let mut m = machine(
        &[setq_imm(3), rdlong_imm(20, DATA), JMP_SELF],
        &[mov_imm(11, 5), rdpin(12, 13), RETI1],
    );
    load_block(&mut m);
    m.step(1).expect("the prefix runs");
    m.pins.waiting = true;
    m.step(12).expect("runs");

    assert_eq!(
        m.cogs[0].regs[20..24],
        BLOCK,
        "the block read into registers"
    );
    assert_eq!(m.int1_entries, 1, "the byte was still serviced");
}

#[test]
fn an_interrupt_waits_for_the_lookup_table_read_a_setq2_sizes() {
    behaviour!(Test {
        id: "p2.int1-after-setq2",
        covers: Some("SIL/p2core/src/lib.rs#step_one"),
        given: "a serial byte arriving between a lookup-table block prefix and the hub read it redirects, with an interrupt routine that loads a small constant",
    });
    expect!(
        "table-filled",
        "the hub read fills every lookup-table entry of the block the prefix asked for",
        "the hardware takes an interrupt only after the instruction the prefix belongs to has run"
    );
    expect!(
        "serviced-after",
        "the byte is still serviced once the read has run"
    );
    check_encodings();

    let mut m = machine(
        &[setq2_imm(3), rdlong_imm(0, DATA), JMP_SELF],
        &[mov_imm(11, 5), rdpin(12, 13), RETI1],
    );
    load_block(&mut m);
    m.step(1).expect("the prefix runs");
    m.pins.waiting = true;
    m.step(12).expect("runs");

    assert_eq!(
        m.cogs[0].lut[0..4],
        BLOCK,
        "the block read into the lookup table"
    );
    assert_eq!(m.int1_entries, 1, "the byte was still serviced");
}

#[test]
fn an_interrupt_waits_for_a_repeated_block_to_finish() {
    behaviour!(Test {
        id: "p2.int1-held-in-rep",
        covers: Some("SIL/p2core/src/lib.rs#step_one"),
        given: "a serial byte arriving as a hardware-repeated block of two instructions starts its five passes",
    });
    expect!(
        "held-for-every-pass",
        "the interrupt waits until the last pass of the block has run",
        "the hardware shields a repeated block from interrupts for as long as it repeats"
    );
    expect!(
        "every-pass-runs",
        "each instruction of the block runs once per pass"
    );
    expect!(
        "serviced-after",
        "the byte is serviced by the first instruction after the block"
    );
    check_encodings();

    let mut m = machine(
        &[rep_imm(2, 5), add_imm(20, 1), add_imm(21, 1), JMP_SELF],
        &[rdpin(12, 13), RETI1],
    );
    m.step(1).expect("the repeat starts");
    m.pins.waiting = true;
    m.step(10).expect("five passes of two instructions");

    assert_eq!(m.int1_entries, 0, "interrupts taken inside the block");
    assert_eq!(
        (m.cogs[0].regs[20], m.cogs[0].regs[21]),
        (5, 5),
        "passes run"
    );
    assert_eq!(
        m.cogs[0].pc,
        MAIN + 12,
        "at the instruction after the block"
    );
    m.step(1).expect("the interrupt branch");
    assert_eq!(m.int1_entries, 1, "the byte is serviced after the block");
    assert_eq!(
        m.cogs[0].regs[REG_IRET1] & 0xF_FFFF,
        MAIN + 12,
        "the ISR returns to the instruction after the block"
    );
}

#[test]
fn an_interrupt_is_taken_once_a_branch_leaves_a_repeated_block() {
    behaviour!(Test {
        id: "p2.int1-after-rep-exit",
        covers: Some("SIL/p2core/src/lib.rs#step_one"),
        given: "a serial byte arriving inside a hardware-repeated block that branches out of itself with passes still to go",
    });
    expect!(
        "held-inside",
        "the interrupt waits while the block's own instructions run"
    );
    expect!(
        "taken-outside",
        "the interrupt is taken at the branch target, the first instruction outside the block",
        "a branch out of a repeated block ends the repeat, and the shield with it"
    );
    check_encodings();

    // MAIN: spin (the branch target) / rep / add / jmp back to the spin.
    let mut m = machine(
        &[JMP_SELF, rep_imm(2, 100), add_imm(20, 1), jmp_rel(-16)],
        &[rdpin(12, 13), RETI1],
    );
    m.cogs[0].pc = MAIN + 4;
    m.step(1).expect("the repeat starts");
    m.pins.waiting = true;
    m.step(2).expect("the add, then the branch out");

    assert_eq!(m.int1_entries, 0, "interrupts taken inside the block");
    assert_eq!(m.cogs[0].pc, MAIN, "at the branch target");
    m.step(1).expect("the interrupt branch");
    assert_eq!(m.int1_entries, 1, "the byte is serviced outside the block");
    assert_eq!(
        m.cogs[0].regs[REG_IRET1] & 0xF_FFFF,
        MAIN,
        "the ISR returns to the branch target"
    );
}

#[test]
fn an_ordinary_call_inside_the_isr_leaves_it_running() {
    behaviour!(Test {
        id: "p2.int1-ordinary-calld",
        covers: Some("SIL/p2core/src/lib.rs#step_one"),
        given: "an interrupt routine that calls and returns from a subroutine with the same register-saving call its return uses, while a second serial byte arrives",
    });
    expect!(
        "second-byte-waits",
        "the second byte waits until the routine has run its return",
        "only a call through the interrupt's own return register ends the interrupt routine"
    );
    expect!(
        "routine-completes",
        "the routine carries on after the subroutine and reaches its return"
    );
    expect!(
        "second-byte-serviced",
        "the second byte is serviced once the routine has returned"
    );
    check_encodings();

    // ISR: take the byte / call SUB / count / reti1. SUB: mark / return via r30.
    let mut m = machine(
        &[JMP_SELF],
        &[rdpin(12, 13), calld_reg(30, 31), add_imm(17, 1), RETI1],
    );
    for (k, w) in [mov_imm(16, 1), calld_reg(29, 30)].iter().enumerate() {
        let a = SUB as usize + 4 * k;
        m.hub[a..a + 4].copy_from_slice(&w.to_le_bytes());
    }
    m.cogs[0].regs[31] = SUB;
    m.pins.waiting = true;
    m.step(3)
        .expect("enter, take the byte, call the subroutine");
    assert_eq!(m.cogs[0].pc, SUB, "in the subroutine");
    m.pins.waiting = true; // the second byte
    m.step(3)
        .expect("the subroutine and its return, then the count");

    assert_eq!(m.int1_entries, 1, "interrupts taken before reti1");
    assert_eq!(m.cogs[0].regs[16], 1, "the subroutine ran");
    assert_eq!(m.cogs[0].regs[17], 1, "the ISR ran on after the subroutine");
    assert_eq!(m.cogs[0].pc, ISR + 12, "at the ISR's reti1");
    m.step(2).expect("reti1, then the second interrupt branch");
    assert_eq!(m.int1_entries, 2, "the second byte is serviced after reti1");
}
