//! The boot ROM's serial window lasts as long in board time as on silicon.
//!
//! The ROM times its window in clocks: 600 receive timeouts of `rc_max / 10`,
//! 1.8e9 clocks, sized so the fastest RCFAST part (30 MHz) still waits a
//! minute. How long that is in board time is the ISS's clock map, and the
//! map is what the app's flasher races: its first `Prop_Chk` has to land
//! inside the window however long the page took to start.
//!
//! The idle is ten seconds, a sixth of the shortest window a part has: the
//! ROM's wait for a byte is an interrupt-armed spin the ISS executes clock by
//! clock, some twelve seconds of host time per second of board time in the
//! dev profile. `p2core/tests/rom_time_base.rs` pins the rate itself.

use std::io::{Read, Write};
use std::os::fd::AsRawFd;
use std::path::PathBuf;
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, Instant};

use embsim_board::{
    AttachError, Component, ComponentNetIo, Harness, PinDecl, System, TheveninDrive,
};
use embsim_core::virtual_clock;
use p2iss::{HostPty, P2Iss, SerialLink};
use vibes_behaviour::{behaviour, expect, Test};

const PROG: SerialLink = SerialLink {
    tx_pin: 62,
    rx_pin: 63,
    nominal_baud: 2_000_000,
};

const CHK: &[u8] = b"> Prop_Chk 0 0 0 0  ";

/// Board time the host stays silent for: seconds, as a page that is slow to
/// start keeps it, and well inside the minute every part's window lasts.
const IDLE_US: u64 = 10_000_000;

static CLOCK_LOCK: Mutex<()> = Mutex::new(());

fn lock_clock() -> MutexGuard<'static, ()> {
    CLOCK_LOCK.lock().unwrap_or_else(|p| {
        CLOCK_LOCK.clear_poison();
        p.into_inner()
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

fn open_host_end(path: &str) -> std::fs::File {
    let file = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(path)
        .expect("the emulator's PTY symlink must be openable");
    unsafe {
        let fd = file.as_raw_fd();
        let flags = libc::fcntl(fd, libc::F_GETFL);
        assert!(flags >= 0, "F_GETFL on the PTY");
        assert!(
            libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) >= 0,
            "F_SETFL O_NONBLOCK on the PTY"
        );
    }
    file
}

/// Pull-up on P59 (spi_di): the ROM's first strap check jumps to serial.
struct Pull {
    pins: [PinDecl; 1],
}

impl Pull {
    fn new(volts: f64) -> Self {
        Self {
            pins: [PinDecl::analog_source("A").with_idle(Some(TheveninDrive {
                volts,
                impedance: 15_000.0,
            }))],
        }
    }
}

impl Component for Pull {
    fn pins(&self) -> &[PinDecl] {
        &self.pins
    }
    fn attach(&mut self, _io: ComponentNetIo) -> Result<(), AttachError> {
        Ok(())
    }
}

#[test]
fn the_rom_still_answers_prop_chk_after_ten_seconds_of_silence() {
    behaviour!(Test {
        id: "p2.rom-serial-window-board-time",
        covers: Some("SIL/p2core/src/lib.rs#time_map"),
        given: "the mask ROM on the ISS with the serial strap pulled up, and nothing on the programming UART for its first 10 seconds of board time",
    });
    expect!(
        "rcfast",
        "the chip's clock runs at the 20 MHz of its internal fast oscillator while the ROM waits"
    );
    expect!(
        "still-answers",
        "the ROM still answers the flasher's request to identify the chip: its serial window lasts at least a minute, as on silicon"
    );

    let Some(rom_bin) = rom() else {
        eprintln!("\n*** SKIPPED: needs `make bootrom`. Asserted NOTHING.\n");
        return;
    };

    let _g = lock_clock();
    virtual_clock::init(0.0, 20_000_000);

    let pty_path = std::env::temp_dir().join("tty.p2iss-rom-window");
    let pty_path = pty_path.to_str().expect("temp path is utf-8");

    let iss =
        P2Iss::with_boot_rom(&rom_bin, p2core::SdCard::blank(0), &[PROG]).with_level_pins(&[59]);
    let handle = iss.handle();
    let host = HostPty::open(pty_path, PROG.nominal_baud).expect("the PTY opens");

    let system = System::new()
        .component("P2", Box::new(iss))
        .component("HOST", Box::new(host))
        .component("STRAP", Box::new(Pull::new(3.3)))
        .harness(
            Harness::new()
                .connect_str("P2.P62", "HOST.RX")
                .unwrap()
                .connect_str("HOST.TX", "P2.P63")
                .unwrap()
                .connect_str("P2.P59", "STRAP.A")
                .unwrap(),
        )
        .start()
        .expect("the ISS emulator starts");

    // Silence on the wire until the board has run most of a minute. The ROM
    // shutting down first stops its cog, and guest time with it.
    let start = Instant::now();
    loop {
        let now_us = handle.guest_now_us();
        if now_us >= IDLE_US {
            break;
        }
        assert!(
            handle.running_cogs() > 0,
            "the ROM shut its serial window {now_us} us into the board's time, \
             before the host had said anything"
        );
        assert!(
            start.elapsed() < Duration::from_secs(600),
            "the board reached only {now_us} us of its {IDLE_US} us idle in 10 minutes"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
    eprintln!(
        "idled {} us of board time in {:.1} s",
        handle.guest_now_us(),
        start.elapsed().as_secs_f64()
    );
    assert_eq!(
        handle.clock_hz(),
        Some(u64::from(p2core::RCFAST_HZ)),
        "the ROM runs on RCFAST"
    );

    let mut link = open_host_end(pty_path);
    for &b in CHK {
        link.write_all(&[b]).expect("the host can write");
        link.flush().expect("the host can flush");
        std::thread::sleep(Duration::from_millis(20));
    }

    let mut seen = Vec::new();
    let mut buf = [0u8; 256];
    let start = Instant::now();
    let found = loop {
        match link.read(&mut buf) {
            Ok(0) => {}
            Ok(n) => seen.extend_from_slice(&buf[..n]),
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {}
            Err(e) => panic!("reading the PTY failed: {e}"),
        }
        if String::from_utf8_lossy(&seen).contains("Prop_Ver G") {
            break true;
        }
        if start.elapsed() > Duration::from_secs(30) {
            break false;
        }
        std::thread::sleep(Duration::from_millis(5));
    };

    assert!(
        found,
        "the ROM must answer Prop_Chk after {IDLE_US} us of silence; got {seen:02X?} ({}) \
         cogs={} guest_us={} baud={:?} bytes={:?}",
        String::from_utf8_lossy(&seen),
        handle.running_cogs(),
        handle.guest_now_us(),
        handle.derived_baud(PROG.tx_pin),
        handle.byte_counts(),
    );
    drop(system);
}
