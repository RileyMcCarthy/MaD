//! The app's flash load through the boot ROM's serial loader, on the
//! P2-EC32MB as it is built, and what lands in the module's flash.
//!
//! `p2core/tests/flash_program.rs` runs loadp2's flash stub against p2core's
//! own flash, and `mad-catalog/tests/serial_boot.rs` gives the ROM a RAM load
//! over the debug header. Neither writes the module's flash the way the
//! app's flasher does on the machine: the ROM's serial loader taking the stub
//! and the firmware as hex, the stub then programming the module's
//! W25Q128JV through the package's synchronous-serial pads, on the nets
//! (`Software/Control/src/firmware/p2loader.ts`, `image.ts`). This does.
//!
//! The module is powered from its fingers as `ec32mb_flash_boot.rs` powers
//! it, its flash erased, `S301` set for the flash's select (position 2) and
//! the ROM's serial boot (position 3, `P59` pulled up), so the ROM listens on
//! its programming UART from its START instant. A host on the debug fingers
//! (`J203.49`, `P63`, the chip's receive; `J203.50`, `P62`, its transmit), at
//! the flasher's 2 000 000 baud, sends what the flasher sends: the probe,
//! then `Prop_Hex` with the stub and a firmware as 128-byte hex lines and
//! `~`, the end of a flash load. The firmware is a pattern no flash holds by
//! chance; the case reads the flash back.
//!
//! Skips, saying why, without the boot ROM (`make bootrom`) or the app's
//! vendored stub.

use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use embsim_board::uart::UartFraming;
use embsim_board::{
    AttachError, Component, ComponentNetIo, EndpointRef, Harness, HostRailLine, JumperState,
    PinDecl, Scenario, System, HOST_RAIL_PINS,
};
use embsim_boards::ec32mb::{Ec32mb, FLASH_SELECT_POLE, FLASH_SELECT_SWITCH, P59_PULL_UP_POLE};
use embsim_boards::p2::{P2Package, P2_RESTART_DELAY_NS};
use embsim_core::virtual_clock;
use p2iss::P2IssCore;
use vibes_behaviour::{behaviour, expect, Test};

const LOADER_BAUD: u32 = 2_000_000;
const CHK: &[u8] = b"> Prop_Chk 0 0 0 0  ";
const HEX: &[u8] = b"> Prop_Hex 0 0 0 0";
const CHUNK_BYTES: usize = 128;

/// The instant the module's reset releases from its fingers, and the START
/// instant 3 ms on (`ec32mb_flash_boot.rs`).
const RESET_RELEASE_NS: u64 = 2_500_000;
const START_NS: u64 = RESET_RELEASE_NS + P2_RESTART_DELAY_NS;

/// Host time without any board time passing that ends the run.
const STALL_WALL: Duration = Duration::from_secs(300);

fn ep(endpoint: &str) -> EndpointRef {
    EndpointRef::parse(endpoint).expect("endpoint parses")
}

/// One case at a time: the virtual clock is process-global.
static CLOCK_LOCK: Mutex<()> = Mutex::new(());

fn lock_clock() -> MutexGuard<'static, ()> {
    CLOCK_LOCK.lock().unwrap_or_else(|poisoned| {
        CLOCK_LOCK.clear_poison();
        poisoned.into_inner()
    })
}

fn rom() -> Option<Vec<u8>> {
    std::fs::read(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("rom")
            .join("rom_booter_v33k.bin"),
    )
    .ok()
}

/// Where the app keeps its vendored copy of loadp2's flash stub.
fn image_ts_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../Software/Control/src/firmware/image.ts")
}

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
            continue;
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

/// `FLASH_LOADER_BASE64` out of the app's TypeScript.
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

/// `buildFlashImage`: the stub, the firmware, padded to a long, the DEBUG
/// flag (long 2) cleared and the checksum long (long 1) set so every long
/// sums to zero.
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
    put(&mut img, 2, 0);
    put(&mut img, 1, 0);
    let sum = img
        .as_chunks::<4>()
        .0
        .iter()
        .map(|w| u32::from_le_bytes(*w))
        .fold(0u32, u32::wrapping_add);
    put(&mut img, 1, 0u32.wrapping_sub(sum));
    img
}

