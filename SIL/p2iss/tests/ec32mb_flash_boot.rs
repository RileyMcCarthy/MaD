//! The firmware boots off the P2-EC32MB's own flash, on the ISS inside the
//! module's P2 package, and says so on its debug pin.
//!
//! The chain `rom_boot_net.rs` proves on four bare nets, on the module as it
//! is built: the vendor netlist, every part a node, powered the way a
//! carrier powers it — 5 V and 0 V on its `J203` fingers, nothing stuck.
//! `U100` is [`P2IssCore`] inside [`P2Package`]: the package holds it until
//! the module's reset has released and the datasheet's 3 ms restart delay
//! has run out, and hands it all 64 pads. Nothing in the core names a pin:
//! the boot ROM bit-bangs the flash on `P58`–`P61`, which `S301` position 2
//! (FLASH) joins to the flash's select; position 4 pulls `P59` down, which
//! the ROM reads as "boot what the flash holds". The flash holds stage-1
//! and the `propeller2_debug` program, laid out as `make flash-image` will
//! (`p2iss::flashimage::boot_flash`). Stage-1 streams the program into hub
//! and reloads cog `$000`–`$0FF` from it. On silicon its `jmp #0` at `$019`,
//! already fetched, then runs the program's first long; the ISS executes the
//! reloaded `$019` instead, the program's own long there, and the firmware
//! starts all the same because its longs 4 to 255 are zero, a run of
//! instructions that do nothing (`package_pads.rs` says more). The firmware
//! sets its clock from the module's 20 MHz TCXO through the PLL, configures
//! `P62` as an asynchronous transmitter at 230 400 baud, and prints its first
//! line.
//!
//! What is read is what a terminal on the module's debug finger (`J203`
//! pin 50, `P62/PRG_DBG_TXD`) would read at 230 400 baud: the line comes off
//! the wire, not out of the guest's memory.
//!
//! Stepped: virtual time advances as the engine processes events, so every
//! assertion is on virtual time and the board's state. Skips, saying why,
//! when the `propeller2_debug` image is absent (`make p2image`), as the other
//! suites that run the firmware do; `MAD_REQUIRE_P2_IMAGE` turns the skip
//! into a failure.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use embsim_board::uart::{UartDecoder, UartFraming};
use embsim_board::{
    jesd8c01_lvcmos_thresholds, AttachError, Component, ComponentNetIo, DeadBand, DigitalReceiver,
    EndpointRef, Harness, JumperState, PinDecl, Scenario, System,
};
use embsim_boards::ec32mb::{Ec32mb, FLASH_SELECT_POLE, FLASH_SELECT_SWITCH, P59_PULL_DOWN_POLE};
use embsim_boards::p2::{P2Package, P2_RESTART_DELAY_NS};
use embsim_core::virtual_clock;
use p2iss::P2IssCore;
use vibes_behaviour::{behaviour, expect, Test};

/// The instant the module's reset releases from its fingers: the AP62301
/// bucks' 2.5 ms soft-start (`embsim_models::rail::AP62301_SOFT_START_NS`),
/// when the core rail and the detector's `RESN` come up together.
const RESET_RELEASE_NS: u64 = 2_500_000;

/// The START instant: the datasheet's restart delay after the reset
/// releases ("Propeller restarts 3 ms after RESn transitions from low to
/// high", P2X8C4M64P Datasheet, Pin Descriptions, p. 6).
const START_NS: u64 = RESET_RELEASE_NS + P2_RESTART_DELAY_NS;

/// The firmware's debug console rate: flexspin's `printf` on `P62`, the
/// `propeller2` environment's `monitor_speed`.
const CONSOLE_BAUD: u32 = 230_400;

/// The module's TCXO, `X100` (Epson TG2520SMN 20.0000M).
const TCXO_HZ: u64 = 20_000_000;

/// The firmware's system clock: flexspin's `_clkfreq`, the PLL's
/// multiple of the crystal.
const FIRMWARE_CLOCK_HZ: u64 = 160_000_000;

/// Board time the boot is given: stage-1 bit-bangs about 4 µs a byte on
/// the 20 MHz RC oscillator, so the 317 KB program is about 1.4 s of it.
const BOOT_BUDGET_NS: u64 = 5_000_000_000;

