//! What would bit-level SPI actually cost?
//!
//! The SD card is the last peripheral still living inside [`p2core::Board`],
//! exchanging whole bytes when the guest clocks the bus. Moving it onto a net
//! as a component means every clock edge becomes an engine event. This counts
//! the bytes a real boot clocks, so that decision is made against a number
//! rather than an intuition.

use p2core::{Board, Machine, SdCard};

fn main() {
    let image = std::fs::read(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../Firmware/MaDCore/.pio/build/propeller2_debug/program"
    ))
    .expect("image; run `make p2image`");

    let card = SdCard::blank(32 * 1024 * 1024);
    let mut machine = Machine::new(&image, Board::new(card));
    let boot_us: u64 = std::env::args()
        .nth(1)
        .and_then(|s| s.parse().ok())
        .unwrap_or(3_000_000);
    let _ = machine.step_until(boot_us);

    let counts = machine.pins.byte_counts;
    let spi: u64 = [58u8, 59, 60, 61].iter().map(|p| counts[*p as usize]).sum();
    // SPI moves one bit per clock, and a clock is two transitions. Add the
    // data line's own transitions: worst case one per bit.
    let clock_edges = spi * 8 * 2;
    let data_edges = spi * 8;
    println!("guest time simulated : {:.3} s", boot_us as f64 / 1e6);
    println!(
        "SD commands issued   : {}",
        machine.pins.card.commands.len()
    );
    for pin in [58u8, 59, 60, 61] {
        println!("  P{pin} bytes          : {}", counts[pin as usize]);
    }
    println!("total SPI bytes      : {spi}");
    println!("clock transitions    : {clock_edges}");
    println!("worst-case data edges: {data_edges}");
    println!("engine events (sum)  : {}", clock_edges + data_edges);
}
