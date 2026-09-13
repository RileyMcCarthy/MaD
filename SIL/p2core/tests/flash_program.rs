//! The real `loadp2` flash stub, executed as machine code on the ISS.
//!
//! Everything about firmware flashing was previously tested against a mock. The
//! app's byte stream is checked against golden `loadp2` captures, and the e2e
//! scenarios drive an in-page JavaScript fake of the boot ROM — so the bytes
//! leaving the browser are known to be right, and what a Propeller would *do*
//! with them had never been executed at all. Nothing had programmed a flash
//! byte.
//!
//! This runs the real thing. It takes the same 496-byte stub the PWA ships,
//! builds the image `buildFlashImage` builds, and boots it the way the ROM does
//! — cog-exec from hub `$0`. What happens next is interpreted P2 instructions.
//!
//! # How far it gets, and why that is the assertion
//!
//! It runs its prologue and stops in `p2core`, twice over:
//!
//! 1. An **undecoded opcode `%1110110`** (`$FEC0__E0`), reached immediately
//!    after the checksum verification succeeds — `$00B` is `if_nz jmp`, so a
//!    *valid* checksum is precisely what falls through onto it. It is not data.
//! 2. Past that, the **streamer** (`SETXFRQ`/`XINIT`/`WAITXFI`), which is how
//!    loadp2 clocks the SPI bus quickly rather than bit-banging it. Stepping
//!    over (1) shows the stub reaching `DRVH`/`DRVL` on the flash pins and then
//!    asking for a streamed transfer, ~2000 times.
//!
//! Getting as far as it does is not nothing: it exercises `SKIP` over the
//! stub's inline header, the hub FIFO (`RDFAST`/`RFLONG`/`GETPTR`), `REP`
//! blocks and the checksum arithmetic, on code this project did not write.
//! Those were the unknowns, and they work. So the test asserts the stub clears
//! its prologue and that what stops it is one of the two known gaps — which
//! pins today's boundary exactly and fails the moment someone moves it.
//!
//! When those land, this test should assert the flash CONTENTS instead: the
//! writable model underneath it (`SpiFlash`, `$06`/`$02`/`$20`/`$D8`/`$9F`) is
//! already in place and unit-tested, and `m.pins.flash.image_bytes()` is
//! waiting. `cargo run -p p2core --example stub_gaps` re-measures the gap in one
//! pass — it steps over each trap and keeps going, so it reports every missing
//! instruction on the executed path rather than just the first.
//!
//! # Still out of scope
//!
//! The *delivery* of the image over the wire. On hardware the app pulses DTR,
//! the mask ROM autobauds on `> Prop_Chk`, and the image arrives as ASCII hex.
//! None of that can run here — p2core leaves `SETSE1`/`SETINT1` inert so the
//! ROM's autobaud ISR never fires, and no reset line reaches the board. The
//! image is therefore placed in hub directly, which is the state the ROM would
//! have left behind. The serial path remains the browser mock's job.

use p2core::{Board, Machine, SdCard, Trap};

/// Where the PWA keeps its vendored copy of loadp2's `flash_loader.bin`.
///
/// Read from there rather than vendored a second time into this crate: one copy
/// means this exercises the bytes the app actually ships, and a loadp2 bump is
/// picked up here without anyone remembering to sync a fixture.
const IMAGE_TS: &str = "../../Software/Control/src/firmware/image.ts";

/// Offsets, in longs, of the two header slots `buildFlashImage` patches.
const CHECKSUM_LONG: usize = 1;
const DEBUG_FLAG_LONG: usize = 2;

fn image_ts_path() -> std::path::PathBuf {
    std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(IMAGE_TS)
}

/// Decode standard base64. Written out rather than pulled in: `p2core` has no
/// dependencies and this is not the place to acquire one.
fn base64_decode(s: &str) -> Vec<u8> {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut rev = [255u8; 256];
    for (i, &c) in TABLE.iter().enumerate() {
        rev[c as usize] = i as u8;
    }
    let (mut out, mut acc, mut bits) = (Vec::new(), 0u32, 0u32);
    for b in s.bytes() {
        if b == b'=' {
            break;
        }
        let v = rev[b as usize];
        if v == 255 {
            continue; // whitespace and quoting
        }
        acc = (acc << 6) | u32::from(v);
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
        }
    }
    out
}

/// Pull `FLASH_LOADER_BASE64` out of the TypeScript source — a run of
/// single-quoted string literals joined by `+`.
fn flash_loader_stub() -> Option<Vec<u8>> {
    let src = std::fs::read_to_string(image_ts_path()).ok()?;
    let start = src.find("const FLASH_LOADER_BASE64")?;
    let tail = &src[start..];
    let decl = &tail[..tail.find(';')?];
    let (mut b64, mut rest) = (String::new(), decl);
    while let Some(open) = rest.find('\'') {
        let after = &rest[open + 1..];
        let close = after.find('\'')?;
        b64.push_str(&after[..close]);
        rest = &after[close + 1..];
    }
    (!b64.is_empty()).then(|| base64_decode(&b64))
}