/// Host time without any board time passing that ends the run: the engine
/// or the host stopped, which is no verdict on the board, and the test
/// fails saying so. Board time is the engine's, which moves from the start,
/// before the package starts the core.
const STALL_WALL: Duration = Duration::from_secs(300);

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
/// `.pio` (the ledger job's, where building another environment can clear
/// `.pio/build`), else the build's own.
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

/// What a terminal on the debug finger read: each byte and its instant.
type Heard = Arc<Mutex<Vec<(u64, u8)>>>;

/// A terminal on one line: a UART receiver at a fixed rate, reading through
/// the JESD8C.01 LVCMOS pair a USB serial adapter's input stands for. It
/// listens from the first time the line reads its idle mark, high: before
/// the module's rails are up the line sits at 0 V, which is no frame.
struct Terminal {
    pins: [PinDecl; 1],
    baud: u32,
    heard: Heard,
}

impl Terminal {
    fn new(baud: u32) -> (Self, Heard) {
        let heard = Heard::default();
        (
            Self {
                pins: [PinDecl::digital_in(
                    "RX",
                    jesd8c01_lvcmos_thresholds(DeadBand::Unknown),
                )],
                baud,
                heard: Arc::clone(&heard),
            },
            heard,
        )
    }
}

impl Component for Terminal {
    fn pins(&self) -> &[PinDecl] {
        &self.pins
    }

    fn attach(&mut self, io: ComponentNetIo) -> Result<(), AttachError> {
        let framing = UartFraming::new_8n1(self.baud);
        let decoder = Arc::new(Mutex::new(UartDecoder::new(framing)));
        let marked = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let take = {
            let heard = Arc::clone(&self.heard);
            move |rx: &mut UartDecoder, now: u64| {
                while let Some(frame) = rx.poll(now) {
                    if let Ok(byte) = frame {
                        heard.lock().unwrap().push((now, byte));
                    }
                }
            }
        };
        {
            let decoder = Arc::clone(&decoder);
            let take = take.clone();
            let arm = io.clone();
            let receiver = DigitalReceiver::new(io.pin("RX")?);
            io.on_sense("RX", move |sense| {
                use std::sync::atomic::Ordering;
                let mut rx = decoder.lock().unwrap();
                let level = receiver.read(&sense);
                if !marked.load(Ordering::Relaxed) {
                    if level != Some(embsim_board::Level::High) {
                        return;
                    }
                    marked.store(true, Ordering::Relaxed);
                    *rx = UartDecoder::new(framing);
                }
                if let Some(level) = level {
                    rx.on_level(level, sense.at_ns);
                }
                take(&mut rx, sense.at_ns);
                if let Some(at) = rx.frame_deadline_ns() {
                    arm.schedule_at_ns(at);
                }
            })?;
        }
        io.on_wake_ns(move |now| take(&mut decoder.lock().unwrap(), now));
        Ok(())
    }
}

/// The first line the terminal read, without its line ending, once one has
/// ended.
fn first_line(heard: &Heard) -> Option<String> {
    let bytes: Vec<u8> = heard.lock().unwrap().iter().map(|(_, b)| *b).collect();
    let text = String::from_utf8_lossy(&bytes).into_owned();
    let end = text.find('\n')?;
    Some(text[..end].trim_end_matches('\r').to_string())
}

