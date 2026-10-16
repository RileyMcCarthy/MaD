//! `QSQRT D,S` roots the 64-bit number `{S, D}`: S is the upper long.
//!
//! FlexC's float `sqrtf` (libsys/ieee32.c `_float_sqrt`) hands the mantissa
//! to the CORDIC as the upper long, `_sqrt64(0, m)`, which its P2 runtime
//! lowers to `qsqrt 0, m`, and reads the root back with 30 fractional bits.
//! Every float square root the firmware takes goes through this one
//! instruction; dev_servo's triangle-waveform feasibility and its braking
//! speed are two of them.
//!
//! Encodings follow the P2 word layout `EEEE 1101001 1LI DDDDDDDDD SSSSSSSSS`
//! for QSQRT and `EEEE 1101011 CZ0 DDDDDDDDD 000011000` for GETQX (PNut-TS
//! table, vendor/parseUtils.ts); each word is checked with `decode()` before
//! it is trusted.

use p2core::{decode, Machine, NullPins, Op};
use vibes_behaviour::{behaviour, expect, Test};

/// `qsqrt d, s` with both operands in registers.
fn qsqrt(d: u32, s: u32) -> u32 {
    0xF000_0000 | (0b110_1001 << 21) | (1 << 20) | ((d & 0x1FF) << 9) | (s & 0x1FF)
}

/// `getqx d`.
fn getqx(d: u32) -> u32 {
    0xF000_0000 | (0b110_1011 << 21) | ((d & 0x1FF) << 9) | 0x018
}

/// `jmp #$` — park the cog once the root is read back.
const JMP_SELF: u32 = 0xFD9F_FFFC;

/// The root the ISS returns for the radicand `{hi, lo}`.
fn iss_root(lo: u32, hi: u32) -> u32 {
    let program = [qsqrt(10, 11), getqx(12), JMP_SELF];
    let mut m = Machine::new(&[0u8; 4096], NullPins);
    m.cogs[0].running = true;
    for (k, w) in program.iter().enumerate() {
        let a = 0x400 + 4 * k;
        m.hub[a..a + 4].copy_from_slice(&w.to_le_bytes());
    }
    m.cogs[0].pc = 0x400;
    m.cogs[0].regs[10] = lo;
    m.cogs[0].regs[11] = hi;
    m.cogs[0].regs[12] = 0xDEAD_BEEF;
    m.step(6).expect("runs");
    m.cogs[0].regs[12]
}

#[test]
fn qsqrt_roots_the_whole_64_bit_radicand() {
    behaviour!(Test {
        id: "p2.qsqrt-roots-64-bit-radicand",
        covers: Some("SIL/p2core/src/lib.rs#execute"),
        given: "a CORDIC square root asked of a 64-bit number, its upper half in the source operand and its lower half in the destination",
    });
    expect!(
        "whole-number-root",
        "the result is the square root of the whole 64-bit number, rounded down to a whole number",
        "the compiler's float square root passes a number's mantissa as the upper half and reads the root back with 30 fractional bits, so every float square root in the firmware depends on the upper half being rooted"
    );

    let q = decode(qsqrt(10, 11)).expect("qsqrt decodes");
    assert_eq!(
        (q.op, q.d, q.s, q.l, q.i),
        (Op::Qsqrt, 10, 11, false, false)
    );
    let g = decode(getqx(12)).expect("getqx decodes");
    assert_eq!((g.op, g.d), (Op::Getqx, 12));

    // (lo, hi): a radicand in the lower half only; one in the upper half
    // only, as `_float_sqrt` passes the mantissa of 0.7867 (odd exponent,
    // so doubled to 3.1467 in 2.28); and the top of the range, where an f64
    // rounds the radicand up to the next square and the floor comes out one
    // too high.
    let mantissa = ((0.786_667_f32.to_bits() & 0x007F_FFFF) | 0x0080_0000) << 1 << 5;
    let cases: [(u32, u32); 5] = [
        (1_000_000, 0),
        (0, 1),
        (0, mantissa),
        (0, 0xFFFF_FFFE),
        (0xFFFF_FFFF, 0xFFFF_FFFF),
    ];
    for (lo, hi) in cases {
        let radicand = ((hi as u128) << 32) | lo as u128;
        let root = iss_root(lo, hi) as u128;
        assert!(
            root * root <= radicand && (root + 1) * (root + 1) > radicand,
            "qsqrt {{{hi:#010x}, {lo:#010x}}} gave {root:#x}, not the floor root of {radicand:#x}"
        );
    }

    // The float the firmware then builds: the root's top 24 bits, scaled
    // by the halved exponent, are sqrt(0.7867) to float precision.
    let root = iss_root(0, mantissa);
    let back = (root >> 7) as f32 / (1u32 << 23) as f32 * 0.5;
    assert!(
        (back - 0.786_667_f32.sqrt()).abs() < 1e-6,
        "sqrtf(0.7867) through the ISS is {back}, the true root is {}",
        0.786_667_f32.sqrt()
    );
}
