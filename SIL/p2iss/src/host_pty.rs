//! The host's end of a serial link, as a board component.
//!
//! A PTY on one side, two digital pins on the other. Whatever the host writes
//! to `/tmp/tty.rpi` is framed onto a net as edges; whatever the net carries
//! back is deframed and handed to the host.
//!
//! This is the piece that lets [`crate::P2Iss`] stand in for the native
//! backend in `mad-emulator`. The native path hands the PTY master straight to
//! a peripheral serial channel
//! (`serial::init_channel_fd(host_ch, pty.master.as_raw_fd())`) — the bytes
//! never touch a net. Here the same file descriptor sits behind a
//! [`SerialLevelBridge`], so the host's traffic crosses the same wire the
//! firmware's does, at the same rate, and can be broken the same ways.

use std::os::fd::{AsRawFd, BorrowedFd, RawFd};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;

use embsim_board::uart::{FramingError, UartFraming};
use embsim_board::{AttachError, Component, ComponentNetIo, PinDecl, PinKind, SerialLevelBridge};
use embsim_core::serial_pty::Pty;

/// Poll timeout for the pump thread: the bound on shutdown latency, finer than
/// any protocol timeout the firmware runs.
const PUMP_POLL_TIMEOUT_MS: i32 = 10;

/// Read chunk for draining host bytes.
const PUMP_READ_CHUNK: usize = 256;

/// A serial link whose far end is a PTY the host can open.
pub struct HostPty {
    pins: [PinDecl; 2],
    framing: UartFraming,
    /// Kept alive for the component's life: dropping it closes the PTY and
    /// removes the symlink.
    pty: Pty,
    bridge: Arc<Mutex<Option<Arc<SerialLevelBridge>>>>,
    shutdown: Arc<AtomicBool>,
    pump: Option<JoinHandle<()>>,
}

impl std::fmt::Debug for HostPty {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("HostPty")
            .field("symlink", &self.pty.symlink_path)
            .field("framing", &self.framing)
            .finish()
    }
}

impl HostPty {
    /// Open a PTY at `symlink_path` and frame it at `baud_hz`.
    ///
    /// The pins are named `"TX"` (what the host sends, driven onto the net)
    /// and `"RX"` (what the host receives), from the *host's* point of view —
    /// so a harness reads `HostPty.TX → P2.P53` the way a cable does.
    pub fn open(symlink_path: &str, baud_hz: u32) -> std::io::Result<Self> {
        Ok(Self {
            pins: [
                PinDecl {
                    number: "TX",
                    name: None,
                    kind: PinKind::DigitalOut,
                    stream: None,
                    drive_impedance: None,
                },
                PinDecl {
                    number: "RX",
                    name: None,
                    kind: PinKind::DigitalIn,
                    stream: None,
                    drive_impedance: None,
                },
            ],
            framing: UartFraming::new_8n1(baud_hz),
            pty: Pty::new(symlink_path)?,
            bridge: Arc::new(Mutex::new(None)),
            shutdown: Arc::new(AtomicBool::new(false)),
            pump: None,
        })
    }

    /// The path a host opens to reach this link.
    pub fn symlink_path(&self) -> &str {
        &self.pty.symlink_path
    }
}

impl Component for HostPty {
    fn pins(&self) -> &[PinDecl] {
        &self.pins
    }

