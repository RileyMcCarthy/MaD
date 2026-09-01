//! The whole SIL path on the ISS: a host opens a PTY, and the firmware answers.
//!
//! `protocol_on_levels.rs` proves the wire. This proves the *product*: the
//! surface `mad-emulator` exposes — a PTY at `/tmp/tty.…` that host software
//! opens and speaks the MaD protocol over — served by `p2core` executing the
//! real flexcc image, with every byte crossing a net as edges.
//!
//! The native backend hands the PTY master straight to a peripheral serial
//! channel, so the bytes never touch a net. Here the same descriptor sits
//! behind a `SerialLevelBridge` at the rate the firmware programmed.
//!
//! Skipped when the firmware artifact is absent.

use std::io::{Read, Write};
use std::os::fd::AsRawFd;
use std::path::PathBuf;
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, Instant};

use rstest::rstest;

use embsim_board::{Harness, System};
use embsim_core::virtual_clock;
use p2iss::{HostPty, P2Iss, SerialLink};

/// The MaD protocol link: RX on P53, TX on P55, 2,000,000 baud.
const PROTO: SerialLink = SerialLink {
    tx_pin: 55,
    rx_pin: 53,
    nominal_baud: 2_000_000,
};

/// [SYNC, READ, READ_FIRMWARE_VERSION] — the generated runtime's request.
const REQUEST: [u8; 3] = [0x55, 0x00, 0x03];
/// The reply's header: SYNC, a data frame, the command it answers.
const REPLY_HEADER: [u8; 3] = [0x55, 0x02, 0x03];

/// The virtual clock is process-global; these tests take it one at a time.
static CLOCK_LOCK: Mutex<()> = Mutex::new(());

fn lock_clock() -> MutexGuard<'static, ()> {
    CLOCK_LOCK.lock().unwrap_or_else(|poisoned| {
        CLOCK_LOCK.clear_poison();
        poisoned.into_inner()
    })
}

fn image_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../Firmware/MaDCore/.pio/build/propeller2_debug/program")
}

fn firmware_image() -> Option<Vec<u8>> {
    std::fs::read(image_path()).ok()
}

/// Open the PTY the way host software does, non-blocking so a quiet link does
/// not wedge the test.
fn open_host_end(path: &str) -> std::fs::File {
    let file = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(path)
        .expect("the emulator's PTY symlink must be openable");
    // SAFETY: `file` owns the descriptor for the duration of this call.
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

/// The emulator's own surface: open the PTY, ask for the firmware version,
/// read the answer.
#[rstest]
fn a_host_on_the_pty_gets_an_answer_from_the_iss() {
    let Some(image) = firmware_image() else {
        eprintln!(
            "\n*** SKIPPED: {} needs the P2 image at\n***   {}\n*** Build it with `make p2image` (or `cd ../Firmware/MaDCore && pio run -e propeller2_debug`).\n*** This test asserted NOTHING.\n",
            module_path!(),
            image_path().display()
        );
        return;
    };
    let _g = lock_clock();
    virtual_clock::init(0.0, 160_000_000);

    // A test-local symlink, so a running playground emulator is untouched.
    let pty_path = std::env::temp_dir().join("tty.p2iss-test");
    let pty_path = pty_path.to_str().expect("temp path is utf-8");

    let iss = P2Iss::new(&image, p2core::SdCard::blank(32 * 1024 * 1024), &[PROTO]);
    let iss_handle = iss.handle();
    let host = HostPty::open(pty_path, PROTO.nominal_baud).expect("the PTY opens");
    assert_eq!(host.symlink_path(), pty_path);

    let system = System::new()
        .component("P2", Box::new(iss))
        // The cable, as the bench has it: the P2's transmit reaches the host's
        // receive, and the host's transmit reaches the P2's receive.
        .component("HOST", Box::new(host))
        .harness(
            Harness::new()
                .connect_str("P2.P55", "HOST.RX")
                .expect("endpoints parse")
                .connect_str("HOST.TX", "P2.P53")
                .expect("endpoints parse"),
        )
        .start()
        .expect("the ISS emulator starts");

    let mut link = open_host_end(pty_path);

    // Let the firmware boot far enough to have configured and used its
    // transmit pin — the derived baud is the signal that it did.
    let start = Instant::now();
    while iss_handle.derived_baud(PROTO.tx_pin).is_none() {
        assert!(
            start.elapsed() < Duration::from_secs(60),
            "the firmware must configure its transmit pin (clkfreq {}, {} cogs)",
            iss_handle.clkfreq(),
            iss_handle.running_cogs()
        );
        std::thread::sleep(Duration::from_millis(5));
    }

    link.write_all(&REQUEST).expect("the host can write");
    link.flush().expect("the host can flush");

    // Read until the reply header appears, exactly as a host driver would.
    let mut seen: Vec<u8> = Vec::new();
    let mut buf = [0u8; 256];
    let start = Instant::now();
    let found = loop {
        match link.read(&mut buf) {
            Ok(0) => {}
            Ok(n) => seen.extend_from_slice(&buf[..n]),
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {}
            Err(e) => panic!("reading the PTY failed: {e}"),
        }
        if seen.windows(REPLY_HEADER.len()).any(|w| w == REPLY_HEADER) {
            break true;
        }
        if start.elapsed() > Duration::from_secs(60) {
            break false;
        }
        std::thread::sleep(Duration::from_millis(2));
    };

    assert!(
        found,
        "the firmware's reply must reach the host through the PTY; got {seen:02X?} \
         (clkfreq {}, {} cogs, {:?} baud, {:?} bytes)",
        iss_handle.clkfreq(),
        iss_handle.running_cogs(),
        iss_handle.derived_baud(PROTO.tx_pin),
        iss_handle.byte_counts()
    );

    let (tx, rx) = iss_handle.byte_counts();
    println!(
        "[iss-pty] {} guest us; {tx} bytes framed out, {rx} deframed in, \
         {} reached the host at {} baud",
        iss_handle.guest_now_us(),
        seen.len(),
        iss_handle.derived_baud(PROTO.tx_pin).unwrap_or(0),
    );

    system.shutdown();
}
