//! The clock word and the timed pass: how a host learns the guest set its clock.
//!
//! `P2IssCore` keeps its own map from clocks to time, so it runs the guest with
//! [`Machine::step_until_clocks`] and retimes it whenever a `HUBSET` sets the
//! clock. That needs three things from p2core, tested here on a hand-built
//! program so no firmware image is required:
//!
//! - only a clock word is recorded ([`Machine::take_clock_word`]). The P2
//!   silicon document's "HUB Configuration" table selects the circuit with the
//!   top bits of D: `%0000` sets the clock generator, `%0001` resets the chip,
//!   `%0010` sets write protection and debug enables, `%0100` configures a
//!   filter and `%1xxx` seeds the PRNG;
//! - with [`Machine::yield_on_clock_word`] set, the pass ends right after the
//!   clock `HUBSET` and [`Machine::take_yield_clocks`] gives that cog's clock;
//! - with it clear, the pass runs on to its deadline.
//!
//! Encodings follow the P2 word layout (PNut-TS table, vendor/parseUtils.ts)
//! and are checked with `decode()` before they are trusted:
//! `EEEE 1101011 00L DDDDDDDDD 000000000` HUBSET, `EEEE 1101011 00L DDDDDDDDD
//! 000011111` WAITX, `EEEE 0110000 CZI ...` MOV and `EEEE 1101100 RAA ...` JMP.

use p2core::pins::NullPins;
use p2core::{decode, Machine, Op};
use vibes_behaviour::{behaviour, expect, Test};

/// Where the program runs in hub.
const MAIN: u32 = 0x400;
/// `jmp #$`: the program ends spinning here.
const JMP_SELF: u32 = 0xFD9F_FFFC;
/// The silicon document's PLL example: crystal + PLL at 148.5 MHz.
const CLOCK_WORD: u32 = 0x019D_28FB;
/// Filter 1, five flip-flops, every 32nd clock.
const FILTER_WORD: u32 = 0x4000_0080 + (2 << 5) + 5;
/// A PRNG seed (MSB set).
const SEED_WORD: u32 = 0x8000_1234;
/// Write protection and debug enables, all off.
const PROTECT_WORD: u32 = 0x2000_0000;
/// Registers holding the words, so `hubset` takes a full 32-bit D.
const R_CLOCK: u32 = 20;
const R_FILTER: u32 = 21;
const R_SEED: u32 = 22;
const R_PROTECT: u32 = 23;
/// Clocks the program burns before its first HUBSET, so a clock count of
/// zero cannot pass for the count the word was set at.
const LEAD_IN: u32 = 100;
/// Far beyond the few hundred clocks the program needs.
const DEADLINE: u64 = 10_000;

/// `hubset d` (register D).
fn hubset(d: u32) -> u32 {
    0xFD60_0000 | ((d & 0x1FF) << 9)
}
/// `waitx #n`.
fn waitx_imm(n: u32) -> u32 {
    0xFD60_001F | (1 << 18) | ((n & 0x1FF) << 9)
}
/// `mov d, #s`.
fn mov_imm(d: u32, s: u32) -> u32 {
    0xF600_0000 | (1 << 18) | ((d & 0x1FF) << 9) | (s & 0x1FF)
}

fn check_encodings() {
    let h = decode(hubset(R_CLOCK)).expect("hubset decodes");
    assert_eq!((h.op, h.d, h.i), (Op::Hubset, R_CLOCK as u16, false));
    let w = decode(waitx_imm(LEAD_IN)).expect("waitx decodes");
    assert_eq!((w.op, w.d), (Op::Waitx, LEAD_IN as u16));
    let m = decode(mov_imm(10, 1)).expect("mov decodes");
    assert_eq!((m.op, m.d, m.s, m.i), (Op::Mov, 10, 1, true));
    assert_eq!(decode(JMP_SELF).expect("jmp decodes").op, Op::Jmp);
}

/// Cog 0 running `program` from hub, with the HUBSET words in registers.
fn machine(program: &[u32]) -> Machine<NullPins> {
    let mut m = Machine::new(&[0u8; 4096], NullPins);
    for (k, w) in program.iter().enumerate() {
        let a = MAIN as usize + 4 * k;
        m.hub[a..a + 4].copy_from_slice(&w.to_le_bytes());
    }
    let cog = &mut m.cogs[0];
    cog.running = true;
    cog.pc = MAIN;
    cog.regs[R_CLOCK as usize] = CLOCK_WORD;
    cog.regs[R_FILTER as usize] = FILTER_WORD;
    cog.regs[R_SEED as usize] = SEED_WORD;
    cog.regs[R_PROTECT as usize] = PROTECT_WORD;
    m
}

/// Lead-in / clock HUBSET / marker / the three other forms / spin.
fn clock_then_others() -> Vec<u32> {
    vec![
        waitx_imm(LEAD_IN),
        hubset(R_CLOCK),
        mov_imm(10, 1),
        hubset(R_FILTER),
        hubset(R_SEED),
        hubset(R_PROTECT),
        JMP_SELF,
    ]
}
/// Where `clock_then_others` puts the instruction after the clock HUBSET.
const AFTER_CLOCK: u32 = MAIN + 8;
/// Where it spins.
const SPIN: u32 = MAIN + 24;

