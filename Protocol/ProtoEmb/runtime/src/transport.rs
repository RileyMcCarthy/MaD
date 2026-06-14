//! Transport abstraction for serial communication.
//!
//! Provides a trait [`Transport`] that decouples the client from any
//! specific serial port implementation. Includes [`SerialTransport`]
//! for real hardware via the `serialport` crate.

use std::io;
use std::time::Duration;

/// On native targets, transports must be `Send` so they can run on worker
/// threads. On wasm32 there are no threads and the in-memory transport uses
/// `Rc`, so the `Send` bound is dropped there.
#[cfg(not(target_arch = "wasm32"))]
pub trait MaybeSend: Send {}
#[cfg(not(target_arch = "wasm32"))]
impl<T: Send> MaybeSend for T {}
#[cfg(target_arch = "wasm32")]
pub trait MaybeSend {}
#[cfg(target_arch = "wasm32")]
impl<T> MaybeSend for T {}

/// Abstraction over a bidirectional byte stream (serial port, PTY, socket, etc.).
///
/// Implementations must be `Send` on native targets (see [`MaybeSend`]).
pub trait Transport: MaybeSend {
    /// Write bytes to the transport. Must send all bytes or return an error.
    fn write_all(&mut self, data: &[u8]) -> io::Result<()>;

    /// Read available bytes into `buf`. Returns the number of bytes read.
    /// Should return `Ok(0)` on timeout (non-blocking) rather than blocking forever.
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize>;

    /// Set the read timeout. `None` means block indefinitely.
    fn set_read_timeout(&mut self, timeout: Option<Duration>) -> io::Result<()>;

    /// Close the transport. After this, further reads/writes should error.
    fn close(&mut self) -> io::Result<()>;

    /// Return the transport's display name (e.g. port path) for logging.
    fn name(&self) -> &str;
}

/// Serial port transport using the `serialport` crate.
#[cfg(not(target_arch = "wasm32"))]
pub struct SerialTransport {
    port: Box<dyn serialport::SerialPort>,
    path: String,
}

#[cfg(not(target_arch = "wasm32"))]
impl SerialTransport {
    /// Open a serial port at the given path and baud rate.
    pub fn open(path: &str, baud_rate: u32) -> io::Result<Self> {
        let port = serialport::new(path, baud_rate)
            .timeout(Duration::from_millis(100))
            .open()
            .map_err(|e| io::Error::new(io::ErrorKind::Other, e))?;

        log::info!("Opened serial port: {} @ {} baud", path, baud_rate);

        Ok(Self {
            port,
            path: path.to_string(),
        })
    }
}

#[cfg(not(target_arch = "wasm32"))]
impl Transport for SerialTransport {
    fn write_all(&mut self, data: &[u8]) -> io::Result<()> {
        use std::io::Write;
        self.port.write_all(data)?;
        self.port.flush()
    }

    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        use std::io::Read;
        match self.port.read(buf) {
            Ok(n) => Ok(n),
            Err(e) if e.kind() == io::ErrorKind::TimedOut => Ok(0),
            Err(e) => Err(e),
        }
    }

    fn set_read_timeout(&mut self, timeout: Option<Duration>) -> io::Result<()> {
        let t = timeout.unwrap_or(Duration::from_secs(3600));
        self.port
            .set_timeout(t)
            .map_err(|e| io::Error::new(io::ErrorKind::Other, e))
    }

    fn close(&mut self) -> io::Result<()> {
        // serialport doesn't have an explicit close — dropping does it.
        // We can't drop in place, so we just log.
        log::info!("Closing serial port: {}", self.path);
        Ok(())
    }

    fn name(&self) -> &str {
        &self.path
    }
}

// ── PTY transport for virtual serial ports (macOS/Linux) ──

/// PTY-based transport using raw POSIX file I/O.
///
/// The `serialport` crate cannot open PTYs on macOS because it tries to
/// set baud-rate and other serial-port-specific attributes via `tcsetattr`
/// which fails with ENOTTY on pseudo-terminals.
///
/// This transport opens the PTY as a regular file descriptor and performs
/// non-blocking reads/writes using `libc` directly.
#[cfg(unix)]
pub struct PtyTransport {
    fd: std::os::unix::io::RawFd,
    path: String,
    read_timeout: Option<Duration>,
}

#[cfg(unix)]
impl PtyTransport {
    /// Open a PTY at the given path for read/write.
    pub fn open(path: &str) -> io::Result<Self> {
        use std::ffi::CString;

        let c_path = CString::new(path)
            .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "invalid path"))?;

        let fd = unsafe { libc::open(c_path.as_ptr(), libc::O_RDWR | libc::O_NOCTTY | libc::O_NONBLOCK) };
        if fd < 0 {
            return Err(io::Error::last_os_error());
        }

        log::info!("Opened PTY: {}", path);

        Ok(Self {
            fd,
            path: path.to_string(),
            read_timeout: Some(Duration::from_millis(100)),
        })
    }

    /// Check if a path is a PTY/character device (not a real serial port).
    ///
    /// Heuristic: if the path starts with `/dev/ttys` (macOS PTY) or
    /// `/dev/pts/` (Linux PTY) or is a symlink to one, treat it as a PTY.
    pub fn is_pty(path: &str) -> bool {
        // Resolve symlinks first
        let resolved = std::fs::canonicalize(path)
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_else(|_| path.to_string());

        resolved.starts_with("/dev/ttys")   // macOS PTY slaves
            || resolved.starts_with("/dev/pts/") // Linux PTY slaves
    }
}

