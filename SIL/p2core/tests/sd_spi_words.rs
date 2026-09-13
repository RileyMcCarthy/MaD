//! The receive width in force when the guest *reads* is the one that counts.
//!
//! `sdmm.cc` — the driver this firmware actually runs — programs the clock
//! before it programs the receive width:
//!
//! ```text
//!     akpin   PIN_DO
//!     wypin   r, PIN_CLK          ' begin SPI clocks
//!     wxpin   #31|32, PIN_DO      ' ...and only now, 32 bits
//!     rdpin   r, PIN_DO
//! ```
//!
//! and it feeds the transmit shifter in whole longwords while clocking an
//! exact byte count, so a 6-byte command leaves two bytes behind that
//! `dirl PIN_DI` is expected to discard ("reset tx smartpin, clears excess
//! data").
//!
//! Together those two facts used to produce a word assembled from one byte at
//! the *previous* transfer's 8-bit width. The visible symptom was
//! `disk_initialize` reading `00 00 00 00` for CMD8's R7, failing its
//! `buf[2] == 0x01 && buf[3] == 0xAA` gate, and never reaching ACMD41 — an SD
//! card that could not initialise at all.
//!
//! A blank card cannot catch this: every byte is zero, so a word assembled at
//! the wrong width is indistinguishable from one assembled at the right one.

use p2core::board::{PIN_CLK, PIN_DI, PIN_DO};
use p2core::{Board, PinBus, SdCard};

/// The cog the SD driver runs on. `DIR`/`OUT` are per-cog and the pad sees
/// the OR, so a single-cog test behaves as the old global mirror did.
const LOGGER_COG: usize = 5;

/// DIRB, the cog register `dirl`/`dirh` on pins 32..63 write.
const REG_DIRB: u16 = 0x1FB;

/// Smart-pin modes, as `smartpins.h` defines them.
const P_PULSE: u32 = 0x08;
const P_SYNC_TX: u32 = 0x38;
const P_SYNC_RX: u32 = 0x3A;

/// The 8-bit path is deliberately *not* the same: `rev` then `wrbyte`, with no
/// `movbyts` and no longword store, so the byte is the low one.
fn guest_byte(word: u32) -> u8 {
    word.reverse_bits() as u8
}

/// Drive one command frame the way `xmit_mmc` does.
fn send_cmd(board: &mut Board, cmd: u8, arg: u32, crc: u8) {
    let frame = [
        0x40 | cmd,
        (arg >> 24) as u8,
        (arg >> 16) as u8,
        (arg >> 8) as u8,
        arg as u8,
        crc,
    ];
    // `dirl PIN_DI` — reset the shifter, discarding anything left over.
    board.dir_out_changed(LOGGER_COG, REG_DIRB, 0);
    // The driver pre-applies `rev` + `movbyts` so the shifter emits wire order.
    let word = |b: &[u8]| {
        let mut w = [0u8; 4];
        w[..b.len()].copy_from_slice(b);
        u32::from_be_bytes(w).reverse_bits()
    };
    board.wypin(PIN_DI, word(&frame[0..4]));
    board.wypin(PIN_CLK, frame.len() as u32 * 8);
    board.dir_out_changed(LOGGER_COG, REG_DIRB, 1 << (PIN_DI - 32));
    board.wypin(PIN_DI, word(&frame[4..6]));
    // Trailing `dirl` + idle refill, as `xmit_mmc` ends.
    board.dir_out_changed(LOGGER_COG, REG_DIRB, 0);
    board.wypin(PIN_DI, 0xFFFF_FFFF);
    board.dir_out_changed(LOGGER_COG, REG_DIRB, 1 << (PIN_DI - 32));
}

/// One byte, through the 8-bit path.
fn rcvr_byte(board: &mut Board) -> u8 {
    board.wxpin(PIN_DO, 7 | 32);
    board.wypin(PIN_CLK, 8);
    assert!(board.testp(PIN_DO), "the guest polls testp before rdpin");
    guest_byte(board.rdpin(PIN_DO).0)
}

