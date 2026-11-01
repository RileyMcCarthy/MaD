//! `QROTATE D,S` rotates the point `(X, Y) = (D, Q)` by the angle `S`, where a
//! full turn is 2^32 and `Q` comes from a preceding `SETQ` (0 without one).
//! Both components are signed 32-bit; the rotated point lands in `QX`/`QY`.
//!
//! p2core used to rotate `(D, 0)`, dropping the `SETQ`'d Y, and read D as
//! unsigned, so a negative X became ~4e9 and saturated. The firmware does not
//! use QROTATE yet; this pins it before something does.
//!
//! Rounding is f64 trig truncated toward zero, which is NOT verified against
//! silicon (see hwtest/README.md), so off-axis angles allow one count either
//! way. The 0/90/180/270 degree cases are exact.
//!
//! Encodings follow the P2 word layout (PNut-TS table, vendor/parseUtils.ts):
//! `EEEE 1101010 0LI DDDDDDDDD SSSSSSSSS` for QROTATE,
//! `EEEE 1101011 00L DDDDDDDDD 000101000` for SETQ, and
//! `EEEE 1101011 CZ0 DDDDDDDDD 0000110xx` for GETQX/GETQY; each word is
//! checked with `decode()` before it is trusted.

use p2core::{decode, Machine, NullPins, Op};
use vibes_behaviour::{behaviour, expect, Test};

/// `qrotate d, s` with both operands in registers.
fn qrotate(d: u32, s: u32) -> u32 {
    0xF000_0000 | (0b110_1010 << 21) | ((d & 0x1FF) << 9) | (s & 0x1FF)
}

/// `setq d` with D in a register.
fn setq(d: u32) -> u32 {
    0xF000_0000 | (0b110_1011 << 21) | ((d & 0x1FF) << 9) | 0x028
}

/// `getqx d`.
fn getqx(d: u32) -> u32 {
    0xF000_0000 | (0b110_1011 << 21) | ((d & 0x1FF) << 9) | 0x018
}

/// `getqy d`.
fn getqy(d: u32) -> u32 {
    0xF000_0000 | (0b110_1011 << 21) | ((d & 0x1FF) << 9) | 0x019
}

/// `jmp #$`: park the cog once the result is read back.
const JMP_SELF: u32 = 0xFD9F_FFFC;

/// A quarter turn in QROTATE's angle units.
const QUARTER: u32 = 1 << 30;

fn check_encodings() {
    let r = decode(qrotate(10, 11)).expect("qrotate decodes");
    assert_eq!(
        (r.op, r.d, r.s, r.l, r.i),
        (Op::Qrotate, 10, 11, false, false)
    );
    let q = decode(setq(13)).expect("setq decodes");
    assert_eq!((q.op, q.d, q.l), (Op::Setq, 13, false));
    assert_eq!(decode(getqx(12)).expect("getqx decodes").op, Op::Getqx);
    assert_eq!(decode(getqy(14)).expect("getqy decodes").op, Op::Getqy);
}

/// `(QX, QY)` from the ISS for `qrotate x, angle`, preceded by `setq y` when
/// `y` is given.
fn iss_rotate(x: i32, y: Option<i32>, angle: u32) -> (i32, i32) {
    let mut program = Vec::new();
    if y.is_some() {
        program.push(setq(13));
    }
    program.extend([qrotate(10, 11), getqx(12), getqy(14), JMP_SELF]);
    let mut m = Machine::new(&[0u8; 4096], NullPins);
    m.cogs[0].running = true;
    for (k, w) in program.iter().enumerate() {
        let a = 0x400 + 4 * k;
        m.hub[a..a + 4].copy_from_slice(&w.to_le_bytes());
    }
    m.cogs[0].pc = 0x400;
    m.cogs[0].regs[10] = x as u32;
    m.cogs[0].regs[11] = angle;
    m.cogs[0].regs[13] = y.unwrap_or(0) as u32;
    m.cogs[0].regs[12] = 0xDEAD_BEEF;
    m.cogs[0].regs[14] = 0xDEAD_BEEF;
    m.step(program.len() as u64 + 4).expect("runs");
    (m.cogs[0].regs[12] as i32, m.cogs[0].regs[14] as i32)
}

/// The rotated point by the definition, for off-axis angles.
fn reference(x: i32, y: i32, angle: u32) -> (f64, f64) {
    let theta = angle as f64 * std::f64::consts::TAU / 4_294_967_296.0;
    let (s, c) = theta.sin_cos();
    let (x, y) = (x as f64, y as f64);
    (x * c - y * s, x * s + y * c)
}

fn assert_near(got: (i32, i32), want: (f64, f64), what: &str) {
    assert!(
        (got.0 as f64 - want.0).abs() <= 1.0 && (got.1 as f64 - want.1).abs() <= 1.0,
        "{what}: got {got:?}, want about ({:.1}, {:.1})",
        want.0,
        want.1
    );
}

