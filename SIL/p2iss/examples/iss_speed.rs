//! How fast does the ISS run, relative to the wall clock?
//!
//! Decisive for e2e: the app's protocol timeout is 2 s of *real* time, so a
//! guest that runs at a fraction of real time times out no matter how correct
//! it is.
use std::time::{Duration, Instant};

use embsim_board::{Harness, System};
use embsim_core::virtual_clock;
use p2iss::{P2Iss, SerialLink};

const PROTO: SerialLink = SerialLink {
    tx_pin: 55,
    rx_pin: 53,
    nominal_baud: 2_000_000,
};

fn main() {
    let image = std::fs::read(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../Firmware/MaDCore/.pio/build/propeller2_debug/program"
    ))
    .expect("image");
    virtual_clock::init(1.0, 160_000_000);
    let level_pins: Vec<u8> = std::env::args().nth(1).map_or_else(Vec::new, |_| {
        vec![5, 6, 7, 9, 10, 11, 16, 17, 18, 19, 20, 21, 22, 28]
    });
    let iss = P2Iss::new(&image, p2core::SdCard::blank(32 * 1024 * 1024), &[PROTO])
        .with_level_pins(&level_pins);
    println!("level pins: {level_pins:?}");
    let h = iss.handle();
    let _sys = System::new()
        .component("P2", Box::new(iss))
        .harness(Harness::new())
        .start()
        .expect("starts");

    let start = Instant::now();
    let mut last = (0u64, 0u128);
    for _ in 0..8 {
        std::thread::sleep(Duration::from_secs(1));
        let guest_us = h.guest_now_us();
        let wall_ms = start.elapsed().as_millis();
        let d_guest = guest_us.saturating_sub(last.0);
        let d_wall = wall_ms - last.1;
        println!(
            "wall {:>5} ms | guest {:>9} us | {:.4}x real time | {} cogs",
            wall_ms,
            guest_us,
            d_guest as f64 / (d_wall as f64 * 1000.0),
            h.running_cogs()
        );
        last = (guest_us, wall_ms);
    }
}
