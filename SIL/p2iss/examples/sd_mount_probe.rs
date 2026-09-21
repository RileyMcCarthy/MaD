//! Where does the firmware's own FatFs give up on the card?
//!
//! The image is a valid FAT16 volume — `sdimage`'s tests walk its directory
//! tree and cluster chains, and `fsck_msdos` reads it clean — yet
//! `mount(SD_CARD_MOUNT_PATH, _vfs_open_sdcard())` returns non-zero. That
//! narrows it to the path between the card model and FatFs, and the cheapest
//! way to see it is the sequence of blocks FatFs actually asks for.

use p2core::{Board, Machine, SdCard};

fn main() {
    let image = std::fs::read(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../Firmware/MaDCore/.pio/build/propeller2_debug/program"
    ))
    .expect("image; run `make p2image`");

    let card_bytes = p2iss::sdimage::mad_card(32 * 1024 * 1024, None).expect("card builds");
    println!("boot sector: {:02x?}", &card_bytes[..16]);
    println!(
        "  fs type   : {:?}",
        String::from_utf8_lossy(&card_bytes[54..62])
    );
    println!(
        "  signature : {:02x} {:02x}",
        card_bytes[510], card_bytes[511]
    );

    let mut card = SdCard::with_image(card_bytes);
    card.trace = Some(Vec::new());
    let mut machine = Machine::new(&image, Board::new(card));
    let _ = machine.step_until(3_000_000);

    let card = &machine.pins.card;
    println!("\ncommands : {:?}", card.commands);
    println!("reads    : {:?}", card.reads);
    println!("writes   : {:?}", card.writes);
    println!("initialised: {}", card.initialised);
    if let Some(trace) = machine.pins.card.trace.as_ref() {
        println!("\nexchanges: {}", trace.len());
        println!("last 48 (mosi -> miso):");
        for (i, (mo, mi)) in trace.iter().rev().take(48).rev().enumerate() {
            print!("{mo:02x}->{mi:02x} ");
            if i % 12 == 11 {
                println!();
            }
        }
        println!();
    }
    let console = machine.pins.console();
    for line in console
        .lines()
        .filter(|l| l.to_lowercase().contains("sd") || l.contains("mount"))
    {
        println!("guest: {}", line.trim());
    }
}