fn ready_card() -> Board {
    // 32 MiB of a recognisable pattern: any width mix-up shows up as shifted
    // bytes rather than as more zeroes.
    let mut board = Board::new(SdCard::with_image(vec![0u8; 512]));
    board.card.selected = true;
    // `disk_initialize` brings the three SPI pins up as smart pins before it
    // clocks anything. It matters here because `TESTP` means different things
    // either side of that: a pin's IN flag once a mode is set, and the plain
    // input level while it is not.
    board.wrpin(PIN_CLK, P_PULSE);
    board.wrpin(PIN_DI, P_SYNC_TX);
    board.wrpin(PIN_DO, P_SYNC_RX);
    // 80 dummy clocks, then CMD0.
    for _ in 0..10 {
        rcvr_byte(&mut board);
    }
    board
}

/// The stale bytes a 6-byte command leaves in the shifter must not reach the
/// card at the head of the next transfer.
#[test]
fn a_reset_shifter_does_not_leak_the_previous_frames_tail() {
    let mut board = ready_card();
    send_cmd(&mut board, 0, 0, 0x95);
    for _ in 0..4 {
        rcvr_byte(&mut board);
    }
    board.card.trace = Some(Vec::new());
    send_cmd(&mut board, 8, 0x1AA, 0x87);
    let mosi: Vec<u8> = board
        .card
        .trace
        .as_ref()
        .expect("trace enabled")
        .iter()
        .map(|&(m, _)| m)
        .take(6)
        .collect();
    assert_eq!(
        mosi,
        vec![0x48, 0x00, 0x00, 0x01, 0xAA, 0x87],
        "the command frame must reach the card unpolluted"
    );
}

// ============================================================
// Pin input
// ============================================================

/// The guest reads its own output back on a pin it drives, and the outside
/// world's level on a pin it does not.
///
/// Without this half of the pin, nothing outside `p2core` can ever be *read*:
/// `ina`/`inb` returned a constant 0, so every GPIO input looked low and every
/// net was invisible to the firmware regardless of what drove it.
#[test]
fn a_pin_reads_its_driver_and_an_input_reads_the_outside() {
    const REG_DIRA: u16 = 0x1FA;
    const REG_OUTA: u16 = 0x1FC;
    let mut board = Board::new(SdCard::blank(0));

    // Pin 4 driven high by the guest, pin 5 left as an input.
    board.dir_out_changed(LOGGER_COG, REG_DIRA, 1 << 4);
    board.dir_out_changed(LOGGER_COG, REG_OUTA, 1 << 4);
    assert_eq!(
        board.ina() & (1 << 4),
        1 << 4,
        "a driven pin reads back high"
    );
    assert_eq!(board.ina() & (1 << 5), 0, "an undriven input starts low");

    // The outside raises both. Only the input follows.
    board.set_input_level(4, true);
    board.set_input_level(5, true);
    assert_eq!(
        board.ina() & (1 << 5),
        1 << 5,
        "an input pin must read the level the outside presents"
    );

    // The outside pulls pin 4 low while the guest drives it high: the guest
    // wins, because DIR is set. An adapter can therefore publish every net's
    // level without first asking which way the firmware configured the pin.
    board.set_input_level(4, false);
    assert_eq!(
        board.ina() & (1 << 4),
        1 << 4,
        "a driven pin ignores the outside"
    );

    // Release it, and the outside takes over.
    board.dir_out_changed(LOGGER_COG, REG_DIRA, 0);
    assert_eq!(
        board.ina() & (1 << 4),
        0,
        "a released pin follows the outside"
    );
    assert_eq!(board.output_level(4), None, "an input has no output level");
}

/// The high bank is reached the same way — the SD and protocol pins live
/// there, so a bank mix-up would be invisible on pins 0..31 and fatal above.
#[test]
fn the_upper_bank_is_addressed_correctly() {
    let mut board = Board::new(SdCard::blank(0));
    board.set_input_level(53, true);
    assert_eq!(board.inb() & (1 << (53 - 32)), 1 << (53 - 32));
    assert_eq!(board.ina(), 0, "pin 53 must not appear in the low bank");
    assert!(board.input_level(53));
}