#[test]
fn qrotate_without_setq_rotates_x_alone() {
    behaviour!(Test {
        id: "p2.qrotate-without-setq",
        covers: Some("SIL/p2core/src/lib.rs#execute"),
        given: "a CORDIC rotation of a point on the X axis, with no SETQ before it",
    });
    expect!(
        "y-is-zero",
        "the point rotated is (D, 0), so the result is (D cos S, D sin S) at every angle",
        "code that never sets Y must keep getting the rotation it got before SETQ was honoured"
    );
    check_encodings();

    let x = 1_000_000;
    assert_eq!(iss_rotate(x, None, 0), (x, 0), "0 degrees");
    assert_eq!(iss_rotate(x, None, QUARTER), (0, x), "90 degrees");
    assert_eq!(iss_rotate(x, None, 2 * QUARTER), (-x, 0), "180 degrees");
    assert_eq!(iss_rotate(x, None, 3 * QUARTER), (0, -x), "270 degrees");
    for angle in [QUARTER / 2, QUARTER / 3, 0x1234_5678] {
        assert_near(
            iss_rotate(x, None, angle),
            reference(x, 0, angle),
            &format!("angle {angle:#010x}"),
        );
    }
}

#[test]
fn qrotate_takes_y_from_setq() {
    behaviour!(Test {
        id: "p2.qrotate-setq-supplies-y",
        covers: Some("SIL/p2core/src/lib.rs#execute"),
        given: "a CORDIC rotation of the point (D, Q), with Q set by the SETQ just before it",
    });
    expect!(
        "y-rotated",
        "the result is the whole point rotated: (X cos S - Y sin S, X sin S + Y cos S)",
        "on silicon SETQ supplies the Y component, and dropping it rotates a different point without any error"
    );
    expect!(
        "setq-used-once",
        "a QROTATE after it without its own SETQ rotates with Y = 0 again"
    );
    check_encodings();

    let (x, y) = (1000, 2000);
    assert_eq!(iss_rotate(x, Some(y), 0), (x, y), "0 degrees");
    assert_eq!(iss_rotate(x, Some(y), QUARTER), (-y, x), "90 degrees");
    assert_eq!(iss_rotate(x, Some(y), 2 * QUARTER), (-x, -y), "180 degrees");
    assert_near(
        iss_rotate(x, Some(y), QUARTER / 2),
        reference(x, y, QUARTER / 2),
        "45 degrees",
    );

    // `setq / qrotate / qrotate`: only the first rotation sees Q.
    let program = [
        setq(13),
        qrotate(10, 11),
        qrotate(10, 11),
        getqx(12),
        getqy(14),
        JMP_SELF,
    ];
    let mut m = Machine::new(&[0u8; 4096], NullPins);
    m.cogs[0].running = true;
    for (k, w) in program.iter().enumerate() {
        let a = 0x400 + 4 * k;
        m.hub[a..a + 4].copy_from_slice(&w.to_le_bytes());
    }
    m.cogs[0].pc = 0x400;
    m.cogs[0].regs[10] = x as u32;
    m.cogs[0].regs[11] = QUARTER;
    m.cogs[0].regs[13] = y as u32;
    m.step(program.len() as u64 + 4).expect("runs");
    assert_eq!(
        (m.cogs[0].regs[12] as i32, m.cogs[0].regs[14] as i32),
        (0, x),
        "the second qrotate rotated (X, 0)"
    );
}

#[test]
fn qrotate_operands_are_signed() {
    behaviour!(Test {
        id: "p2.qrotate-signed-operands",
        covers: Some("SIL/p2core/src/lib.rs#execute"),
        given: "a CORDIC rotation whose X, Y or both are negative",
    });
    expect!(
        "negative-x-and-y",
        "negative X and Y are rotated as signed negative numbers",
        "a negative X read as unsigned saturates the result at the largest long"
    );
    check_encodings();

    assert_eq!(
        iss_rotate(-1000, None, 0),
        (-1000, 0),
        "negative X, 0 degrees"
    );
    assert_eq!(
        iss_rotate(-1000, None, QUARTER),
        (0, -1000),
        "negative X, 90 degrees"
    );
    assert_eq!(
        iss_rotate(-1000, Some(-2000), QUARTER),
        (2000, -1000),
        "both negative, 90 degrees"
    );
    assert_eq!(
        iss_rotate(1000, Some(-2000), 2 * QUARTER),
        (-1000, 2000),
        "negative Y, 180 degrees"
    );
    assert_near(
        iss_rotate(3000, Some(-4000), QUARTER / 2),
        reference(3000, -4000, QUARTER / 2),
        "negative Y, 45 degrees",
    );
}
