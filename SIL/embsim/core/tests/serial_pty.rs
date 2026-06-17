//! Integration tests for `embsim_core::serial_pty::Pty` (unix).
//!
//! Each test uses a UNIQUE temp symlink path under `std::env::temp_dir()` so
//! the suite can run with parallel threads without paths colliding. No global
//! lock is needed because `Pty` owns its own fds and a private symlink.

#![cfg(unix)]

use embsim_core::serial_pty::Pty;
use nix::fcntl::{open, OFlag};
use nix::sys::stat::Mode;
use nix::unistd::{close, read, write};
use std::os::fd::AsRawFd;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

/// Process-wide counter giving every temp path a distinct suffix even when two
/// tests construct a path in the same microsecond on the same thread.
static SEQ: AtomicU64 = AtomicU64::new(0);

/// Build a unique, non-existent symlink path under the OS temp dir.
fn unique_path(tag: &str) -> PathBuf {
    let n = SEQ.fetch_add(1, Ordering::Relaxed);
    let pid = std::process::id();
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    std::env::temp_dir().join(format!("embsim_pty_{tag}_{pid}_{nanos}_{n}"))
}

/// Read up to `buf.len()` bytes from a fd, polling briefly so a slow PTY hand-off
/// does not race the read but nothing ever blocks indefinitely.
fn read_bounded(fd: i32, buf: &mut [u8]) -> usize {
    for _ in 0..200 {
        match read(fd, buf) {
            Ok(n) if n > 0 => return n,
            Ok(_) => {}
            Err(nix::errno::Errno::EAGAIN) => {}
            Err(_) => break,
        }
        std::thread::sleep(Duration::from_millis(1));
    }
    0
}

/// `Pty::new` creates a symlink at the requested path; the path exists and is
/// genuinely a symlink (not a regular file).
#[test]
fn new_creates_a_symlink() {
    let path = unique_path("symlink");
    let pty = Pty::new(path.to_str().unwrap()).expect("Pty::new");

    let meta = std::fs::symlink_metadata(&path).expect("symlink_metadata");
    assert!(meta.file_type().is_symlink(), "created path must be a symlink");
    assert!(path.exists(), "symlink target must resolve to an existing tty");
    assert_eq!(pty.symlink_path, path.to_str().unwrap());

    drop(pty);
}

/// The master fd is valid (>= 0) and the symlinked slave path points at a tty.
#[test]
fn master_is_valid_and_slave_is_a_tty() {
    let path = unique_path("tty");
    let pty = Pty::new(path.to_str().unwrap()).expect("Pty::new");

    assert!(pty.master.as_raw_fd() >= 0, "master fd should be valid");

    // Open the symlinked slave and confirm the kernel agrees it is a terminal.
    let slave_fd = open(&path, OFlag::O_RDWR | OFlag::O_NOCTTY, Mode::empty())
        .expect("open slave path");
    let is_tty = nix::unistd::isatty(slave_fd).unwrap_or(false);
    let _ = close(slave_fd);
    assert!(is_tty, "slave end of the PTY must be a tty");

    drop(pty);
}

/// Round-trip: bytes written to the master fd are read back from the slave end,
/// byte-for-byte, with no echo (raw mode) and no line buffering.
#[test]
fn round_trip_master_to_slave() {
    let path = unique_path("roundtrip");
    let pty = Pty::new(path.to_str().unwrap()).expect("Pty::new");

    // Open the slave non-blocking so our bounded reader never hangs.
    let slave_fd = open(
        &path,
        OFlag::O_RDWR | OFlag::O_NOCTTY | OFlag::O_NONBLOCK,
        Mode::empty(),
    )
    .expect("open slave");

    let payload = b"G28\n";
    let written = write(&pty.master, payload).expect("write to master");
    assert_eq!(written, payload.len());

    let mut buf = [0u8; 64];
    let n = read_bounded(slave_fd, &mut buf);
    let _ = close(slave_fd);

    assert_eq!(n, payload.len(), "all bytes should arrive at the slave");
    assert_eq!(&buf[..n], payload, "bytes must round-trip unchanged (raw mode)");

    drop(pty);
}

/// The master fd is non-blocking: a read with no pending data returns `EAGAIN`
/// rather than blocking the caller forever.
#[test]
fn master_is_nonblocking() {
    let path = unique_path("nonblock");
    let pty = Pty::new(path.to_str().unwrap()).expect("Pty::new");

    let mut buf = [0u8; 16];
    match read(pty.master.as_raw_fd(), &mut buf) {
        Err(nix::errno::Errno::EAGAIN) => {} // expected: no data, would-block
        Ok(0) => {} // also acceptable: nothing available
        other => panic!("expected EAGAIN on empty non-blocking master, got {other:?}"),
    }

    drop(pty);
}

/// `Pty::new` creates a missing parent directory rather than failing when the
/// requested symlink lives under a not-yet-existing nested path.
#[test]
fn new_creates_missing_parent_dir() {
    let base = unique_path("nested");
    let nested = base.join("a").join("b").join("tty.sim");
    assert!(!base.exists(), "precondition: parent dir does not exist yet");

    let pty = Pty::new(nested.to_str().unwrap()).expect("Pty::new with nested path");
    assert!(nested.exists(), "nested symlink should now exist");
    assert!(
        std::fs::symlink_metadata(&nested).unwrap().file_type().is_symlink(),
        "nested path must be a symlink"
    );

    drop(pty);
    // Clean up the directory tree we created.
    let _ = std::fs::remove_dir_all(&base);
}

/// Calling `Pty::new` twice on the SAME path replaces the existing symlink
/// instead of erroring on the pre-existing file.
#[test]
fn new_twice_replaces_existing_symlink() {
    let path = unique_path("replace");

    let first = Pty::new(path.to_str().unwrap()).expect("first Pty::new");
    assert!(path.exists());

    // Second creation on the same path must succeed (old symlink removed first).
    let second = Pty::new(path.to_str().unwrap()).expect("second Pty::new replaces symlink");
    assert!(
        std::fs::symlink_metadata(&path).unwrap().file_type().is_symlink(),
        "path is still a symlink after replacement"
    );

    // The surviving Pty should still own a working master fd.
    assert!(second.master.as_raw_fd() >= 0);

    drop(first);
    drop(second);
}

/// `Drop` removes the symlink: after the `Pty` is dropped the path is gone.
#[test]
fn drop_removes_the_symlink() {
    let path = unique_path("drop");
    {
        let pty = Pty::new(path.to_str().unwrap()).expect("Pty::new");
        assert!(path.exists(), "symlink present while Pty is alive");
        drop(pty);
    }
    assert!(
        !Path::new(&path).exists() && std::fs::symlink_metadata(&path).is_err(),
        "symlink must be removed once the Pty is dropped"
    );
}