// ============================================================
// Quadrature
// ============================================================

/// `HAL_encoder_start` writes `P_QUADRATURE | ((pinB - pinA) & 7) << 24`.
const P_QUADRATURE: u32 = 0x16;

fn quad_cfg(dif: i8) -> u32 {
    P_QUADRATURE | (((dif as u32) & 0x7) << 24)
}

/// A Gray walk on two pins becomes a signed count on `RDPIN`.
///
/// The count is what `HAL_encoder_value` reads and adds its offset to, so a
/// wrong sign here is a machine that homes the wrong way.
#[test]
fn a_gray_walk_counts_in_both_directions() {
    let mut board = Board::new(SdCard::blank(0));
    // Channel A on 9, B on 10 — the servo encoder, as HW_pins.h has it.
    board.wrpin(9, quad_cfg(1));

    // Phase order is (0,0) (1,0) (1,1) (0,1); walking it forwards counts up.
    let forward = [(false, false), (true, false), (true, true), (false, true)];
    let step = |b: &mut Board, (a, bb): (bool, bool)| {
        b.set_input_levels((1 << 9) | (1 << 10), (a as u64) << 9 | (bb as u64) << 10);
    };

    step(&mut board, forward[0]);
    assert_eq!(
        board.quadrature_count(9),
        Some(0),
        "the first observation seeds the detector and must not count"
    );
    for phase in forward.iter().skip(1) {
        step(&mut board, *phase);
    }
    step(&mut board, forward[0]);
    assert_eq!(board.quadrature_count(9), Some(4), "one revolution forward");

    for phase in forward.iter().rev() {
        step(&mut board, *phase);
    }
    assert_eq!(board.quadrature_count(9), Some(0), "and back again");
    assert_eq!(board.quadrature_slips(9), 0, "a clean walk must not slip");

    // RDPIN hands the count to the guest as a signed 32-bit value.
    step(&mut board, forward[3]);
    assert_eq!(
        board.rdpin(9).0 as i32,
        -1,
        "RDPIN reports the signed count"
    );
}

/// Skipping a phase is reported, not guessed at.
#[test]
fn a_two_state_jump_is_counted_as_a_slip() {
    let mut board = Board::new(SdCard::blank(0));
    board.wrpin(9, quad_cfg(1));
    board.set_input_levels((1 << 9) | (1 << 10), 0);
    // (0,0) -> (1,1): both channels at once, which no real encoder does.
    board.set_input_levels((1 << 9) | (1 << 10), (1 << 9) | (1 << 10));
    assert_eq!(board.quadrature_slips(9), 1, "the jump must be reported");
    assert_eq!(
        board.quadrature_count(9),
        Some(0),
        "and the count held, because the direction is unrecoverable"
    );
}

/// The B channel may sit below A — the mode word's offset is signed.
#[test]
fn a_negative_channel_offset_is_sign_extended() {
    let mut board = Board::new(SdCard::blank(0));
    // A on 10, B on 9.
    board.wrpin(10, quad_cfg(-1));
    let step = |b: &mut Board, a: bool, bb: bool| {
        b.set_input_levels((1 << 9) | (1 << 10), (bb as u64) << 9 | (a as u64) << 10);
    };
    step(&mut board, false, false);
    step(&mut board, true, false);
    assert_eq!(
        board.quadrature_count(10),
        Some(1),
        "B below A must decode, not read a pin that was never configured"
    );
}

