//! Chrome-free smoke: boot `mad-emulator` and complete one protocol round-trip
//! on its host PTY.
//!
//! This is the layer between `cargo test` of the models crate and the Control
//! Playwright suite. It catches "firmware linked but never answers" without a
//! browser, a bridge, or `/tmp/tty.rpi`.
//!
//! Unique PTY/SD paths so this can run next to other cargo tests. Do not point
//! it at the playground symlink.

#![cfg(unix)]

use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

const SYNC: u8 = 0x55;
const TYPE_READ: u8 = 0x00;
const TYPE_DATA: u8 = 0x02;
const CMD_FIRMWARE_VERSION: u8 = 3;
/// Aligned `FirmwareVersion.version` is a 16-byte string (MaDProtocol.yaml).
const FIRMWARE_VERSION_LEN: u16 = 16;

struct Emulator {
    child: Child,
    logs: Arc<Mutex<String>>,
    pty: PathBuf,
    sd: PathBuf,
}

impl Drop for Emulator {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = fs::remove_file(&self.pty);
        let _ = fs::remove_dir_all(&self.sd);
    }
}

fn unique(tag: &str) -> PathBuf {
    let pid = std::process::id();
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    std::env::temp_dir().join(format!("mad_pty_{tag}_{pid}_{nanos}"))
}

fn drain_pipe<R: Read + Send + 'static>(pipe: R, sink: Arc<Mutex<String>>) {
    thread::spawn(move || {
        let mut pipe = pipe;
        let mut buf = [0u8; 512];
        loop {
            match pipe.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => sink
                    .lock()
                    .unwrap()
                    .push_str(&String::from_utf8_lossy(&buf[..n])),
                Err(_) => break,
            }
        }
    });
}

fn firmware_lib() -> PathBuf {
    // CLI default is relative to SIL/ (makefile playground). cargo test runs
    // with cwd = MaDSim/, so we pin the archive from this crate's manifest.
    let p = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../Firmware/MaDCore/.pio/build/native_emulator/libfirmware.a");
    if !p.is_file() {
        panic!(
            "libfirmware.a missing at {}\nBuild it first:\n  cd Firmware/MaDCore && pio run -e native_emulator",
            p.display()
        );
    }
    p
}

fn spawn_emulator() -> Emulator {
    let pty = unique("tty");
    let sd = unique("sd");
    fs::create_dir_all(&sd).expect("create temp SD dir");
    let firmware = firmware_lib();

    let exe = env!("CARGO_BIN_EXE_mad-emulator");
    let mut child = Command::new(exe)
        .args([
            "--speed",
            "0",
            "--pty-path",
            pty.to_str().expect("pty utf8"),
            "--sd-path",
            sd.to_str().expect("sd utf8"),
            "--firmware-lib",
            firmware.to_str().expect("firmware utf8"),
            "--log-level",
            "info",
            "--trace-port",
            "0",
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap_or_else(|e| panic!("spawn mad-emulator ({exe}): {e}"));

    let logs = Arc::new(Mutex::new(String::new()));
    if let Some(out) = child.stdout.take() {
        drain_pipe(out, Arc::clone(&logs));
    }
    if let Some(err) = child.stderr.take() {
        drain_pipe(err, Arc::clone(&logs));
    }

    Emulator {
        child,
        logs,
        pty,
        sd,
    }
}

fn logs_of(emu: &Emulator) -> String {
    emu.logs.lock().unwrap().clone()
}

fn wait_for_pty(emu: &mut Emulator, timeout: Duration) {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if let Ok(Some(status)) = emu.child.try_wait() {
            panic!(
                "mad-emulator exited {} before the PTY appeared at {}\n{}",
                status,
                emu.pty.display(),
                logs_of(emu)
            );
        }
        if emu.pty.exists() {
            return;
        }
        thread::sleep(Duration::from_millis(50));
    }
    panic!(
        "PTY {} did not appear within {:?}\n{}",
        emu.pty.display(),
        timeout,
        logs_of(emu)
    );
}

fn open_slave(path: &Path) -> File {
    OpenOptions::new()
        .read(true)
        .write(true)
        .open(path)
        .unwrap_or_else(|e| panic!("open PTY slave {}: {e}", path.display()))
}

fn find_firmware_version_data(buf: &[u8]) -> bool {
    // DATA firmware_version: 0x55 0x02 0x03 len_lo len_hi payload crc
    let need = 5 + FIRMWARE_VERSION_LEN as usize + 1;
    if buf.len() < need {
        return false;
    }
    buf.windows(5).any(|w| {
        w[0] == SYNC
            && w[1] == TYPE_DATA
            && w[2] == CMD_FIRMWARE_VERSION
            && u16::from_le_bytes([w[3], w[4]]) == FIRMWARE_VERSION_LEN
    })
}

#[test]
fn firmware_answers_firmware_version_on_the_host_pty() {
    let mut emu = spawn_emulator();
    wait_for_pty(&mut emu, Duration::from_secs(30));

    // The symlink can exist a beat before the slave is openable.
    let mut slave = None;
    let open_deadline = Instant::now() + Duration::from_secs(5);
    while Instant::now() < open_deadline {
        if let Ok(f) = OpenOptions::new().read(true).write(true).open(&emu.pty) {
            slave = Some(f);
            break;
        }
        thread::sleep(Duration::from_millis(20));
    }
    let mut slave = slave.unwrap_or_else(|| open_slave(&emu.pty));

    let read_frame = [SYNC, TYPE_READ, CMD_FIRMWARE_VERSION];
    let deadline = Instant::now() + Duration::from_secs(45);
    let mut acc = Vec::new();
    let mut buf = [0u8; 256];
    let mut last_tx = Instant::now() - Duration::from_secs(1);

    while Instant::now() < deadline {
        if let Ok(Some(status)) = emu.child.try_wait() {
            panic!(
                "mad-emulator exited {status} during the round-trip\n{}",
                logs_of(&emu)
            );
        }
        if last_tx.elapsed() >= Duration::from_millis(200) {
            if let Err(e) = slave.write_all(&read_frame) {
                // The slave can return EIO until the master is fully up.
                if e.kind() != std::io::ErrorKind::BrokenPipe {
                    let _ = slave.write_all(&read_frame);
                }
            } else {
                let _ = slave.flush();
            }
            last_tx = Instant::now();
        }
        match slave.read(&mut buf) {
            Ok(n) if n > 0 => {
                acc.extend_from_slice(&buf[..n]);
                if find_firmware_version_data(&acc) {
                    return;
                }
            }
            Ok(_) | Err(_) => thread::sleep(Duration::from_millis(10)),
        }
    }

    panic!(
        "no firmware_version DATA frame on {} after {:?}\n\
         captured {} bytes (first 64): {:02x?}\n{}",
        emu.pty.display(),
        Duration::from_secs(45),
        acc.len(),
        &acc[..acc.len().min(64)],
        logs_of(&emu)
    );
}