#[cfg(unix)]
impl Transport for PtyTransport {
    fn write_all(&mut self, data: &[u8]) -> io::Result<()> {
        let mut written = 0;
        while written < data.len() {
            let n = unsafe {
                libc::write(
                    self.fd,
                    data[written..].as_ptr() as *const libc::c_void,
                    data.len() - written,
                )
            };
            if n < 0 {
                let err = io::Error::last_os_error();
                if err.kind() == io::ErrorKind::WouldBlock {
                    std::thread::sleep(Duration::from_millis(1));
                    continue;
                }
                return Err(err);
            }
            written += n as usize;
        }
        Ok(())
    }

    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        // Use poll(2) to wait for data with timeout
        let timeout_ms = self.read_timeout
            .map(|d| d.as_millis() as i32)
            .unwrap_or(-1);

        let mut pfd = libc::pollfd {
            fd: self.fd,
            events: libc::POLLIN,
            revents: 0,
        };

        let ret = unsafe { libc::poll(&mut pfd, 1, timeout_ms) };
        if ret < 0 {
            return Err(io::Error::last_os_error());
        }
        if ret == 0 {
            // Timeout — return 0 bytes (non-blocking behavior)
            return Ok(0);
        }

        let n = unsafe {
            libc::read(
                self.fd,
                buf.as_mut_ptr() as *mut libc::c_void,
                buf.len(),
            )
        };
        if n < 0 {
            let err = io::Error::last_os_error();
            if err.kind() == io::ErrorKind::WouldBlock {
                return Ok(0);
            }
            return Err(err);
        }
        Ok(n as usize)
    }

    fn set_read_timeout(&mut self, timeout: Option<Duration>) -> io::Result<()> {
        self.read_timeout = timeout;
        Ok(())
    }

    fn close(&mut self) -> io::Result<()> {
        if self.fd >= 0 {
            unsafe { libc::close(self.fd) };
            self.fd = -1;
            log::info!("Closed PTY: {}", self.path);
        }
        Ok(())
    }

    fn name(&self) -> &str {
        &self.path
    }
}

#[cfg(unix)]
impl Drop for PtyTransport {
    fn drop(&mut self) {
        if self.fd >= 0 {
            unsafe { libc::close(self.fd) };
        }
    }
}

// ── In-memory transport for testing ──

/// In-memory transport for unit tests.
///
/// Available under `#[cfg(test)]` across all modules in this crate,
/// and also publicly exported for downstream test usage.
#[cfg(test)]
pub mod testing {
    use super::*;
    use std::collections::VecDeque;

    /// In-memory transport for testing — no real I/O.
    pub struct MemoryTransport {
        /// Data written by the client (outgoing)
        pub tx: Vec<u8>,
        /// Data to be read by the client (incoming) — prepopulate before reads
        pub rx: VecDeque<u8>,
    }

    impl MemoryTransport {
        pub fn new() -> Self {
            Self {
                tx: Vec::new(),
                rx: VecDeque::new(),
            }
        }

        /// Push bytes that will be returned on subsequent reads.
        pub fn push_rx(&mut self, data: &[u8]) {
            self.rx.extend(data);
        }
    }

    impl Transport for MemoryTransport {
        fn write_all(&mut self, data: &[u8]) -> io::Result<()> {
            self.tx.extend_from_slice(data);
            Ok(())
        }

        fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
            let n = buf.len().min(self.rx.len());
            for b in buf.iter_mut().take(n) {
                *b = self.rx.pop_front().unwrap();
            }
            Ok(n)
        }

        fn set_read_timeout(&mut self, _timeout: Option<Duration>) -> io::Result<()> {
            Ok(())
        }

        fn close(&mut self) -> io::Result<()> {
            Ok(())
        }

        fn name(&self) -> &str {
            "memory"
        }
    }
}

#[cfg(test)]
mod tests {
    use super::testing::MemoryTransport;
    use super::*;

    #[test]
    fn test_memory_transport_roundtrip() {
        let mut t = MemoryTransport::new();
        t.push_rx(&[1, 2, 3]);

        let mut buf = [0u8; 4];
        let n = t.read(&mut buf).unwrap();
        assert_eq!(n, 3);
        assert_eq!(&buf[..3], &[1, 2, 3]);

        t.write_all(&[10, 20]).unwrap();
        assert_eq!(t.tx, vec![10, 20]);
    }
}
