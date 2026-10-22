//! `COGINIT D,S {WC}` reports back to its caller (MaD #282).
//!
//! FlexC's `_coginit` returns the started cog's id by reading it back from
//! COGINIT's D register, and checks C after `WC` for "no cog was free". Before
//! the fix the ISS wrote neither: D kept the request word (`$1E`, read as cog
//! 30 in every channel of `dev_cogManager`'s table) and a full machine trapped
//! instead of setting C.

use p2core::{Machine, SmartPins, Trap};
use vibes_behaviour::{behaviour, expect, Test};

const COGINIT: u32 = 0x67;
const MOV: u32 = 0x30;
const JMP_REL: u32 = 0x6C;

/// Hub address the started cog loads its (one-instruction) image from.
const WORKER: u32 = 0x100;

/// D register the caller passes to COGINIT: clear of the three code longs,
/// which share cog RAM with the registers.
const R: u32 = 0x20;

/// `EEEE OOOOOOO CZI DDDDDDDDD SSSSSSSSS`, unconditional.
fn ins(op: u32, d: u32, s: u32, c: u32, z: u32, i: u32) -> u32 {
    (0xF << 28) | (op << 21) | (c << 20) | (z << 19) | (i << 18) | (d << 9) | s
}

/// `JMP #$` -- park in place (same shape as `tools/cogtest.py`).
fn park() -> u32 {
    (0xF << 28) | (JMP_REL << 21) | (1 << 20) | ((-4i32 as u32) & 0xFFFFF)
}

/// Cog 0: `mov R, #request` / `coginit D, #WORKER {wc}` / park, with D the
/// register R -- or, with `d_literal` (COGINIT's L bit, bit 19), the literal
/// `#request` itself.
fn image(request: u32, wc: bool, d_literal: bool) -> Vec<u8> {
    let d_field = if d_literal { request } else { R };
    let words = [
        ins(MOV, R, request, 0, 0, 1),
        ins(COGINIT, d_field, WORKER, wc as u32, d_literal as u32, 1),
        park(),
    ];
    let mut img = vec![0u8; WORKER as usize + 4];
    for (k, w) in words.iter().enumerate() {
        img[4 * k..4 * k + 4].copy_from_slice(&w.to_le_bytes());
    }
    img[WORKER as usize..].copy_from_slice(&park().to_le_bytes());
    img
}

/// D[4]: start the lowest free cog, in cog-exec.
const ANY_FREE: u32 = 0x10;

#[test]
fn coginit_writes_the_started_cogs_id_to_a_register_d() {
    behaviour!(Test {
        id: "p2.coginit-reports-started-cog",
        covers: Some("SIL/p2core/src/lib.rs#coginit"),
        given: "a cog that asks to start any free cog, passing the request in a register and asking for the carry flag, while every other cog is stopped",
    });
    expect!("lowest-free-started", "the lowest-numbered free cog starts");
    expect!(
        "id-in-register",
        "the register then holds the started cog's number",
        "compiled C reads that register back as the started cog's id"
    );
    expect!("carry-clear", "the carry flag is cleared to report success");
    let mut m = Machine::new(&image(ANY_FREE, true, false), SmartPins::default());
    m.cogs[0].c = true;
    m.step(2).expect("mov + coginit run without a trap");

    assert!(m.cogs[1].running, "cog 1 is the lowest free cog");
    assert_eq!(
        m.cogs[0].regs[R as usize], 1,
        "D holds the started cog's id"
    );
    assert!(!m.cogs[0].c, "WC clears C on success");
}

#[test]
fn coginit_picks_the_next_free_cog_and_reports_it() {
    behaviour!(Test {
        id: "p2.coginit-reports-next-free-cog",
        covers: Some("SIL/p2core/src/lib.rs#coginit"),
        given: "a cog that asks to start any free cog, passing the request in a register, while cogs 1 to 4 are already running",
    });
    expect!(
        "next-free-reported",
        "cog 5 starts and the register holds 5"
    );
    let mut m = Machine::new(&image(ANY_FREE, true, false), SmartPins::default());
    for i in 1..=4 {
        m.cogs[i].running = true;
    }
    // Step cog 0 only up to the COGINIT; the other "running" cogs are idle
    // zero-filled RAM, so keep them from executing.
    m.step(1).unwrap();
    for i in 1..=4 {
        m.cogs[i].clocks = u64::MAX / 2;
    }
    m.step(1).expect("coginit runs");

    assert!(m.cogs[5].running);
    assert_eq!(m.cogs[0].regs[R as usize], 5);
}

#[test]
fn coginit_wc_sets_c_when_no_cog_is_free() {
    behaviour!(Test {
        id: "p2.coginit-no-free-cog-carry",
        covers: Some("SIL/p2core/src/lib.rs#coginit"),
        given: "a cog that asks to start any free cog and asks for the carry flag, while all eight cogs are running",
    });
    expect!(
        "carry-set",
        "the carry flag is set to report that no cog was free, and the simulator keeps running",
        "compiled C checks the carry flag and returns -1"
    );
    expect!(
        "register-kept",
        "the request register keeps its value, since no cog started"
    );
    let mut m = Machine::new(&image(ANY_FREE, true, false), SmartPins::default());
    for i in 1..8 {
        m.cogs[i].running = true;
        m.cogs[i].clocks = u64::MAX / 2;
    }
    m.step(2).expect("a full machine reports via C, not a trap");

    assert!(m.cogs[0].c, "C = 1: no cog was free");
    assert_eq!(
        m.cogs[0].regs[R as usize], ANY_FREE,
        "nothing started, so D is left as it was"
    );
}

#[test]
fn coginit_without_wc_still_traps_when_no_cog_is_free() {
    behaviour!(Test {
        id: "p2.coginit-no-free-cog-trap",
        covers: Some("SIL/p2core/src/lib.rs#coginit"),
        given: "a cog that asks to start any free cog without asking for the carry flag, while all eight cogs are running",
    });
    expect!(
        "traps",
        "the simulator stops with a no-free-cog trap for that cog",
        "with no carry flag to read, nothing in the program would notice the failure"
    );
    let mut m = Machine::new(&image(ANY_FREE, false, false), SmartPins::default());
    for i in 1..8 {
        m.cogs[i].running = true;
        m.cogs[i].clocks = u64::MAX / 2;
    }
    m.step(1).unwrap();
    assert!(matches!(m.step(1), Err(Trap::NoFreeCog { cog: 0, .. })));
}

#[test]
fn coginit_with_a_literal_d_writes_no_register() {
    behaviour!(Test {
        id: "p2.coginit-literal-request",
        covers: Some("SIL/p2core/src/lib.rs#coginit"),
        given: "a cog that asks to start any free cog with the request written into the instruction itself rather than a register",
    });
    expect!("starts", "cog 1 starts");
    expect!(
        "no-register-written",
        "no register is written with the started cog's number"
    );
    // `coginit #ANY_FREE, ...`: there is no D register to write, so the
    // register numbered like the literal keeps what the MOV put there.
    let mut m = Machine::new(&image(ANY_FREE, true, true), SmartPins::default());
    m.step(2).expect("coginit runs");

    assert!(m.cogs[1].running);
    assert_eq!(m.cogs[0].regs[R as usize], ANY_FREE);
    assert_eq!(
        m.cogs[0].regs[ANY_FREE as usize], 0,
        "register $10 untouched"
    );
}
