//! The firmware mounts the card in the P2-EC32MB's own socket, booted off
//! the module's own flash, on the ISS inside the module's P2 package.
//!
//! The module of `ec32mb_flash_boot.rs` (the vendor netlist, every part a
//! node, powered from its `J203` fingers, `S301` set to boot from flash),
//! with a card in `J301`: the FAT16 card `make sd-image` writes
//! (`p2iss::sdimage::mad_card`), behind embsim's SD card model. The card
//! shares `P58`–`P61` with the flash, crossed: `P61` is the card's clock and,
//! through `S301` position 2, the flash's `/CS`; `P60` is the card's chip
//! select and the flash's clock; `P58` is the flash's DO and, through `R304`
//! (240 Ω), the card's MISO. Every pulse of the card's clock selects the
//! flash, and the flash's own clock does not move.
//!
//! The oracle is the firmware's own FatFs, as in `sd_mount.rs`: flexspin's
//! `_vfs_open_sdcard()` runs the card's SPI initialisation through the
//! smart pins and `mount()` reports what it decided, which the firmware
//! narrates on its debug console. The card's own log says what crossed the
//! wire.
//!
//! Stepped: virtual time advances as the engine processes events, so every
//! assertion is on virtual time and the board's state. Skips, saying why,
//! when the `propeller2_debug` image is absent (`make p2image`);
//! `MAD_REQUIRE_P2_IMAGE` turns the skip into a failure.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use embsim_board::{
    netlist, Board, Component, EndpointRef, Finding, Harness, JumperState, ModelFacade, Scenario,
    System,
};
use embsim_boards::ec32mb::{
    Ec32mb, FLASH_SELECT_POLE, FLASH_SELECT_SWITCH, NETLIST, P59_PULL_DOWN_POLE, SOCKET_PART,
};
use embsim_boards::p2::{P2Package, P2_RESTART_DELAY_NS};
use embsim_core::virtual_clock;
use embsim_models::sd_card::SdCard;
use embsim_models::sd_card_component::{SdCardComponent, SD_CARD_PINS_BY_FUNCTION};
use p2iss::{sdimage, P2IssCore};
use vibes_behaviour::{behaviour, expect, Test};

/// The instant the module's reset releases from its fingers: the AP62301
/// bucks' 2.5 ms soft-start.
const RESET_RELEASE_NS: u64 = 2_500_000;

/// The START instant, the datasheet's restart delay after the release.
const START_NS: u64 = RESET_RELEASE_NS + P2_RESTART_DELAY_NS;

/// Board time the run is given: the 1.25 s boot off the flash, then the
/// firmware reaching its logging core's mount about 0.2 s after that.
const RUN_BUDGET_NS: u64 = 3_000_000_000;

/// Host time without any board time passing that ends the run: the engine
/// or the host stopped, which is no verdict on the board.
const STALL_WALL: Duration = Duration::from_secs(300);

/// The card's capacity: what `make sd-image` writes.
const CARD_BYTES: usize = 32 * 1024 * 1024;

/// The root directory's block on that card: 1 reserved sector, then two
/// 64-sector FATs (`sd_mount.rs`).
const ROOT_DIR_BLOCK: u32 = 129;

fn ep(endpoint: &str) -> EndpointRef {
    EndpointRef::parse(endpoint).expect("endpoint parses")
}

fn rom(name: &str) -> Option<Vec<u8>> {
    std::fs::read(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("rom")
            .join(name),
    )
    .ok()
}

/// The `propeller2_debug` program: `MAD_P2_IMAGE` names a copy kept out of
/// `.pio`, else the build's own.
fn image_path() -> PathBuf {
    let p = std::env::var_os("MAD_P2_IMAGE").map_or_else(
        || {
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("../../Firmware/MaDCore/.pio/build/propeller2_debug/program")
        },
        PathBuf::from,
    );
    if !p.exists() && std::env::var_os("MAD_REQUIRE_P2_IMAGE").is_some() {
        panic!(
            "MAD_REQUIRE_P2_IMAGE is set but the P2 image is missing at {}. \
             Build it with `make p2image` (or `cd Firmware/MaDCore && pio run -e propeller2_debug`).",
            p.display()
        );
    }
    p
}