/// `loadImage` for a flash load: `Prop_Hex`, each 128 bytes as ` xx` hex
/// with ` > ` after it, and `~`.
fn hex_flash_load(image: &[u8]) -> Vec<u8> {
    let mut out = HEX.to_vec();
    for chunk in image.chunks(CHUNK_BYTES) {
        for b in chunk {
            out.extend_from_slice(format!(" {b:02x}").as_bytes());
        }
        out.extend_from_slice(b" > ");
    }
    out.push(b'~');
    out
}

/// A firmware no flash holds by chance.
fn firmware() -> Vec<u8> {
    (0..2048u32)
        .map(|i| (i.wrapping_mul(31).wrapping_add(7) & 0xFF) as u8)
        .collect()
}

/// What the host and the case share: bytes to send, bytes heard.
#[derive(Default)]
struct Line {
    line: Mutex<Option<HostRailLine>>,
    outbox: Mutex<VecDeque<u8>>,
    heard: Mutex<Vec<u8>>,
}

/// The host on the debug fingers: a USB adapter's UART at its own 3.3 V
/// rail, sending what the case queues as fast as the line takes it.
struct Flasher {
    framing: UartFraming,
    shared: Arc<Line>,
    shutdown: Arc<AtomicBool>,
}

impl Component for Flasher {
    fn pins(&self) -> &[PinDecl] {
        &HOST_RAIL_PINS
    }

    fn attach(&mut self, io: ComponentNetIo) -> Result<(), AttachError> {
        let line = HostRailLine::attach(&io, self.framing, Arc::clone(&self.shutdown))?;
        let bridge = Arc::clone(line.bridge());
        *self.shared.line.lock().unwrap() = Some(line);
        {
            let (shared, bridge) = (Arc::clone(&self.shared), Arc::clone(&bridge));
            let rx = io.pin("RX")?;
            io.on_sense("RX", move |sense| {
                for byte in bridge.receive_sense(&rx, &sense).into_iter().flatten() {
                    shared.heard.lock().unwrap().push(byte);
                }
            })?;
        }
        {
            let shared = Arc::clone(&self.shared);
            let arm = io.clone();
            io.on_wake_ns(move |now| {
                for byte in bridge.service(now).into_iter().flatten() {
                    shared.heard.lock().unwrap().push(byte);
                }
                let ready = shared
                    .line
                    .lock()
                    .unwrap()
                    .as_ref()
                    .is_some_and(HostRailLine::rail_known);
                if ready {
                    let mut outbox = shared.outbox.lock().unwrap();
                    let take = bridge.tx_room().min(outbox.len());
                    if take > 0 {
                        let bytes: Vec<u8> = outbox.drain(..take).collect();
                        bridge.transmit(&bytes);
                    }
                }
                // The host's own pump: a USB adapter's microframe.
                arm.schedule_at_ns(now + 125_000);
            });
        }
        io.schedule_at_ns(1_000_000);
        Ok(())
    }
}

impl Drop for Flasher {
    fn drop(&mut self) {
        self.shutdown.store(true, Ordering::Relaxed);
    }
}

/// Wait on board time for `done`, up to `budget_ns` from now; a stall of
/// board time on host time panics.
fn wait_board(budget_ns: u64, mut done: impl FnMut() -> bool) -> bool {
    let deadline = virtual_clock::virtual_ns() + budget_ns;
    let mut last = (virtual_clock::virtual_ns(), Instant::now());
    loop {
        if done() {
            return true;
        }
        let now = virtual_clock::virtual_ns();
        if now >= deadline {
            return false;
        }
        if now != last.0 {
            last = (now, Instant::now());
        } else if last.1.elapsed() > STALL_WALL {
            panic!("no board time passed in {STALL_WALL:?} of host time, at {now} ns");
        }
        std::thread::sleep(Duration::from_millis(5));
    }
}

