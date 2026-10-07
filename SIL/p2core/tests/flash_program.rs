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
//! # What it asserts
//!
//! The stub runs to completion as machine code: `SKIP` over the header, the
//! hub FIFO checksum pass, `LOC PTRA` onto the loader settings, then the
//! streamer (`SETXFRQ`/`XINIT`/`WAITXFI`) clocked by a transition smart pin
//! on the flash CLK. The writable `SpiFlash` underneath (`$06`/`$02`/`$20`/
//! `$D8`) is the one the ROM already boots from. The test asserts the
//! payload appears in that flash — the same bytes the PWA assembled.
//!
//! `cargo run -p p2core --example stub_gaps` still lists every missing
//! instruction on the executed path, if a new gap appears.
//!
//! # Still out of scope
//!
//! The *delivery* of the image over the wire. On hardware the app pulses DTR,
//! the mask ROM autobauds on `> Prop_Chk`, and the image arrives as ASCII hex.
//! That handshake lives in `rom_serial.rs`. This file is the stub running as
//! machine code against a writable flash: the image is placed in hub the way
//! the ROM leaves a finished hex download.

use p2core::{Board, Machine, SdCard};
use vibes_behaviour::{behaviour, expect, Test};

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
fn loc_ptra_writes_the_absolute_hub_address() {
    behaviour!(Test {
        id: "p2.loc-ptra-absolute",
        covers: Some("SIL/p2core/src/lib.rs#execute"),
        given: "a LOC PTRA instruction with an absolute hub address",
    });
    expect!("ptra-loaded", "PTRA holds that hub address");

    // EEEE=F, WW=10 (PTRA), R=0 (absolute), A=$12345 → $FEC12345.
    const LOC_PTRA: u32 = 0xFEC1_2345;
    const PARK: u32 = 0xFD9F_FFFC;
    const PTRA: usize = 0x1F8;

    let prog: Vec<u8> = [LOC_PTRA, PARK]
        .iter()
        .flat_map(|w| w.to_le_bytes())
        .collect();
    let mut m = Machine::new(&prog, p2core::NullPins);
    m.step(8).ok();
    assert_eq!(
        m.cogs[0].regs[PTRA], 0x1_2345,
        "LOC PTRA,#\\$12345 must land the 20-bit address in PTRA"
    );
}

#[test]
fn the_real_flash_stub_programs_the_payload_into_spi_flash() {
    behaviour!(Test {
        id: "p2.flash-stub-programs-spi",
        covers: Some("SIL/p2core/tests/flash_program.rs"),
        given: "the app's flash stub and a firmware image sitting in hub RAM the way the boot ROM leaves a finished download",
    });
    expect!(
        "write-enable",
        "the stub issues a write-enable to the SPI flash"
    );
    expect!("erase", "the stub erases a flash sector before programming");
    expect!(
        "page-program",
        "the stub programs pages of the firmware into flash"
    );
    expect!(
        "payload-at-loader-offset",
        "the firmware bytes land at the flash offset the boot loader reads after its own first kilobyte"
    );

    let Some(stub) = flash_loader_stub() else {
        eprintln!(
            "\n*** SKIPPED: {} needs the PWA's vendored loadp2 stub at\n***   {}\n\
             *** This test asserted NOTHING.\n",
            module_path!(),
            image_ts_path().display()
        );
        return;
    };
    let fw = payload();
    let image = build_flash_image(&stub, &fw);

    // An erased device, as it would be before a write.
    let board = Board::new(SdCard::blank(0)).with_flash(vec![0xFF; 1 << 20]);
    let mut m = Machine::new(&image, board);
    // The one piece of post-download state the stub depends on: the boot ROM's
    // hub FIFO pointer sits just past the image it just loaded, and `GETPTR` /
    // `SHR #2` at $003..$006 is how the stub learns its own payload size.
    m.cogs[0].fifo_addr = image.len() as u32;

    let outcome = m.step(8_000_000);
    // COGINIT at the end of the stub replaces cog 0, so per-cog instruction
    // counts reset; the machine's retired count is the one that survives.
    assert!(
        m.retired > 500,
        "the stub must clear its prologue; only {} instructions ran, \
         outcome={outcome:?}",
        m.retired
    );

    let commands = &m.pins.flash.commands;
    assert!(
        commands.iter().any(|&c| c == 0x06),
        "the stub must issue write-enable ($06); commands={commands:?} outcome={outcome:?}"
    );
    assert!(
        commands.iter().any(|&c| c == 0x02),
        "the stub must issue page-program ($02); commands={commands:?} outcome={outcome:?}"
    );
    assert!(
        commands.iter().any(|&c| c == 0xD8 || c == 0x20),
        "the stub must erase before programming ($D8/$20); commands={commands:?} outcome={outcome:?}"
    );

    let flash = m.pins.flash.image_bytes();
    let head = &fw[..8];
    let at = flash.windows(head.len()).position(|w| w == head);
    // loadp2 writes flash from the in-stub loader at hub $160 (352); the
    // PWA payload follows the 496-byte stub, so it lands at flash 144.
    assert_eq!(
        at,
        Some(144),
        "the payload must land where the ROM's stage-1 / loadp2 loader \
         will read it; writes={:?} erases={:?} commands={commands:?} outcome={outcome:?}",
        m.pins.flash.writes,
        m.pins.flash.erases
    );
}

/// `mov pa,#"B"` / `wypin pa,#62` / `jmp #$` — encodings from flexspin's listing,
/// the same three longs `rom_boot_chain` uses.
fn console_b_payload() -> Vec<u8> {
    [0xF607EC42u32, 0xFC27EC3E, 0xFD9FFFFC]
        .iter()
        .flat_map(|w| w.to_le_bytes())
        .collect()
}

fn run_stub_on(firmware: &[u8]) -> Option<Machine<Board>> {
    let stub = flash_loader_stub()?;
    let image = build_flash_image(&stub, firmware);
    let board = Board::new(SdCard::blank(0)).with_flash(vec![0xFF; 1 << 20]);
    let mut m = Machine::new(&image, board);
    m.cogs[0].fifo_addr = image.len() as u32;
    let _ = m.step(8_000_000);
    Some(m)
}

#[test]
fn the_rom_boots_the_image_the_stub_programmed() {
    behaviour!(Test {
        id: "p2.rom-boots-stub-programmed-flash",
        covers: Some("SIL/p2core/tests/flash_program.rs"),
        given: "SPI flash that the app's flash stub has just programmed, and a reset into the mask ROM with the flash boot strap pulled up",
    });
    expect!(
        "payload-runs",
        "the programmed payload runs and writes to the debug console"
    );

    let (Some(rom), Some(programmed)) = (
        {
            let p = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("../p2iss/rom/rom_booter_v33k.bin");
            std::fs::read(p).ok()
        },
        run_stub_on(&console_b_payload()),
    ) else {
        eprintln!(
            "\n*** SKIPPED: needs the loadp2 stub and p2iss/rom/rom_booter_v33k.bin.\n\
             *** This test asserted NOTHING.\n"
        );
        return;
    };

    let flash = programmed.pins.flash.image_bytes();
    let board = Board::new(SdCard::blank(0)).with_flash(flash);
    let mut m = Machine::with_boot_rom(&rom, board);
    m.pins.set_input_level(61, true);
    let _ = m.step(8_000_000);
    let console = String::from_utf8_lossy(&m.pins.console);
    assert!(
        console.contains('B'),
        "the ROM must load the stub's flash image and run the payload; console={console:?} \
         flash reads={:?}",
        m.pins.flash.reads
    );
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