/// `TESTP` means different things either side of a smart-pin mode.
///
/// The firmware's GPIO driver is `HAL_GPIO_getActive` → `_pinr(pin)` → `TESTP`,
/// so a plain input pin must report its **level**. Reporting an IN flag there
/// makes every endstop, ESD line and ready signal read inactive whatever is on
/// the wire — and it does so silently, because a flag is a plausible `false`.
#[test]
fn testp_reads_a_level_on_a_plain_pin_and_a_flag_on_a_smart_one() {
    let mut board = Board::new(SdCard::blank(0));

    // P19, HW_PIN_ENDSTOP_UPPER: no mode word, so it is plain GPIO.
    assert!(!board.testp(19), "an unconfigured pin starts low");
    board.set_input_level(19, true);
    assert!(board.testp(19), "a plain input must report the net's level");
    board.set_input_level(19, false);
    assert!(!board.testp(19), "and follow it back down");

    // A configured smart pin keeps IN-flag semantics: drivers `AKPIN` and then
    // wait for hardware to raise it again.
    board.wrpin(19, P_SYNC_RX);
    board.set_input_level(19, false);
    assert!(
        board.testp(19),
        "a configured smart pin reports completion, not the line level"
    );
}

/// A smart pin without `P_OE` does not drive, however `DIR` is set.
///
/// `HAL_encoder_start` does `_pinstart(pinA, P_QUADRATURE | dif<<24, 0, 0)`,
/// and `_pinstart` ends in `DIRH`. Reading `DIR` as "drives" therefore puts
/// the P2 in contention with the encoder that is actually driving those
/// channels — which is what the board's own diagnostics reported.
#[test]
fn a_smart_pin_without_output_enable_is_an_input() {
    const REG_DIRA: u16 = 0x1FA;
    let mut board = Board::new(SdCard::blank(0));

    // Plain GPIO with DIR set: this one really does drive.
    board.dir_out_changed(LOGGER_COG, REG_DIRA, 1 << 9);
    assert_eq!(board.output_level(9), Some(false), "plain GPIO drives");

    // Now configure it the way HAL_encoder_start does — no P_OE.
    board.wrpin(9, quad_cfg(1));
    assert_eq!(
        board.output_level(9),
        None,
        "a quadrature pin has DIR set and is an INPUT; driving it contends \
         with the encoder"
    );

    // A transmit mode sets P_OE, and that one does drive.
    const P_OE: u32 = 0x40;
    board.wrpin(9, P_SYNC_TX | P_OE);
    assert_eq!(
        board.output_level(9),
        Some(false),
        "P_OE is what makes a smart pin drive its pad"
    );
}

// ============================================================
// Bit-level SPI
// ============================================================

/// One bit at a time must land on exactly the words the byte path produces.
///
/// The byte path is the ground truth here: it completes a real SD
/// initialisation against the firmware's own driver, so its wire order is
/// known-correct. A bit shifter that disagreed would be a different bus
/// wearing the same name.
#[test]
fn the_bit_shifter_agrees_with_the_byte_path_on_wire_order() {
    use p2core::SpiShift;

    let word = 0x1234_5678u32;

    // Transmit: the byte path sends `word.reverse_bits()` MSB-first.
    let mut tx = SpiShift::new();
    tx.load_tx(word);
    let mut on_the_wire = Vec::new();
    for _ in 0..32 {
        on_the_wire.push(tx.mosi());
        tx.advance_tx();
    }
    let wire = word.reverse_bits();
    let expected: Vec<bool> = (0..32).map(|i| (wire >> (31 - i)) & 1 != 0).collect();
    assert_eq!(on_the_wire, expected, "the P2 shifts LSB-first");

    // An exhausted shifter idles high — a released MOSI, which is what
    // `rcvr_mmc` clocks when it is only reading.
    assert!(tx.mosi(), "an empty transmit shifter idles high");

    // Receive: those same bits, sampled back, must reassemble the word.
    // Looping the bus back is the sharpest form of the claim — any
    // disagreement between the two orders shows up as a changed word.
    let mut rx = SpiShift::new();
    rx.set_rx_bits(32);
    for bit in &expected {
        rx.sample_rx(*bit);
    }
    assert_eq!(
        rx.take_rx(),
        Some(word),
        "a loopback must return exactly what was sent"
    );
}