/// The hub image the boot ROM would leave behind: stub, then payload, with the
/// DEBUG flag cleared and the checksum long set so every long sums to zero.
/// Mirrors `buildFlashImage` in `Software/Control/src/firmware/image.ts`.
fn build_flash_image(stub: &[u8], firmware: &[u8]) -> Vec<u8> {
    let mut img = Vec::with_capacity(stub.len() + firmware.len());
    img.extend_from_slice(stub);
    img.extend_from_slice(firmware);
    while img.len() % 4 != 0 {
        img.push(0);
    }
    let put = |img: &mut Vec<u8>, long: usize, v: u32| {
        img[long * 4..long * 4 + 4].copy_from_slice(&v.to_le_bytes());
    };
    put(&mut img, DEBUG_FLAG_LONG, 0);
    put(&mut img, CHECKSUM_LONG, 0);
    let mut sum = 0u32;
    for i in (0..img.len()).step_by(4) {
        sum = sum.wrapping_add(u32::from_le_bytes(img[i..i + 4].try_into().unwrap()));
    }
    put(&mut img, CHECKSUM_LONG, 0u32.wrapping_sub(sum));
    img
}

/// A payload distinctive enough that finding it in a flash cannot be luck.
fn payload() -> Vec<u8> {
    (0..1024u32)
        .map(|i| (i.wrapping_mul(31).wrapping_add(7) & 0xFF) as u8)
        .collect()
}

#[test]
fn the_real_flash_stub_runs_on_the_iss_up_to_the_two_known_gaps() {
    let Some(stub) = flash_loader_stub() else {
        eprintln!(
            "\n*** SKIPPED: {} needs the PWA's vendored loadp2 stub at\n***   {}\n\
             *** This test asserted NOTHING.\n",
            module_path!(),
            image_ts_path().display()
        );
        return;
    };
    let image = build_flash_image(&stub, &payload());

    // An erased device, as it would be before a write.
    let board = Board::new(SdCard::blank(0)).with_flash(vec![0xFF; 1 << 20]);
    let mut m = Machine::new(&image, board);
    // The one piece of post-download state the stub depends on: the boot ROM's
    // hub FIFO pointer sits just past the image it just loaded, and `GETPTR` /
    // `SHR #2` at $003..$006 is how the stub learns its own payload size.
    // Without it the size reads as zero, the checksum loop runs on the whole
    // 512 KB of hub, and the stub simply never finishes — which looks like a
    // hang rather than a missing precondition.
    m.cogs[0].fifo_addr = image.len() as u32;

    let outcome = m.step(5_000_000);
    let executed = m.cogs[0].instructions;

    // It must clear its prologue — `SKIP` over the header, `GETPTR`/`SHR` to
    // size the payload, `RDFAST`, and a `REP` checksum pass over every long —
    // rather than dying in the first handful of instructions. Several hundred
    // instructions of real loader code, none of which this project wrote.
    assert!(
        executed > 500,
        "the stub must clear its prologue; only {executed} instructions ran, \
         outcome={outcome:?}"
    );

    // And it must stop at one of the two known gaps, nowhere else.
    const UNDECODED_OPCODE: u32 = 0b111_0110;
    match outcome {
        // The streamer, once the opcode below is decoded.
        Err(Trap::Unimplemented {
            mnemonic: "xinit" | "waitxfi" | "setxfrq",
            ..
        }) => {}
        // Opcode %1110110, on the checksum-success path.
        Err(Trap::UndecodedWord { word, .. }) if (word >> 21) & 0x7F == UNDECODED_OPCODE => {}
        other => panic!(
            "the stub now stops somewhere else after {executed} instructions: {other:?}.\n\
             If both known gaps are closed, this test should now assert the FLASH \
             CONTENTS instead — the payload must appear verbatim in \
             m.pins.flash.image_bytes(), which the writable SpiFlash already supports.\n\
             If this is a NEW gap, `cargo run -p p2core --example stub_gaps` lists every \
             missing instruction on the executed path in one pass."
        ),
    }
}

/// `SKIP` is what lets the stub start at all, and its one subtlety is easy to
/// get wrong in a way that shows up as a bogus "bad instruction".
#[test]
fn skip_cancels_a_slot_without_decoding_it() {
    // Encodings taken from the stub itself, not invented: its long 0 is
    // `skip #1` = $FD640231 (op %1101011, L=1, D = the pattern, S = $031), and
    // `mov pa,#imm` = $F607EC42 is the one the ROM boot test already uses.
    const SKIP_2: u32 = 0xFD64_0431; // pattern %10: cancel the second slot
    const MOV_PA_AA: u32 = 0xF607_ECAA;
    const GARBAGE: u32 = 0x0D72_9C53; // decodes as nothing
    const PARK: u32 = 0xFD9F_FFFC; // jmp #$
    /// PA, where `mov pa,#imm` lands.
    const PA: usize = 0x1F6;

    let prog: Vec<u8> = [SKIP_2, MOV_PA_AA, GARBAGE, PARK]
        .iter()
        .flat_map(|w| w.to_le_bytes())
        .collect();

    let mut m = Machine::new(&prog, p2core::NullPins);
    let outcome = m.step(64);

    // The point: a cancelled slot is never decoded on silicon. Decoding first
    // and cancelling afterwards traps on the garbage long — and that is not a
    // hypothetical, it is what happened here. loadp2's stub opens with `SKIP`
    // over its own inline header, whose first long is a CHECKSUM: its value
    // depends on the payload, so it decodes as a different bogus instruction
    // for every image, and the failure reads as a corrupt loader rather than a
    // skipped word.
    assert!(
        outcome.is_ok(),
        "an undecodable word in a cancelled slot must never be decoded: {outcome:?}"
    );
    assert_eq!(
        m.cogs[0].regs[PA], 0xAA,
        "the slot before the cancelled one ran"
    );
}
