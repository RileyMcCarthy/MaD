//! The boot ROM answers `Prop_Chk` on the programming UART over real nets.
//!
//! p2core's `rom_serial` test drives `Board::push_rx`. This is the same
//! handshake on the ISS: a host PTY frames bytes onto P63, the ROM autobauds
//! and replies `Prop_Ver G` on P62.

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
///
/// A static pull, so it is the pin's declared idle drive: the board stamps it
/// from build and nothing publishes it at attach.
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
fn the_rom_answers_prop_chk_on_the_programming_uart_over_the_net() {
    behaviour!(Test {
        id: "p2.rom-serial-net-prop-chk",
        covers: Some("SIL/p2iss/src/lib.rs"),
        given: "the mask ROM on the ISS with the serial strap pulled up, a host sending Prop_Chk on the programming UART",
    });
    expect!(
        "prop-ver",
        "the ROM autobauds on '>' and answers Prop_Ver G on the programming UART"
    );

    let Some(rom_bin) = rom() else {
        eprintln!("\n*** SKIPPED: needs `make bootrom`. Asserted NOTHING.\n");
        return;
    };

    let _g = lock_clock();
    virtual_clock::init(0.0, 20_000_000);

    let pty_path = std::env::temp_dir().join("tty.p2iss-rom-serial");
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

    // Let reset_serial arm INT1 and park in get_rx.
    std::thread::sleep(Duration::from_millis(50));

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
        let text = String::from_utf8_lossy(&seen);
        if text.contains("Prop_Ver G") {
            break true;
        }
        if start.elapsed() > Duration::from_secs(30) {
            break false;
        }
        std::thread::sleep(Duration::from_millis(5));
    };

    assert!(
        found,
        "the ROM must answer Prop_Chk over the programming UART; got {seen:02X?} ({}) \
         cogs={} baud={:?} bytes={:?} console={:?}",
        String::from_utf8_lossy(&seen),
        handle.running_cogs(),
        handle.derived_baud(PROG.tx_pin),
        handle.byte_counts(),
        handle.console()
    );
    drop(system);
}