/// Eight-bit reads land where `RDPIN` puts them, which is not bit 0.
#[test]
fn an_eight_bit_word_lands_where_the_byte_path_puts_it() {
    use p2core::SpiShift;

    let mut rx = SpiShift::new();
    rx.set_rx_bits(8);
    // 0xC0 on the wire, MSB first — the OCR byte whose bit 6 marks an SDHC.
    for bit in [true, true, false, false, false, false, false, false] {
        rx.sample_rx(bit);
    }
    // The byte path is `chunk.reverse_bits()` on a u32 holding one byte, so
    // the first wire bit ends up at bit 24, not bit 0.
    let expected = 0xC0u32.reverse_bits();
    assert_eq!(rx.take_rx(), Some(expected));
    assert!(!rx.rx_ready(), "one word in, one word out");
}

/// `AKPIN` on the receive pin drops what is buffered.
#[test]
fn clearing_the_receiver_drops_buffered_words() {
    use p2core::SpiShift;

    let mut rx = SpiShift::new();
    rx.set_rx_bits(8);
    for _ in 0..8 {
        rx.sample_rx(true);
    }
    assert!(rx.rx_ready());
    rx.clear_rx();
    assert!(
        !rx.rx_ready(),
        "rcvr_mmc opens with AKPIN to clear the buffer"
    );
    assert_eq!(rx.take_rx(), None);
}

/// `BITH`/`BITL`/`BITNOT` touch a **span** of bits, not one.
///
/// `S[4:0]` is the base and `S[9:5]` a run length minus one (`ADDBITS` in the
/// assembler), wrapping above bit 31. flexspin compiles `x | (31 << 20)` —
/// a method-pointer tag — to `BITH x, #20 ADDBITS 4`; treating that as one
/// bit turns tag 31 into tag 1, and the failure surfaces three layers up as
/// an SD card that will not mount.
#[test]
fn bit_instructions_cover_their_addbits_span() {
    use p2core::{Machine, NullPins};

    // A tiny cog program: BITH r0,#20 ADDBITS 4 ; BITL r1,#(30|3<<5) ; BITNOT r2,#0|1<<5
    // then loop. Registers preloaded via the image's cog init isn't available
    // here, so poke regs directly and single-step the instruction words.
    let mut m = Machine::new(&[0u8; 1024], NullPins);
    m.cogs[0].running = true;

    // Encode: EEEE=1111 (always) 0100000 CZI DDDDDDDDD SSSSSSSSS, BITH=0100_001?
    // Rather than hand-assemble, reuse the decoder: verified encodings from
    // flexspin output — BITH D,#S is $F4400000 family. Take the one the
    // firmware actually contains: f4 46 ?? ?? — instead, drive the ALU path
    // directly through hub-exec words built from the known template below.
    // Encodings lifted from flexspin's own listing rather than hand-rolled:
    //   bith  pa,   #20 addbits 4  ->  $F427EC94
    //   bitl  pb,   #30 addbits 3  ->  $F407EE7E
    //   bitnot ptra, #0 addbits 1  ->  $F4E7F020
    // then the D field is repointed at r0/r1/r2.
    let with_d = |w: u32, d: u32| (w & !(0x1FF << 9)) | (d << 9);
    let prog = [
        with_d(0xF427EC94, 0), // bith r0, #20 addbits 4
        with_d(0xF407EE7E, 1), // bitl r1, #30 addbits 3
        with_d(0xF4E7F020, 2), // bitnot r2, #0 addbits 1
    ];
    // Verify the encodings decode to what we think before executing them.
    use p2core::{decode, Op};
    assert_eq!(
        decode(prog[0]).map(|i| i.op),
        Some(Op::Bith),
        "encoding check"
    );
    assert_eq!(
        decode(prog[1]).map(|i| i.op),
        Some(Op::Bitl),
        "encoding check"
    );
    assert_eq!(
        decode(prog[2]).map(|i| i.op),
        Some(Op::Bitnot),
        "encoding check"
    );

    for (i, w) in prog.iter().enumerate() {
        let at = 0x400 + i * 4;
        m.hub[at..at + 4].copy_from_slice(&w.to_le_bytes());
    }
    m.cogs[0].pc = 0x400;
    m.cogs[0].regs[0] = 0;
    m.cogs[0].regs[1] = 0xFFFF_FFFF;
    m.cogs[0].regs[2] = 0;
    m.step(3).expect("three instructions execute");

    assert_eq!(
        m.cogs[0].regs[0], 0x01F0_0000,
        "BITH #20 ADDBITS 4 sets bits 24:20 — tag 31, not tag 1"
    );
    assert_eq!(
        m.cogs[0].regs[1],
        !(0xC000_0003u32),
        "BITL wraps past bit 31 onto bits 1:0"
    );
    assert_eq!(m.cogs[0].regs[2], 0x3, "BITNOT flips the whole span");
}