#[test]
fn the_flashers_load_through_the_roms_serial_loader_programs_the_modules_flash() {
    behaviour!(Test {
        id: "p2iss.ec32mb-serial-flash-load",
        covers: Some("SIL/p2iss/src/package.rs#P2IssCore"),
        given: "a P2-EC32MB module, its flash erased and strapped for the ROM's serial boot, sent \
                what the app's flasher sends: the probe, then the flash programmer and a firmware \
                as hex",
    });
    expect!(
        "rom-answers",
        "the ROM answers the probe with its version, G"
    );
    expect!(
        "stub-programs",
        "the module's flash is write-enabled, erased and programmed page by page"
    );
    expect!(
        "firmware-in-flash",
        "the firmware lands in the module's flash byte for byte",
        "the app reports a written firmware without reading the flash back, so only the flash \
         says whether the write happened"
    );

    let (Some(boot_rom), Some(stub)) = (rom(), flash_loader_stub()) else {
        eprintln!(
            "\n*** SKIPPED: needs `make bootrom` and the app's flash stub ({}). Asserted \
             NOTHING.\n",
            image_ts_path().display()
        );
        return;
    };
    let fw = firmware();
    let load = hex_flash_load(&build_flash_image(&stub, &fw));

    let _clock = lock_clock();
    virtual_clock::init(0.0, 160_000_000);
    let core = P2IssCore::with_boot_rom(&boot_rom);
    let handle = core.handle();
    let package = P2Package::new(core);
    let board = Ec32mb::new().with_flash_image(Vec::new());
    let flash = board.flash_view().expect("the flash has a view");
    let slot = Mutex::new(Some(package));
    let board = board
        .with_p2(move |_decl| -> Box<dyn Component> {
            Box::new(slot.lock().unwrap().take().expect("one P2 per module"))
        })
        .build()
        .expect("the module builds");
    let line = Arc::new(Line::default());
    let system = System::new()
        .board("EC32", board)
        .component(
            "HOST",
            Box::new(Flasher {
                framing: UartFraming::new_8n1(LOADER_BAUD),
                shared: Arc::clone(&line),
                shutdown: Arc::new(AtomicBool::new(false)),
            }),
        )
        .harness(
            Harness::new()
                .connect_str("HOST.TX", "EC32.J203.49")
                .expect("P63's finger")
                .connect_str("EC32.J203.50", "HOST.RX")
                .expect("P62's finger")
                .power(ep("ADAPTER.3V3"), ep("HOST.VIO"), 3.3)
                .connect_str("HOST.GND", "EC32.J203.43")
                .expect("a ground finger")
                .power(ep("CARRIER.5V"), ep("EC32.J203.41"), 5.0)
                .power(ep("CARRIER.5Vb"), ep("EC32.J203.42"), 5.0)
                .power(ep("CARRIER.GND"), ep("EC32.J203.43"), 0.0)
                .power(ep("CARRIER.GNDb"), ep("EC32.J203.44"), 0.0)
                .power(ep("CARRIER.GNDc"), ep("EC32.J203.45"), 0.0),
        )
        .scenario(
            Scenario::default()
                .switch(
                    &format!("EC32.{FLASH_SELECT_SWITCH}"),
                    FLASH_SELECT_POLE,
                    JumperState::Closed,
                )
                .switch(
                    &format!("EC32.{FLASH_SELECT_SWITCH}"),
                    P59_PULL_UP_POLE,
                    JumperState::Closed,
                ),
        )
        .start()
        .expect("the system starts");

    // The ROM has read P59 and waits on P63 well within 50 ms of its start.
    wait_board(START_NS + 50_000_000, || {
        virtual_clock::virtual_ns() >= START_NS + 50_000_000
    });
    line.outbox.lock().unwrap().extend(CHK.iter().copied());
    let answered = wait_board(1_000_000_000, || {
        String::from_utf8_lossy(&line.heard.lock().unwrap()).contains("Prop_Ver")
    });
    let heard = String::from_utf8_lossy(&line.heard.lock().unwrap()).into_owned();
    assert!(
        answered,
        "the ROM answers the probe; heard {heard:?}, trap {:?}",
        handle.trap()
    );
    assert!(heard.contains("Prop_Ver G"), "rom-answers: {heard:?}");

    let sent_at = virtual_clock::virtual_ns();
    line.outbox.lock().unwrap().extend(load.iter().copied());
    // The load is about 3 bytes on the wire for each image byte at 5 us a
    // byte; the stub then erases and programs, and goes quiet.
    let mut quiet_since: Option<(usize, u64)> = None;
    let settled = wait_board(10_000_000_000, || {
        let n = flash.commands().len();
        let now = virtual_clock::virtual_ns();
        let drained = line.outbox.lock().unwrap().is_empty();
        match quiet_since {
            Some((m, at)) if m == n => drained && n > 0 && now - at > 200_000_000,
            _ => {
                quiet_since = Some((n, now));
                false
            }
        }
    });
    let commands = flash.commands();
    let image = flash.image_bytes();
    let head = &fw[..16];
    let at = image.windows(head.len()).position(|w| w == head);
    let report = format!(
        "settled {settled} {} ms after the load began, {} commands (first {:02X?}), \
         payload at {at:?}, trap {:?}, P63 overruns {}, framing errors {}, bytes (tx, rx) \
         {:?}, running cogs {}, load {} bytes, heard {:?}",
        (virtual_clock::virtual_ns() - sent_at) / 1_000_000,
        commands.len(),
        &commands[..commands.len().min(24)],
        handle.trap(),
        handle.rx_overruns(63),
        handle.rx_framing_errors(),
        handle.byte_counts(),
        handle.running_cogs(),
        load.len(),
        String::from_utf8_lossy(&line.heard.lock().unwrap()),
    );
    eprintln!("ec32mb serial flash: {report}");
    let report = format!(
        "{report}; cogs {:X?}",
        handle.cogs().iter().filter(|c| c.1).collect::<Vec<_>>()
    );
    assert!(
        commands.contains(&0x06)
            && commands.contains(&0x02)
            && commands.iter().any(|&c| c == 0x20 || c == 0xD8),
        "stub-programs: {report}"
    );
    let at = at
        .unwrap_or_else(|| panic!("firmware-in-flash: the firmware is not in the flash; {report}"));
    assert_eq!(
        &image[at..at + fw.len()],
        &fw[..],
        "firmware-in-flash: {report}"
    );
    drop(system);
}