/// What the logging core's mount said, once it has ended the line.
///
/// The console fills as the guest hands each byte to its transmit pin, a
/// frame time apart, so a look can land mid-line: until the line ends, the
/// result is not all there.
fn logger_mount(console: &str) -> Option<&str> {
    let at = console.find("LOGGER-cog mount result=")?;
    let rest = &console[at..];
    Some(rest[..rest.find('\n')?].trim_end())
}

#[test]
fn the_firmware_mounts_the_card_in_the_modules_socket() {
    behaviour!(Test {
        id: "p2iss.ec32mb-sd-mount",
        covers: Some("SIL/p2iss/src/package.rs#P2IssCore"),
        given: "a P2-EC32MB booting the MaD firmware off its flash, with the instruction-set \
                simulator as its processor and the firmware's FAT16 card in the socket that \
                shares the flash's four pins",
    });
    expect!(
        "boot-mount",
        "the firmware mounts the card at boot to load its machine profile, and goes on to its \
         ready state",
        "the firmware's own filesystem code decides: it initialises the card over the SPI \
         smart pins and accepts the volume"
    );
    expect!(
        "volume-read",
        "the card is read at its boot sector and then at its root directory"
    );
    expect!(
        "logger-mount",
        "the logging core mounts the card for itself, and the mount succeeds"
    );

    let image = match std::fs::read(image_path()) {
        Ok(image) => image,
        Err(_) => {
            eprintln!(
                "\n*** SKIPPED: {} needs the P2 image at\n***   {}\n*** Build it with `make \
                 p2image`.\n*** This test asserted NOTHING.\n",
                module_path!(),
                image_path().display()
            );
            return;
        }
    };
    let (Some(boot_rom), Some(stage1)) = (rom("rom_booter_v33k.bin"), rom("stage1.bin")) else {
        eprintln!("\n*** SKIPPED: needs `make bootrom`. Asserted NOTHING.\n");
        return;
    };
    let flash_image = p2iss::flashimage::boot_flash(&stage1, &image).expect("flash image");
    let card_image = sdimage::mad_card(CARD_BYTES, None).expect("the card image builds");

    virtual_clock::init(0.0, 160_000_000);

    let core = P2IssCore::with_boot_rom(&boot_rom);
    let handle = core.handle();
    let package = P2Package::new(core);
    let package_handle = package.handle();

    // embsim's sd-card model in J301, as `Ec32mb::with_card` puts it there,
    // kept in reach so the test reads what the card was asked.
    let card = SdCardComponent::new(SdCard::with_image(card_image));
    let card_log: Arc<Mutex<SdCard>> = card.card();
    let card_slot = Mutex::new(Some(card));

    let p2_slot = Mutex::new(Some(package));
    let mut registry = Ec32mb::new()
        .with_flash_image(flash_image)
        .with_p2(move |_decl| -> Box<dyn Component> {
            Box::new(p2_slot.lock().unwrap().take().expect("one P2 per module"))
        })
        .registry();
    registry.register_model(
        SOCKET_PART,
        ModelFacade::of("sd-card, pins = \"by-function\"", &SD_CARD_PINS_BY_FUNCTION),
        move |_decl| {
            Box::new(
                card_slot
                    .lock()
                    .unwrap()
                    .take()
                    .expect("one card per socket"),
            )
        },
    );
    let board = Board::from_netlist(
        netlist::parse(NETLIST).expect("the module's netlist parses"),
        &registry,
    )
    .expect("the module builds with a card in its socket");

    let system = System::new()
        .board("EC32", board)
        .harness(
            Harness::new()
                .power(ep("CARRIER.5V"), ep("EC32.J203.41"), 5.0)
                .power(ep("CARRIER.5Vb"), ep("EC32.J203.42"), 5.0)
                .power(ep("CARRIER.GND"), ep("EC32.J203.43"), 0.0)
                .power(ep("CARRIER.GNDb"), ep("EC32.J203.44"), 0.0)
                .power(ep("CARRIER.GNDc"), ep("EC32.J203.45"), 0.0),
        )
        .scenario(
            Scenario::default()
                // S301 position 2 (FLASH): P61 reaches the flash's ~CS.
                .switch(
                    &format!("EC32.{FLASH_SELECT_SWITCH}"),
                    FLASH_SELECT_POLE,
                    JumperState::Closed,
                )
                // S301 position 4: boot what the flash holds.
                .switch(
                    &format!("EC32.{FLASH_SELECT_SWITCH}"),
                    P59_PULL_DOWN_POLE,
                    JumperState::Closed,
                ),
        )
        .start()
        .expect("the system starts");

    // Wait on board time: until the logging core has narrated its mount, or
    // the budget of board time is spent. A watchdog on host time ends a run
    // whose board time has stopped moving.
    let wall = Instant::now();
    let mut last = (virtual_clock::virtual_ns(), Instant::now());
    loop {
        if logger_mount(&handle.console()).is_some() || handle.trap().is_some() || handle.stalled()
        {
            break;
        }
        let board_ns = virtual_clock::virtual_ns();
        if board_ns >= START_NS + RUN_BUDGET_NS {
            break;
        }
        if board_ns != last.0 {
            last = (board_ns, Instant::now());
        } else if last.1.elapsed() > STALL_WALL {
            panic!(
                "no board time passed in {STALL_WALL:?} of host time, at board {board_ns} ns \
                 (guest {} ns): the engine or the host stopped, which says nothing about the \
                 mount",
                handle.guest_now_ns()
            );
        }
        std::thread::sleep(Duration::from_millis(5));
    }
    let console = handle.console();
    let (commands, reads) = {
        let card = card_log.lock().expect("card log");
        (card.commands.clone(), card.reads.clone())
    };
    let report = format!(
        "board {} ns, guest {} ns, start {:?}, trap {:?}, stalled {}, card commands \
         {commands:?}, card reads {:?}, host {:.1} s, console:\n{console}",
        virtual_clock::virtual_ns(),
        handle.guest_now_ns(),
        package_handle.started_at_ns(),
        handle.trap(),
        handle.stalled(),
        &reads[..reads.len().min(32)],
        wall.elapsed().as_secs_f64(),
    );
    eprintln!("ec32mb sd mount: {report}");
    for finding in system.findings() {
        if matches!(finding, Finding::Contention { .. }) {
            eprintln!("ec32mb sd mount: {finding}");
        }
    }

    assert_eq!(handle.started_at_ns(), Some(START_NS), "{report}");

    // The settings loader, on the main core: `dev_nvram`'s boot load mounts
    // the card and moves from BOOT_LOAD (1) to READY (4); a failed mount
    // narrates the failure and moves to ERROR (5).
    assert!(
        !console.contains("failed to mount"),
        "the boot-time mount succeeds; {report}"
    );
    assert!(
        console.contains("dev_nvram_run: 1 -> 4"),
        "the settings loader reaches its ready state; {report}"
    );

    assert!(
        reads.first() == Some(&0) && reads.contains(&ROOT_DIR_BLOCK),
        "a mount has a wire-visible shape: the boot sector, then the root directory at \
         block {ROOT_DIR_BLOCK}; {report}"
    );

    assert_eq!(
        logger_mount(&console),
        Some("LOGGER-cog mount result=0"),
        "the logging core's own mount succeeds; {report}"
    );
    drop(system);
}
