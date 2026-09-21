//! `SETQ n` + `WRLONG #imm, addr` fills hub with the immediate.
//!
//! flexcc lowers `memset(p, 0, len)` to exactly that pair (`setq #len/4-1`,
//! `wrlong #0, p`), and every module's `_init` zeroes its data block with it.
//! The register form of the same prefix is a block *copy* from cog RAM.
//! Treating the immediate form as a copy from register 0 upward sprayed cog
//! 0's FCACHE contents over every memset-initialised struct at boot: in this
//! firmware `app_testManagement_data.request.pendingManualMoveCount` picked up
//! the bytes of a `jmp` word, the CONTROL cog then spent forever draining
//! six million phantom moves under its lock, and MONITOR starved on that lock.
//!
//! Encodings follow the P2 word layout `EEEE 1100011 0LI DDDDDDDDD SSSSSSSSS`
//! for WRLONG and `EEEE 1101011 CZL DDDDDDDDD 000101000` for SETQ; each word
//! is checked with `decode()` before it is trusted.

use p2core::{decode, Machine, NullPins, Op, PinBus};

/// `setq #n`: opcode 1101011, L set (immediate D), S = %000101000.
fn setq_imm(n: u32) -> u32 {
    0xF000_0000 | (0b110_1011 << 21) | (1 << 18) | (n << 9) | 0x028
}

/// `wrlong {#}d, #s`: opcode 1100011, L = immediate D, I = immediate S.
/// An immediate S with bit 8 set is a PTRx expression, so the target hub
/// addresses below stay under 0x100.
fn wrlong(d: u32, d_imm: bool, s: u32) -> u32 {
    0xF000_0000
        | (0b110_0011 << 21)
        | ((d_imm as u32) << 19)
        | (1 << 18)
        | ((d & 0x1FF) << 9)
        | (s & 0x1FF)
}

/// `jmp #$` — park the cog once the transfer is done.
const JMP_SELF: u32 = 0xFD9F_FFFC;

fn machine_running(words: &[u32]) -> Machine<NullPins> {
    let mut m = Machine::new(&[0u8; 4096], NullPins);
    m.cogs[0].running = true;
    for (k, w) in words.iter().enumerate() {
        let a = 0x400 + 4 * k;
        m.hub[a..a + 4].copy_from_slice(&w.to_le_bytes());
    }
    m.cogs[0].pc = 0x400;
    m
}

fn hub_long(m: &Machine<NullPins>, a: usize) -> u32 {
    u32::from_le_bytes([m.hub[a], m.hub[a + 1], m.hub[a + 2], m.hub[a + 3]])
}

#[test]
fn setq_wrlong_with_an_immediate_fills_every_long_with_that_immediate() {
    let setq = setq_imm(3);
    let fill = wrlong(0x5A, true, 0x80);
    let s = decode(setq).expect("setq decodes");
    assert_eq!((s.op, s.d), (Op::Setq, 3));
    let w = decode(fill).expect("wrlong decodes");
    assert_eq!(
        (w.op, w.l, w.i, w.d, w.s),
        (Op::Wrlong, true, true, 0x5A, 0x80)
    );

    let mut m = machine_running(&[setq, fill, JMP_SELF]);
    // Poison the target and its neighbour so a copy from cog RAM (all zero
    // here) would be visible as zeros, and a fill as the immediate.
    for a in 0x70..0xA0 {
        m.hub[a] = 0xFF;
    }
    m.step(8).expect("runs");

    for k in 0..4 {
        assert_eq!(
            hub_long(&m, 0x80 + 4 * k),
            0x5A,
            "long {k} is the immediate"
        );
    }
    assert_eq!(
        hub_long(&m, 0x7C),
        0xFFFF_FFFF,
        "the long before is untouched"
    );
    assert_eq!(
        hub_long(&m, 0x90),
        0xFFFF_FFFF,
        "the long after is untouched"
    );
}

#[test]
fn setq_wrlong_with_a_register_still_block_copies_from_cog_ram() {
    let setq = setq_imm(1);
    let copy = wrlong(5, false, 0xC0);
    let w = decode(copy).expect("wrlong decodes");
    assert_eq!(
        (w.op, w.l, w.i, w.d, w.s),
        (Op::Wrlong, false, true, 5, 0xC0)
    );

    let mut m = machine_running(&[setq, copy, JMP_SELF]);
    m.cogs[0].regs[5] = 0x1111_1111;
    m.cogs[0].regs[6] = 0x2222_2222;
    m.cogs[0].regs[7] = 0x3333_3333;
    m.step(8).expect("runs");

    assert_eq!(
        hub_long(&m, 0xC0),
        0x1111_1111,
        "first long comes from register 5"
    );
    assert_eq!(
        hub_long(&m, 0xC4),
        0x2222_2222,
        "second long comes from register 6"
    );
    assert_eq!(hub_long(&m, 0xC8), 0, "the block stops after Q+1 longs");
}