/// The production firmware (pio env `P2Eval`): `MAD_P2_PRODUCTION_IMAGE`
/// names a copy kept out of `.pio` (CI's), else the build's own.
fn production_image() -> Option<Vec<u8>> {
    let path = std::env::var_os("MAD_P2_PRODUCTION_IMAGE").map_or_else(
        || {
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("../../Firmware/MaDCore/.pio/build/P2Eval/program")
        },
        PathBuf::from,
    );
    let image = std::fs::read(&path).ok();
    if image.is_none() && std::env::var_os("MAD_REQUIRE_P2_IMAGE").is_some() {
        panic!(
            "MAD_REQUIRE_P2_IMAGE is set but the production image is missing at {}",
            path.display()
        );
    }
    image
}

#[test]
fn the_firmware_the_flasher_writes_boots_from_flash_after_a_dtr_reset() {
    behaviour!(Test {
        id: "p2iss.ec32mb-reflash-boots",
        covers: Some("SIL/p2iss/src/package.rs#P2IssCore::enter_reset"),
        given: "a P2-EC32MB module, its flash erased and P59 unstrapped, sent the production \
                firmware through the ROM's serial loader and then reset by DTR through a Prop \
                Plug's reset stage",
    });
    expect!(
        "written",
        "the firmware lands in the module's flash byte for byte"
    );
    expect!("dtr-resets", "asserting DTR resets the chip once");
    expect!(
        "boots-new-firmware",
        "after the reset the chip boots the firmware from its flash and the firmware prints \
         its first line",
        "with nothing on P59 the ROM listens 100 ms for a host after a reset, then boots the \
         flash, which loadp2's loader reads in through the streamer"
    );

    let (Some(boot_rom), Some(stub), Some(fw)) = (rom(), flash_loader_stub(), production_image())
    else {
        eprintln!(
            "\n*** SKIPPED: needs `make bootrom`, the app's flash stub and the production image \
             (make p2image-production). Asserted NOTHING.\n"
        );
        return;
    };
    let load = hex_flash_load(&build_flash_image(&stub, &fw));

    let _clock = lock_clock();
    virtual_clock::init(0.0, 160_000_000);
    let core = P2IssCore::with_boot_rom(&boot_rom);
    let handle = core.handle();
    let package = P2Package::new(core);
    let package_handle = package.handle();
    let board = Ec32mb::new().with_flash_image(Vec::new());
    let flash = board.flash_view().expect("the flash has a view");
    let slot = Mutex::new(Some(package));
    let board = board
        .with_p2(move |_decl| -> Box<dyn Component> {
            Box::new(slot.lock().unwrap().take().expect("one P2 per module"))
        })
        .build()
        .expect("the module builds");
    let line = Arc::new(Line::default());
    let plug = embsim_models::prop_plug::PropPlugReset::new();
    let pulses = plug.handle();
    let system = System::new()
        .board("EC32", board)
        .component(
            "HOST",
            Box::new(Flasher {
                framing: UartFraming::new_8n1(LOADER_BAUD),
                shared: Arc::clone(&line),
                shutdown: Arc::new(AtomicBool::new(false)),
            }),
        )
        .component("PLUG", Box::new(plug))
        .harness(
            Harness::new()
                .connect_str("HOST.TX", "EC32.J203.49")
                .expect("P63's finger")
                .connect_str("EC32.J203.50", "HOST.RX")
                .expect("P62's finger")
                .connect_str("HOST.DTR", "PLUG.DTR")
                .expect("the plug's input")
                .connect_str("PLUG.RES", "EC32.J203.46")
                .expect("the reset finger")
                .power(ep("ADAPTER.3V3"), ep("HOST.VIO"), 3.3)
                .connect_str("HOST.GND", "EC32.J203.43")
                .expect("a ground finger")
                .connect_str("PLUG.VSS", "EC32.J203.44")
                .expect("a ground finger")
                .power(ep("CARRIER.5V"), ep("EC32.J203.41"), 5.0)
                .power(ep("CARRIER.5Vb"), ep("EC32.J203.42"), 5.0)
                .power(ep("CARRIER.GND"), ep("EC32.J203.43"), 0.0)
                .power(ep("CARRIER.GNDb"), ep("EC32.J203.44"), 0.0)
                .power(ep("CARRIER.GNDc"), ep("EC32.J203.45"), 0.0),
        )
        .scenario(Scenario::default().switch(
            &format!("EC32.{FLASH_SELECT_SWITCH}"),
            FLASH_SELECT_POLE,
            JumperState::Closed,
        ))
        .start()
        .expect("the system starts");

    // The ROM finds no program in the erased flash and listens for a minute.
    wait_board(START_NS + 50_000_000, || {
        virtual_clock::virtual_ns() >= START_NS + 50_000_000
    });
    line.outbox.lock().unwrap().extend(CHK.iter().copied());
    assert!(
        wait_board(1_000_000_000, || {
            String::from_utf8_lossy(&line.heard.lock().unwrap()).contains("Prop_Ver G")
        }),
        "the ROM answers the probe; trap {:?}",
        handle.trap()
    );

    let (load_board, load_host) = (virtual_clock::virtual_ns(), Instant::now());
    // The ROM probed the erased flash at its start; what the stub issues
    // comes after these.
    let probed = flash.commands().len();
    line.outbox.lock().unwrap().extend(load.iter().copied());
    let mut quiet_since: Option<(usize, u64)> = None;
    let mut sent_at = None;
    let settled = wait_board(120_000_000_000, || {
        let n = flash.commands().len();
        let now = virtual_clock::virtual_ns();
        let drained = line.outbox.lock().unwrap().is_empty();
        if drained && sent_at.is_none() {
            sent_at = Some((now, Instant::now()));
        }
        match quiet_since {
            Some((m, at)) if m == n => drained && n > probed && now - at > 500_000_000,
            _ => {
                quiet_since = Some((n, now));
                false
            }
        }
    });
    let written_board = quiet_since.map_or(0, |(_, at)| at);
    let image = flash.image_bytes();
    let at = image.windows(16).position(|w| w == &fw[..16]);
    let (sent_board, sent_host) = sent_at.unwrap_or((written_board, Instant::now()));
    eprintln!(
        "reflash: {} bytes sent in {:.3} s of board time ({:.1} s host); the flash's last \
         command {:.3} s after the load began ({:.1} s host); {} flash commands; firmware at \
         {at:?}; settled {settled}; trap {:?}",
        load.len(),
        (sent_board - load_board) as f64 / 1e9,
        sent_host.duration_since(load_host).as_secs_f64(),
        (written_board.saturating_sub(load_board)) as f64 / 1e9,
        load_host.elapsed().as_secs_f64(),
        flash.commands().len(),
        handle.trap(),
    );
    let at = at.unwrap_or_else(|| panic!("written: the firmware is not in the flash"));
    assert_eq!(&image[at..at + fw.len()], &fw[..], "written");

    // DTR asserted: the plug's chip inverts it, so the stage sees a rise.
    let console_before = handle.console().len();
    let (commands_before, reads_before) = (flash.commands().len(), flash.reads().len());
    let (reset_board, reset_host) = (virtual_clock::virtual_ns(), Instant::now());
    line.line
        .lock()
        .unwrap()
        .as_ref()
        .expect("attached")
        .set_dtr_inverted(true);
    line.line
        .lock()
        .unwrap()
        .as_ref()
        .expect("attached")
        .set_dtr(true);
    let booted = wait_board(30_000_000_000, || {
        handle.console()[console_before..].contains("Starting MaD Board")
    });
    eprintln!(
        "reflash: after the DTR reset the firmware printed its first line {:.3} s of board time \
         later ({:.1} s host); resets {:?}; plug pulses {}; trap {:?}; console after the reset \
         {:?}",
        (virtual_clock::virtual_ns() - reset_board) as f64 / 1e9,
        reset_host.elapsed().as_secs_f64(),
        package_handle.resets(),
        pulses.pulses(),
        handle.trap(),
        handle
            .console()
            .get(console_before..)
            .map(|c| c.chars().take(120).collect::<String>()),
    );
    if !booted {
        let hub = handle.hub_bytes(0, fw.len());
        let first = (0..fw.len()).find(|&i| hub[i] != fw[i]);
        if let Some(i) = first {
            let shifted_left = |k: usize| -> bool {
                (i..(i + 64).min(fw.len() - 1)).all(|j| {
                    let want = ((u16::from(fw[j]) << 8 | u16::from(fw[j + 1])) << k >> 8) as u8;
                    hub[j] == want
                })
            };
            eprintln!(
                "reflash: hub first differs from the firmware at {i} ({i:#X}): hub {:02X?} \
                 firmware {:02X?}; one bit early {}, one bit late {}",
                &hub[i..(i + 8).min(fw.len())],
                &fw[i..(i + 8).min(fw.len())],
                shifted_left(1),
                (i + 1..(i + 64).min(fw.len())).all(|j| {
                    hub[j] == ((u16::from(fw[j - 1]) << 8 | u16::from(fw[j])) >> 1) as u8
                }),
            );
        }
        let commands = flash.commands();
        eprintln!(
            "reflash: after the reset the flash saw commands {:02X?}, reads at {:X?}; cogs {:X?}; \
             stalled {}; clock {:?} Hz; hub $0 {:02X?}, firmware's first bytes {:02X?}",
            &commands
                [commands_before.min(commands.len())..commands.len().min(commands_before + 24)],
            &flash.reads()[reads_before.min(flash.reads().len())..],
            handle.cogs().iter().filter(|c| c.1).collect::<Vec<_>>(),
            handle.stalled(),
            handle.clock_hz(),
            handle.hub_bytes(0, 16),
            &fw[..16],
        );
    }
    assert_eq!(package_handle.resets().len(), 1, "dtr-resets");
    assert!(booted, "boots-new-firmware");
    drop(system);
}
