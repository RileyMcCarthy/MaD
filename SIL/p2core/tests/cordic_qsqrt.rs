//! `QSQRT D,S` roots the 64-bit value {S,D} -- S is the HIGH long, D the low
//! one -- and `GETQX` hands back the floored 32-bit root.
//!
//! FlexC's `sqrtf` issues exactly `qsqrt #0, mantissa`: the mantissa goes in
//! the HIGH half so the root keeps 31 significant bits. The ISS once rooted D
//! alone, so that form returned 0 and every `sqrtf` the firmware evaluated
//! came back as a bare power of two. The servo's triangle planner then refused
//! every triangle waveform on the ISS board -- an E2E failure that looked like
//! the firmware ending the move early (MaD #164).

use p2core::{decode, isqrt_u64, Machine, NullPins, Op};
use vibes_behaviour::{behaviour, expect, Test};

const QSQRT: u32 = 0b110_1001;
const MISC: u32 = 0b110_1011;
const S_GETQX: u32 = 0x18;
/// `jmp #$`: park the cog once the result is read.
const PARK: u32 = 0xFD9F_FFFC;

/// Scratch registers well clear of the program at cog $000.
const REG_D: u32 = 0x100;
const REG_S: u32 = 0x101;
const REG_OUT: u32 = 0x102;

/// `qsqrt D, S` with both operands in registers (C=1 selects QSQRT in the
/// QFRAC/QSQRT pair).
fn qsqrt_reg(d: u32, s: u32) -> u32 {
    0xF000_0000 | (QSQRT << 21) | (1 << 20) | ((d & 0x1FF) << 9) | (s & 0x1FF)
}

/// `qsqrt #imm, S` -- the L bit makes D an immediate. FlexC's float square
/// root uses this form with `#0`.
fn qsqrt_imm_d(imm: u32, s: u32) -> u32 {
    0xF000_0000 | (QSQRT << 21) | (1 << 20) | (1 << 19) | ((imm & 0x1FF) << 9) | (s & 0x1FF)
}

fn getqx(d: u32) -> u32 {
    0xF000_0000 | (MISC << 21) | ((d & 0x1FF) << 9) | S_GETQX
}

/// Run `program` from cog $000 with D and S preloaded; return what GETQX read.
fn run(program: &[u32], d: u32, s: u32) -> u32 {
    let bytes: Vec<u8> = program.iter().flat_map(|w| w.to_le_bytes()).collect();
    let mut m = Machine::new(&bytes, NullPins);
    m.cogs[0].regs[REG_D as usize] = d;
    m.cogs[0].regs[REG_S as usize] = s;
    m.cogs[0].regs[REG_OUT as usize] = 0xDEAD_BEEF;
    m.step(16).expect("qsqrt/getqx never trap");
    m.cogs[0].regs[REG_OUT as usize]
}

fn root_of(d: u32, s: u32) -> u32 {
    run(&[qsqrt_reg(REG_D, REG_S), getqx(REG_OUT), PARK], d, s)
}

#[test]
fn the_encodings_are_what_they_claim() {
    assert_eq!(
        decode(qsqrt_reg(REG_D, REG_S)).expect("decodes").op,
        Op::Qsqrt
    );
    assert_eq!(
        decode(qsqrt_imm_d(0, REG_S)).expect("decodes").op,
        Op::Qsqrt
    );
    assert_eq!(decode(getqx(REG_OUT)).expect("decodes").op, Op::Getqx);
}

#[test]
fn qsqrt_roots_the_full_64_bit_radicand() {
    behaviour!(Test {
        id: "p2.qsqrt-64-bit-radicand",
        covers: Some("SIL/p2core/src/lib.rs#execute"),
        given: "the processor's hardware square root asked for the root of a 64-bit number split across its two operands, the upper half in the second",
    });
    expect!(
        "floored-root",
        "it returns the whole-number square root of the full 64-bit number, rounded down, as the silicon does",
        "the board's C compiler finishes every float square root with this instruction and puts the value in the upper half, so every square root the firmware takes depends on both halves being used"
    );
    expect!(
        "compiler-form",
        "the zero-lower-half form the C compiler uses for float square roots returns the root of the value times two to the 32nd"
    );

    // {S,D} pairs across the range, including perfect squares and their
    // neighbours, where a float shortcut rounds the wrong way.
    let cases: [(u32, u32); 9] = [
        (0, 0),
        (1, 0),
        (0, 1),
        (0xFFFF_FFFF, 0xFFFF_FFFF),
        (0xFFFF_FFFE, 0x0000_0001), // (2^32 - 1)^2: a perfect square
        (0xFFFF_FFFE, 0x0000_0000), // one below it
        (0x2000_0000, 0x0000_0000),
        (0x1234_5678, 0x9ABC_DEF0),
        (0x0000_0000, 0xFFFF_FFFF),
    ];
    for (s, d) in cases {
        let want = isqrt_u64(((s as u64) << 32) | d as u64);
        let w = want as u128;
        let n = ((s as u128) << 32) | d as u128;
        assert!(
            w * w <= n && (w + 1) * (w + 1) > n,
            "reference root of {n:#x} is not floored"
        );
        assert_eq!(
            root_of(d, s),
            want,
            "qsqrt of {{S={s:#010x}, D={d:#010x}}} must be the floored root of the 64-bit value"
        );
    }

    // FlexC's `sqrtf` of 0.25: mantissa $0080_0000 with an odd exponent is
    // shifted to $0200_0000 (<<1, then <<5) and rooted as {S=that, D=0}.
    let mant: u32 = 0x0200_0000;
    let got = run(
        &[qsqrt_imm_d(0, REG_S), getqx(REG_OUT), PARK],
        0xFFFF_FFFF,
        mant,
    );
    assert_eq!(
        got,
        isqrt_u64((mant as u64) << 32),
        "`qsqrt #0, S` must root S * 2^32 -- a register D left over in the cog must not leak in"
    );
    assert_ne!(
        got, 0,
        "`qsqrt #0, S` returned 0: the ISS is rooting the low half"
    );
}
