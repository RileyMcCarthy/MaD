//! SD bring-up probe: what the guest asks the card for, and what comes back.
//!
//! Run with `cargo run -p p2iss --example sd_probe`. Needs the P2 image.
use embsim_board::{Harness, System};
use embsim_core::virtual_clock;
use p2iss::{sdimage, P2Iss, SerialLink};
use std::time::{Duration, Instant};

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
    let img = sdimage::mad_card(32 * 1024 * 1024, None).expect("builds");
    let sector0: Vec<u8> = img[0..512].to_vec();

    virtual_clock::init(0.0, 160_000_000);
    let iss = P2Iss::new(&image, p2core::SdCard::with_image(img), &[PROTO]);
    let h = iss.handle();
    h.trace_sd();
    let _sys = System::new()
        .component("P2", Box::new(iss))
        .harness(Harness::new())
        .start()
        .expect("starts");

    let start = Instant::now();
    while start.elapsed() < Duration::from_secs(20) {
        if h.console().contains("failed to mount") || h.console().contains("NVRAM") {
            break;
        }
        std::thread::sleep(Duration::from_millis(5));
    }

    println!("=== SD commands issued: {:?}", h.sd_commands());
    let tr = h.sd_trace();
    println!("=== trace length: {}", tr.len());
    // Find the 0xFE data token and compare the 512 bytes after it.
    if let Some(i) = tr.iter().position(|&(_, miso)| miso == 0xFE) {
        let got: Vec<u8> = tr[i + 1..].iter().take(512).map(|&(_, m)| m).collect();
        println!("=== card emitted after token: {} bytes", got.len());
        if got.len() == 512 && got == sector0 {
            println!("=== card served sector 0 CORRECTLY -> fault is guest-side reassembly");
        } else {
            println!(
                "=== MISMATCH  expect {:02X?}",
                &sector0[..16.min(sector0.len())]
            );
            println!("===           got    {:02X?}", &got[..16.min(got.len())]);
        }
        // What the host was clocking out while receiving.
        let mosi: Vec<u8> = tr[i + 1..].iter().take(8).map(|&(m, _)| m).collect();
        println!("=== host MOSI during receive: {mosi:02X?}");
    } else {
        println!("=== no 0xFE data token in the trace -- the guest never got a block");
    }
    println!("=== full trace (mosi -> miso):");
    for (i, (m, s)) in tr.iter().enumerate() {
        println!("  {i:3}  {m:02X} -> {s:02X}");
    }
    println!("=== console:\n{}", h.console());
}