/// A spin on a *pin* keeps executing while a transfer is in flight.
///
/// `testp` changes nothing and passes every purity test, so an idle-poll
/// detector will happily call `testp / jmp #$-1` a confirmed idle loop and
/// jump the cog's clock forward. But what that loop waits for is a smart-pin
/// transfer, and the only thing that advances one is the peripheral's own
/// schedule of clock edges. Skip the cog's clock ahead and it executes about
/// one iteration per wake, so the transfer crawls while the driver's own
/// timeout -- `sdmm.cc` gives a data token 125 ms and `wait_ready` 500 ms,
/// both measured as `_cnt()` deltas -- expires. The SD driver then reported a
/// read error and FatFs failed the open before the card was ever sent a write
/// command: 31 writes per run became zero.
///
/// When nothing is clocking, the same spin may still be fast-forwarded: a
/// level can then only change on a net wake, which ends the slice anyway.
#[test]
fn a_spin_on_a_pin_keeps_running_while_a_transfer_is_in_flight() {
    /// A pin bus that is always mid-transfer.
    struct Busy;
    impl PinBus for Busy {
        fn external_transfer_busy(&self) -> bool {
            true
        }
    }

    // A real `testp` word out of the firmware image, so the encoding is the
    // chip's rather than one this test invented.
    let Some(img) = firmware_image() else {
        skip_no_image();
        return;
    };
    let testp = (0x400..img.len() - 4)
        .step_by(4)
        .map(|a| u32::from_le_bytes([img[a], img[a + 1], img[a + 2], img[a + 3]]))
        .find(|&w| {
            // Unconditional, so the loop carries nothing: a conditional
            // `testp` reads the flags its predecessor wrote, which is
            // loop-carried state and disqualifies the loop for other reasons.
            decode(w).map(|d| (d.op, d.cond)) == Some((Op::Testp, 0xF))
        })
        .expect("the image contains an unconditional testp");

    // `jmp #$-1`: relative, S = -2 instructions, back to the testp.
    let jmp_back = (0xFD9F_FFFCu32 & 0xFFF0_0000) | (1 << 20) | 0x1_FFFE;
    assert_eq!(decode(jmp_back).map(|i| i.op), Some(Op::Jmp), "jmp back");

    fn run_spin<P: PinBus>(pins: P, words: [u32; 2]) -> u64 {
        let mut m = Machine::new(&[0u8; 4096], pins);
        m.cogs[0].running = true;
        for (k, w) in words.iter().enumerate() {
            let a = 0x400 + 4 * k;
            m.hub[a..a + 4].copy_from_slice(&w.to_le_bytes());
        }
        m.cogs[0].pc = 0x400;
        m.step_until(10_000).expect("runs");
        assert!(m.now_us() >= 10_000, "virtual time reaches the deadline");
        m.cogs[0].instructions
    }

    let while_busy = run_spin(Busy, [testp, jmp_back]);
    assert!(
        while_busy > 20_000,
        "a pin spin must keep executing while a transfer is in flight; ran only {while_busy}"
    );
}

/// The shipped `propeller2_debug` image, if it has been built.
///
/// These tests source a real instruction word out of it rather than inventing
/// an encoding, so a missing image means the test cannot assert what it claims
/// to. `make test` builds the image (see the `p2image` target), so this is
/// absent only in a job that does not, e.g. CI's `sil-rust`.
fn firmware_image() -> Option<Vec<u8>> {
    std::fs::read(image_path()).ok()
}

fn image_path() -> std::path::PathBuf {
    // A missing image makes every test in this file skip. That is right for a
    // laptop that has not run `make p2image`, and wrong for CI: a job meant to
    // exercise the FlexC-compiled firmware would report green while asserting
    // nothing, which is how this suite once reported 54 passed on an empty run.
    // MAD_REQUIRE_P2_IMAGE turns the skip into a failure wherever the image is
    // supposed to exist.
    let p = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../Firmware/MaDCore/.pio/build/propeller2_debug/program");
    if !p.exists() && std::env::var_os("MAD_REQUIRE_P2_IMAGE").is_some() {
        panic!(
            "MAD_REQUIRE_P2_IMAGE is set but the P2 image is missing at {}. \
             Build it with `make p2image` (or `cd Firmware/MaDCore && pio run -e propeller2_debug`).",
            p.display()
        );
    }
    p
}

/// Loud on purpose: a skipped ISS test that reads as one grey line in a green
/// run is how this suite once reported 54 passed while asserting nothing.
fn skip_no_image() {
    eprintln!(
        "\n*** SKIPPED: {} needs the P2 image at\n***   {}\n*** Build it with `make p2image` (or `cd ../Firmware/MaDCore && pio run -e propeller2_debug`).\n*** This test asserted NOTHING.\n",
        module_path!(),
        image_path().display()
    );
}