#[test]
fn the_firmware_boots_off_the_modules_flash_and_prints_its_first_line() {
    behaviour!(Test {
        id: "p2iss.ec32mb-flash-boot",
        covers: Some("SIL/p2iss/src/package.rs#P2IssCore"),
        given: "a P2-EC32MB module powered from its edge fingers, its flash holding the stage-1 \
                loader and the MaD firmware, its option switch set to boot from flash, and the \
                instruction-set simulator as its processor",
    });
    expect!(
        "starts-after-restart-delay",
        "the chip starts running 3 ms after the module's reset releases, at 5.5 ms"
    );
    expect!(
        "boot-reads",
        "the boot reads the flash at address 0 for the loader, then at 1 KB for the firmware"
    );
    expect!(
        "first-line-on-finger",
        "a terminal at 230 400 baud on the module's debug-transmit finger reads the firmware's \
         first line, \"Starting MaD Board\""
    );
    expect!(
        "clock-from-crystal",
        "the firmware runs at 160 MHz, the PLL's multiple of the module's 20 MHz crystal"
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

    virtual_clock::init(0.0, 160_000_000);

    let core = P2IssCore::with_boot_rom(&boot_rom);
    let handle = core.handle();
    let package = P2Package::new(core);
    let package_handle = package.handle();

    let board = Ec32mb::new().with_flash_image(flash_image);
    let flash = board.flash_view().expect("a programmed flash has a view");
    let slot = Mutex::new(Some(package));
    let board = board
        .with_p2(move |_decl| -> Box<dyn Component> {
            Box::new(slot.lock().unwrap().take().expect("one P2 per module"))
        })
        .build()
        .expect("the module builds");

    let (terminal, heard) = Terminal::new(CONSOLE_BAUD);
    let system = System::new()
        .board("EC32", board)
        .component("TERM", Box::new(terminal))
        .harness(
            Harness::new()
                // P62/PRG_DBG_TXD, the module's debug-transmit finger.
                .connect_str("EC32.J203.50", "TERM.RX")
                .expect("the debug finger exists")
                // 5 V into the two `5V` fingers, 0 V into the three `GND`
                // fingers (`p2_ec32mb.net`: 41/42 and 43/44/45). Everything
                // else is the module's own power tree.
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
                // S301 position 4: R303 pulls P59 down, so the ROM boots
                // what it loaded instead of waiting for a serial loader.
                .switch(
                    &format!("EC32.{FLASH_SELECT_SWITCH}"),
                    P59_PULL_DOWN_POLE,
                    JumperState::Closed,
                ),
        )
        .start()
        .expect("the system starts");

    // Wait on board time, not host time: until the line has ended or the
    // budget of board time is spent. A watchdog on host time ends a run
    // whose board time has stopped moving.
    let wall = Instant::now();
    let mut last = (virtual_clock::virtual_ns(), Instant::now());
    loop {
        if first_line(&heard).is_some() || handle.trap().is_some() || handle.stalled() {
            break;
        }
        let board_ns = virtual_clock::virtual_ns();
        if board_ns >= START_NS + BOOT_BUDGET_NS {
            break;
        }
        if board_ns != last.0 {
            last = (board_ns, Instant::now());
        } else if last.1.elapsed() > STALL_WALL {
            panic!(
                "no board time passed in {STALL_WALL:?} of host time, at board {board_ns} ns \
                 (guest {} ns, console tap {:?}): the engine or the host stopped, which says \
                 nothing about the boot",
                handle.guest_now_ns(),
                handle.console()
            );
        }
        std::thread::sleep(Duration::from_millis(5));
    }
    let wall = wall.elapsed();
    let console = handle.console();
    let reads = flash.reads();
    let first_byte_ns = heard.lock().unwrap().first().map(|(at, _)| *at);
    let line_ns = heard
        .lock()
        .unwrap()
        .iter()
        .find(|(_, b)| *b == b'\n')
        .map(|(at, _)| *at);
    let report = format!(
        "board {} ns, line ended at {line_ns:?} ns, first byte at {first_byte_ns:?} ns, \
         start {:?}, clock {:?} Hz, crystal {:?} Hz, P62 at {:?} baud, trap {:?}, stalled {}, \
         reads {reads:?}, net yields {}, console tap {console:?}, host {:.1} s",
        handle.guest_now_ns(),
        package_handle.start_state(),
        handle.clock_hz(),
        handle.crystal_hz(),
        handle.derived_baud(62),
        handle.trap(),
        handle.stalled(),
        handle.net_yields(),
        wall.as_secs_f64(),
    );
    eprintln!("ec32mb flash boot: {report}");

    assert_eq!(START_NS, 5_500_000);
    assert_eq!(
        package_handle.started_at_ns(),
        Some(START_NS),
        "the package starts the core 3 ms after the module's reset releases; {report}"
    );
    assert_eq!(handle.started_at_ns(), Some(START_NS), "{report}");

    assert!(
        reads.starts_with(&[0, 0x400]),
        "the ROM reads stage-1 at 0, stage-1 the program at $400; {report}"
    );

    assert_eq!(
        first_line(&heard).as_deref(),
        Some("Starting MaD Board"),
        "the terminal on J203.50 reads the firmware's first line; {report}"
    );
    assert!(
        first_byte_ns.is_some_and(|at| at > START_NS),
        "the line is the running firmware's; {report}"
    );

    assert_eq!(
        handle.crystal_hz(),
        Some(TCXO_HZ),
        "the module's TCXO reaches XI; {report}"
    );
    assert_eq!(
        handle.clock_hz(),
        Some(FIRMWARE_CLOCK_HZ),
        "the clock word's PLL multiplies the crystal; {report}"
    );
    drop(system);
}