    fn attach(&mut self, io: ComponentNetIo) -> Result<(), AttachError> {
        let bridge = Arc::new(SerialLevelBridge::new(
            self.framing,
            io.pin("TX")?,
            io.clone(),
            Arc::clone(&self.shutdown),
        ));
        // An idle asynchronous line still drives: without it the far end has no
        // reference against which the first start bit is a falling edge.
        bridge.idle();
        *self.bridge.lock().expect("bridge slot never poisoned") = Some(Arc::clone(&bridge));

        let master: RawFd = self.pty.master.as_raw_fd();

        // Net → host: whatever the wire spells goes out the PTY.
        {
            let (bridge, shutdown) = (Arc::clone(&bridge), Arc::clone(&self.shutdown));
            io.on_sense("RX", move |state| {
                if shutdown.load(Ordering::Relaxed) {
                    return;
                }
                deliver(master, bridge.receive_sense(state));
            })?;
        }
        {
            let (bridge, shutdown) = (Arc::clone(&bridge), Arc::clone(&self.shutdown));
            io.on_wake_ns(move |now_ns| {
                if shutdown.load(Ordering::Relaxed) {
                    return;
                }
                deliver(master, bridge.service(now_ns));
            });
        }

        // Host → net: a pump thread, for the same reason the MCU bridge uses
        // one — nothing on a net-resolution path may block on a file
        // descriptor.
        let shutdown = Arc::clone(&self.shutdown);
        let thread = std::thread::Builder::new()
            .name("host-pty-pump".to_string())
            .spawn(move || pump_loop(master, &bridge, &shutdown))
            .map_err(|e| AttachError::Failed {
                message: format!("host PTY: cannot spawn pump thread: {e}"),
            })?;
        self.pump = Some(thread);
        Ok(())
    }
}

impl Drop for HostPty {
    fn drop(&mut self) {
        self.shutdown.store(true, Ordering::Relaxed);
        if let Some(pump) = self.pump.take() {
            let _ = pump.join();
        }
    }
}

/// Hand deframed bytes to the host.
///
/// Runs on the engine thread, so the write must never block: the master is
/// non-blocking and a full buffer drops the byte with a trace, which is what a
/// host that has stopped reading looks like to a UART.
fn deliver(master: RawFd, frames: Vec<Result<u8, FramingError>>) {
    for frame in frames {
        let byte = match frame {
            Ok(byte) => byte,
            Err(error) => {
                tracing::debug!(?error, "host PTY: frame dropped (bad framing on the wire)");
                continue;
            }
        };
        // SAFETY: the master descriptor is owned by the `HostPty` that
        // installed this callback, and the engine is joined before the
        // component drops (`SystemHandle`'s documented order).
        let fd = unsafe { BorrowedFd::borrow_raw(master) };
        if let Err(e) = nix::unistd::write(fd, &[byte]) {
            tracing::trace!(error = %e, "host PTY: byte dropped (host not reading)");
        }
    }
}

/// Read whatever the host wrote and frame it onto the wire.
fn pump_loop(master: RawFd, bridge: &SerialLevelBridge, shutdown: &AtomicBool) {
    let mut buf = [0u8; PUMP_READ_CHUNK];
    while !shutdown.load(Ordering::Relaxed) {
        let mut pollfd = libc::pollfd {
            fd: master,
            events: libc::POLLIN,
            revents: 0,
        };
        // SAFETY: `pollfd` is a valid, exclusively borrowed array of one.
        let rc = unsafe { libc::poll(&mut pollfd, 1, PUMP_POLL_TIMEOUT_MS) };
        if rc < 0 {
            let err = std::io::Error::last_os_error();
            if err.kind() == std::io::ErrorKind::Interrupted {
                continue;
            }
            tracing::debug!(error = %err, "host PTY: poll failed; pump stopping");
            return;
        }
        if rc == 0 {
            continue; // timeout — re-check the shutdown flag
        }
        // SAFETY: the master stays open until the owning component joins this
        // thread in `Drop`.
        let fd = unsafe { BorrowedFd::borrow_raw(master) };
        loop {
            match nix::unistd::read(fd, &mut buf) {
                Ok(0) => break, // no host attached yet; poll again
                Ok(n) => {
                    bridge.transmit(&buf[..n]);
                }
                Err(nix::errno::Errno::EAGAIN) => break,
                Err(nix::errno::Errno::EINTR) => continue,
                Err(e) => {
                    tracing::debug!(error = %e, "host PTY: read failed; pump stopping");
                    return;
                }
            }
        }
    }
}
