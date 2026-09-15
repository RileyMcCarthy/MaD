//! Boot the real Parallax ROM from a flash image, and show the result.
//!
//! ```text
//! make bootrom                                  # build the ROM + stage-1
//! cargo run --release -p p2core --example romboot
//! ```
//!
//! Nothing is preloaded but the 16 KB boot ROM. It samples the flash strap on
//! P61, bit-bangs the SPI flash, loads and verifies stage-1, and launches it;
//! stage-1 streams a payload from flash `$400` and runs it. The payload writes
//! `B` to the debug console — so that byte appearing is the whole chain.
use p2core::{Board, Machine, SdCard};

const PROP: u32 = u32::from_le_bytes(*b"Prop");

fn boot_flash(stage1: &[u8], program: &[u8]) -> Vec<u8> {
    let mut img = vec![0u8; 0x404 + program.len()];
    img[..stage1.len().min(0x3FC)].copy_from_slice(&stage1[..stage1.len().min(0x3FC)]);
    img[0x400..0x404].copy_from_slice(&(program.len() as u32).to_le_bytes());
    img[0x404..].copy_from_slice(program);
    let mut sum = 0u32;
    for i in (0..0x400).step_by(4) {
        sum = sum.wrapping_add(u32::from_le_bytes(img[i..i + 4].try_into().unwrap()));
    }
    img[0x3FC..0x400].copy_from_slice(&PROP.wrapping_sub(sum).to_le_bytes());
    img
}

fn main() {
    let dir = concat!(env!("CARGO_MANIFEST_DIR"), "/../p2iss/rom/");
    let rom = std::fs::read(format!("{dir}rom_booter_v33k.bin")).expect("run `make bootrom`");
    let stage1 = std::fs::read(format!("{dir}stage1.bin")).expect("run `make bootrom`");
    // mov pa,#"B" / wypin pa,#62 / jmp #$
    let payload: Vec<u8> = [0xF607EC42u32, 0xFC27EC3E, 0xFD9FFFFC]
        .iter()
        .flat_map(|w| w.to_le_bytes())
        .collect();

    let board = Board::new(SdCard::blank(0)).with_flash(boot_flash(&stage1, &payload));
    let mut m = Machine::with_boot_rom(&rom, board);
    m.pins.set_input_level(61, true); // flash-boot strap

    m.step(4_000_000).ok();

    println!(
        "flash reads : {:?}   (ROM loads stage-1 @0, stage-1 loads app @1024)",
        m.pins.flash.reads
    );
    println!("console     : {:?}", m.pins.console());
    println!(
        "verdict     : {}",
        if m.pins.console().contains('B') {
            "BOOTED — ROM -> flash -> stage-1 -> program"
        } else {
            "did not boot"
        }
    );
}