#[test]
fn a_clock_hubset_is_recorded_once_with_its_clock_count() {
    behaviour!(Test {
        id: "p2.hubset-clock-word-recorded",
        covers: Some("SIL/p2core/src/lib.rs#take_clock_word"),
        given: "a program that sets the system clock with a hub-configuration instruction and then configures a filter, seeds the random generator and sets write protection",
    });
    expect!(
        "clock-word-kept",
        "the host can read back the clock word the program set",
        "only a word whose top four bits are zero sets the clock generator; the filter, seed and write-protection forms configure other hub circuits"
    );
    expect!(
        "set-at-its-clock",
        "the clock count read with it is the one the setting cog had reached when it ran that instruction"
    );
    expect!(
        "read-once",
        "a second read finds nothing until the program sets the clock again"
    );
    check_encodings();

    let mut m = machine(&clock_then_others());
    m.step(1).expect("the lead-in runs");
    let before = m.cogs[0].clocks;
    m.step(1).expect("the clock HUBSET runs");
    let after = m.cogs[0].clocks;
    m.step_until_clocks(DEADLINE).expect("runs to the deadline");
    assert_eq!(m.cogs[0].pc, SPIN, "every HUBSET has run");

    let (word, at) = m.take_clock_word().expect("a clock word was recorded");
    assert_eq!(word, CLOCK_WORD, "the recorded word");
    assert!(
        before >= u64::from(LEAD_IN) && (before..=after).contains(&at),
        "set at clock {at}, while the HUBSET ran from {before} to {after}"
    );
    assert_eq!(m.take_clock_word(), None, "the word is taken once");
}

#[test]
fn hubset_forms_that_do_not_set_the_clock_are_not_recorded() {
    behaviour!(Test {
        id: "p2.hubset-other-forms-ignored",
        covers: Some("SIL/p2core/src/lib.rs#take_clock_word"),
        given: "a program that configures a filter, seeds the random generator and sets write protection with the hub-configuration instruction, and never sets the clock",
    });
    expect!(
        "nothing-recorded",
        "the host reads no clock word",
        "a word with any of its top four bits set configures a hub circuit other than the clock generator"
    );
    expect!(
        "pass-runs-on",
        "a timed pass that asks to stop on a clock change runs on to its deadline"
    );
    check_encodings();

    let mut m = machine(&[
        hubset(R_FILTER),
        hubset(R_SEED),
        hubset(R_PROTECT),
        JMP_SELF,
    ]);
    m.yield_on_clock_word = true;
    m.step_until_clocks(DEADLINE).expect("runs to the deadline");

    assert_eq!(m.cogs[0].pc, MAIN + 12, "every HUBSET has run");
    assert_eq!(m.take_clock_word(), None, "clock word recorded");
    assert!(
        m.cogs[0].clocks >= DEADLINE,
        "the pass reached its deadline"
    );
    assert_eq!(m.take_yield_clocks(), None, "the pass did not yield");
}

#[test]
fn a_timed_pass_asked_to_yield_ends_after_the_clock_hubset() {
    behaviour!(Test {
        id: "p2.step-until-clocks-yields-on-clock",
        covers: Some("SIL/p2core/src/lib.rs#step_until_clocks"),
        given: "a timed pass with a distant deadline, asked to stop when the guest changes its clock, over a program that sets the clock and then configures other hub circuits",
    });
    expect!(
        "ends-after-clock-set",
        "the pass ends at the instruction after the one that set the clock",
        "the host has to retime the guest before it runs any further at the new rate"
    );
    expect!(
        "yield-instant",
        "the pass reports the setting cog's clock count once that instruction has run, and reports it only once"
    );
    expect!(
        "next-pass-runs-on",
        "the next pass runs the remaining configuration through to its deadline without stopping"
    );
    check_encodings();

    let mut m = machine(&clock_then_others());
    m.yield_on_clock_word = true;
    m.step_until_clocks(DEADLINE).expect("runs until the yield");

    assert_eq!(m.cogs[0].pc, AFTER_CLOCK, "stopped after the clock HUBSET");
    assert_eq!(m.cogs[0].regs[10], 0, "the next instruction has not run");
    assert_eq!(
        m.take_yield_clocks(),
        Some(m.cogs[0].clocks),
        "the yield instant is the cog's clock"
    );
    assert_eq!(m.take_yield_clocks(), None, "the instant is taken once");
    assert_eq!(
        m.take_clock_word().map(|(w, _)| w),
        Some(CLOCK_WORD),
        "the word is waiting for the host"
    );

    m.step_until_clocks(DEADLINE).expect("runs on");
    assert_eq!(m.cogs[0].pc, SPIN, "the rest of the program ran");
    assert!(
        m.cogs[0].clocks >= DEADLINE,
        "the pass reached its deadline"
    );
    assert_eq!(m.take_yield_clocks(), None, "the second pass did not yield");
}

#[test]
fn a_timed_pass_not_asked_to_yield_runs_to_its_deadline() {
    behaviour!(Test {
        id: "p2.step-until-clocks-runs-to-deadline",
        covers: Some("SIL/p2core/src/lib.rs#step_until_clocks"),
        given: "a timed pass that has not been asked to stop on a clock change, over a program that sets the clock",
    });
    expect!(
        "reaches-deadline",
        "the pass runs the whole program and ends once the cog's clock reaches the deadline"
    );
    expect!("no-yield", "the pass reports no yield instant");
    expect!(
        "word-still-kept",
        "the clock word the program set is still there for the host to read"
    );
    check_encodings();

    let mut m = machine(&clock_then_others());
    m.step_until_clocks(DEADLINE).expect("runs to the deadline");

    assert_eq!(m.cogs[0].pc, SPIN, "the whole program ran");
    assert!(
        m.cogs[0].clocks >= DEADLINE,
        "the pass reached its deadline"
    );
    assert_eq!(m.take_yield_clocks(), None, "the pass did not yield");
    assert_eq!(
        m.take_clock_word().map(|(w, _)| w),
        Some(CLOCK_WORD),
        "the recorded word"
    );
}
