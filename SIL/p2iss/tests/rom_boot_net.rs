//! The chip boots through the ROM and a flash that is a **net component**.
//!
//! This is the same boot chain as `p2core`'s `rom_boot_chain` test, but the
//! flash is no longer part of the CPU model — it is a first-class component on
//! real nets, sharing four wires the way a P2 Edge does. It works because the
//! ISS yields to the engine at every net-pin edge: the guest drives the clock,
//! the engine resolves and delivers the flash's sense, the flash drives MISO,
//! the engine resolves again, and only then does the guest read back. Each
//! bit-banged clock edge is a discrete event the engine serialises — which is
//! exactly what an external bit-banged device is.

use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, Instant};

use embsim_board::{
    AttachError, Component, ComponentNetIo, Harness, PinDecl, PinKind, System, TheveninDrive,
};
use embsim_core::virtual_clock;
use p2iss::flashnode::FlashNode;
use p2iss::{P2Iss, SerialLink};

const PROTO: SerialLink = SerialLink {
    tx_pin: 55,
    rx_pin: 53,
    nominal_baud: 2_000_000,
};

static CLOCK_LOCK: Mutex<()> = Mutex::new(());

fn lock_clock() -> MutexGuard<'static, ()> {
    CLOCK_LOCK.lock().unwrap_or_else(|p| {
        CLOCK_LOCK.clear_poison();
        p.into_inner()
    })
}

fn rom(name: &str) -> Option<Vec<u8>> {
    std::fs::read(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("rom")
            .join(name),
    )
    .ok()
}

fn wait_for(mut pred: impl FnMut() -> bool, timeout: Duration) -> bool {
    let start = Instant::now();
    while start.elapsed() < timeout {
        if pred() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(2));
    }
    pred()
}

/// The 15 kΩ boot strap on P61 (spi_cs) telling the ROM the flash is the boot
/// source, plus the pull-up the released MISO idles to.
struct Pull {
    pins: [PinDecl; 1],
    volts: f64,
}

impl Pull {
    fn new(volts: f64) -> Self {
        Self {
            pins: [PinDecl {
                number: "A",
                name: None,
                kind: PinKind::Analog,
                stream: None,
                drive_impedance: None,
            }],
            volts,
        }
    }
}

impl Component for Pull {
    fn pins(&self) -> &[PinDecl] {
        &self.pins
    }
    fn attach(&mut self, io: ComponentNetIo) -> Result<(), AttachError> {
        io.pin("A")?.set_drive(Some(TheveninDrive {
            volts: self.volts,
            impedance: 15_000.0,
        }));
        Ok(())
    }
}

#[test]
fn the_rom_boots_from_a_flash_on_the_net() {
    let (Some(rom_bin), Some(stage1)) = (rom("rom_booter_v33k.bin"), rom("stage1.bin")) else {
        eprintln!("\n*** SKIPPED: needs `make bootrom`. Asserted NOTHING.\n");
        return;
    };
    // mov pa,#"B" / wypin pa,#62 / jmp #$
    let payload: Vec<u8> = [0xF607EC42u32, 0xFC27EC3E, 0xFD9FFFFC]
        .iter()
        .flat_map(|w| w.to_le_bytes())
        .collect();
    let flash_image = p2iss::flashimage::boot_flash(&stage1, &payload).expect("flash image");

    let _g = lock_clock();
    virtual_clock::init(0.0, 160_000_000);

    let flash = FlashNode::new(flash_image);
    let counters = flash.counters();
    // The four bus pins are plain GPIO to the ROM: it bit-bangs them. CS/CLK/
    // MOSI are driven (level pins); MISO is an input the flash drives.
    let iss = P2Iss::with_boot_rom(&rom_bin, p2core::SdCard::blank(0), &[PROTO])
        .with_level_pins(&[59, 60, 61])
        .with_input_pins(&[58]);
    let handle = iss.handle();

    // Grab a reads() view before the flash moves into the system.
    let reads = {
        let counters = std::sync::Arc::clone(&counters);
        move || counters.edges.load(Ordering::Relaxed)
    };

    let system = System::new()
        .component("P2", Box::new(iss))
        .component("FLASH", Box::new(flash))
        .component("STRAP", Box::new(Pull::new(3.3)))
        .harness(
            Harness::new()
                // Flash pin map: CLK=P60, CS=P61 — the microSD's assignment
                // with those two exchanged, as the P2 Edge wires it.
                .connect_str("P2.P60", "FLASH.CLK")
                .unwrap()
                .connect_str("P2.P61", "FLASH.CS")
                .unwrap()
                .connect_str("P2.P59", "FLASH.MOSI")
                .unwrap()
                .connect_str("P2.P58", "FLASH.MISO")
                .unwrap()
                // Strap on P61, pull-up on the released MISO (P58).
                .connect_str("P2.P61", "STRAP.A")
                .unwrap(),
        )
        .start()
        .expect("system starts");

    assert!(
        wait_for(|| reads() > 100, Duration::from_secs(30)),
        "the flash must see real clock edges over the net; it saw {}",
        reads()
    );
    assert!(
        wait_for(|| handle.console().contains('B'), Duration::from_secs(120)),
        "the booted payload must reach the console; console={:?}",
        handle.console()
    );
    drop(system);
}