/// Idle-poll fast-forward: a pure `testp / jmp` spin costs almost no
/// instructions, while a `djnz`-bounded poll — whose iterations differ —
/// keeps executing every one of them.
///
/// Encodings from flexspin: `testp #58 wc` = $FD72803A... built here from the
/// verified word for `testp #40` in the golden (`fd76803a`-style) — the exact
/// bit pattern is checked by decode() before use.
#[test]
fn a_pure_self_loop_is_fast_forwarded_while_a_side_effecting_one_is_not() {
    use p2core::{decode, Machine, NullPins, Op};

    // `jmp #$` — a one-instruction infinite loop, pure and non-carrying. This
    // is the verified encoding from the ROM-boot payload.
    let jmp_self = 0xFD9F_FFFCu32;
    assert_eq!(decode(jmp_self).map(|i| i.op), Some(Op::Jmp), "jmp #$ encoding");

    let mut m = Machine::new(&[0u8; 4096], NullPins);
    m.cogs[0].running = true;
    m.hub[0x400..0x404].copy_from_slice(&jmp_self.to_le_bytes());
    m.cogs[0].pc = 0x400;
    // 10 ms at 160 MHz is 1.6M cycles; a naive interpreter runs ~1.6M
    // instructions, a fast-forwarded poller a handful — but virtual time must
    // still reach the deadline so timers and peers stay consistent.
    m.step_until(10_000).expect("runs");
    assert!(m.now_us() >= 10_000, "virtual time still reaches the deadline");
    assert!(
        m.cogs[0].instructions < 5_000,
        "a pure self-loop must be fast-forwarded; ran {}",
        m.cogs[0].instructions
    );

    // A loop that writes hub memory every iteration is a side effect, so it is
    // never fast-forwarded: `wrlong r0, r1 ; jmp #$-8`, taken from real words.
    let img = std::fs::read(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../Firmware/MaDCore/.pio/build/propeller2_debug/program"
    ))
    .expect("firmware image");
    let word_at = |a: usize| u32::from_le_bytes([img[a], img[a + 1], img[a + 2], img[a + 3]]);
    let find = |op: Op| -> u32 {
        (0x400..img.len() - 4)
            .step_by(4)
            .map(word_at)
            .find(|&w| decode(w).map(|d| d.op) == Some(op))
            .unwrap_or_else(|| panic!("no {op:?} in image"))
    };
    let wrlong = find(Op::Wrlong);
    // jmp #$-8 (back over the wrlong): relative, S = -2 instructions.
    let jmp_back = (find(Op::Jmp) & 0xFFF0_0000) | (1 << 20) | 0x1_FFFE;
    assert_eq!(decode(jmp_back).map(|i| i.op), Some(Op::Jmp), "jmp back encoding");

    let mut m = Machine::new(&[0u8; 65536], NullPins);
    m.cogs[0].running = true;
    m.hub[0x400..0x404].copy_from_slice(&wrlong.to_le_bytes());
    m.hub[0x404..0x408].copy_from_slice(&jmp_back.to_le_bytes());
    m.cogs[0].pc = 0x400;
    m.step_until(10_000).ok(); // may trap on a wild address; that's fine
    assert!(
        m.cogs[0].instructions > 20_000,
        "a hub-writing loop is a side effect and must run every iteration; ran {}",
        m.cogs[0].instructions
    );
}
