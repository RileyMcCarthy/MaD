//! The chip boots the way silicon does — through the ROM and the flash.
//!
//! Nothing is preloaded into hub RAM but the 16 KB boot ROM (Parallax's own
//! `ROM_Booter_v33k`, assembled by flexspin). Everything else arrives from the
//! flash: the ROM samples the pull-up strap on P61, bit-bangs the SPI flash,
//! loads its first kilobyte, verifies the 256 longs sum to `"Prop"`, copies
//! them into cog RAM and jumps. That kilobyte is this repository's stage-1
//! loader, which reads the application from flash `$400` and relaunches the cog
//! on it — the same entry convention the ROM just used on stage-1.
//!
//! The observable is what the *booted program* does: a three-instruction
//! payload that writes `B` to the debug console. If that byte appears, every
//! hop of the chain ran real machine code.
//!
//! The flash lives on [`p2core::Board`], not on a net, and the reason is
//! precise: the ROM bit-bangs the bus with `drvh`/`drvl`/`testp` and samples a
//! floated pin microseconds after driving the clock — faster than a net
//! resolves between engine wakes. Smart-pin-clocked buses (the SD card, the
//! serial links) do go on nets; a CPU-bit-banged one cannot, and the boot ROM
//! is the only bit-banged bus in the machine.

use p2core::{Board, Machine, SdCard};

/// `"Prop"`, the checksum the ROM demands of a bootable first kilobyte.
const PROP: u32 = u32::from_le_bytes(*b"Prop");

/// Assemble a flash image: stage-1 in the first KB balanced to `"Prop"`, then
/// the application length and image at `$400`. Mirrors
/// `p2iss::flashimage::boot_flash`, duplicated to keep `p2core` dependency-free.
fn boot_flash(stage1: &[u8], program: &[u8]) -> Vec<u8> {
    assert!(
        stage1.len() <= 0x3FC,
        "stage-1 must leave the fix-up long free"
    );
    let mut img = vec![0u8; 0x404 + program.len()];
    img[..stage1.len()].copy_from_slice(stage1);
    img[0x400..0x404].copy_from_slice(&(program.len() as u32).to_le_bytes());
    img[0x404..].copy_from_slice(program);
    let mut sum = 0u32;
    for i in (0..0x400).step_by(4) {
        sum = sum.wrapping_add(u32::from_le_bytes(img[i..i + 4].try_into().unwrap()));
    }
    img[0x3FC..0x400].copy_from_slice(&PROP.wrapping_sub(sum).to_le_bytes());
    img
}

fn rom_artifact(name: &str) -> Option<Vec<u8>> {
    let p = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../p2iss/rom")
        .join(name);
    std::fs::read(p).ok()
}

#[test]
fn the_rom_boots_a_program_from_flash() {
    let (Some(rom), Some(stage1)) = (
        rom_artifact("rom_booter_v33k.bin"),
        rom_artifact("stage1.bin"),
    ) else {
        eprintln!(
            "\n*** SKIPPED: needs p2iss/rom/rom_booter_v33k.bin and stage1.bin.\n\
             *** Build them with `make bootrom`. This test asserted NOTHING.\n"
        );
        return;
    };

    // mov pa,#"B" / wypin pa,#62 / jmp #$ — encodings from flexspin's listing.
    let payload: Vec<u8> = [0xF607EC42u32, 0xFC27EC3E, 0xFD9FFFFC]
        .iter()
        .flat_map(|w| w.to_le_bytes())
        .collect();
    let flash = boot_flash(&stage1, &payload);

    let board = Board::new(SdCard::blank(0)).with_flash(flash);
    let mut m = Machine::with_boot_rom(&rom, board);
    // The flash-boot strap: a pull-up on P61 (spi_cs) tells the ROM the flash
    // is the boot source.
    m.pins.set_input_level(61, true);

    // 4M instructions is ample: the whole chain settles in well under 1M.
    m.step(4_000_000).ok();

    assert!(
        m.pins.console().contains('B'),
        "the booted payload must reach the console; console={:?}, flash reads={:?}",
        m.pins.console(),
        m.pins.flash.reads
    );
    assert_eq!(
        m.pins.flash.reads,
        vec![0, 1024],
        "the boot reads flash twice: the ROM loads stage-1 from 0, stage-1 \
         loads the application from $400"
    );
}
