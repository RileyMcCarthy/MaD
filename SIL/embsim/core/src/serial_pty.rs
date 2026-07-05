//! Serial PTY — creates a PTY pair for host ↔ firmware communication.
//!
//! Uses `openpty()` to create a master/slave PTY pair. The master FD is used
//! by the serial peripheral for firmware I/O. The slave path is symlinked to
//! a well-known location so host software can connect to it.

use nix::pty::{openpty, OpenptyResult};
use nix::sys::termios::{self, LocalFlags, InputFlags, OutputFlags, SetArg};
use std::fs;
use std::os::fd::{AsRawFd, OwnedFd};
use std::path::Path;
use tracing::info;

/// Holds the PTY pair file descriptors and paths.
pub struct Pty {
    /// Master FD — emulator reads/writes this.
    pub master: OwnedFd,
    /// Slave FD — kept open so the PTY stays alive.
    _slave: OwnedFd,
    /// Symlink path the host connects to (e.g. `/tmp/tty.sim_client`).
    pub symlink_path: String,
}

impl Pty {
    /// Create a new PTY pair and symlink the slave to `symlink_path`.
    pub fn new(symlink_path: &str) -> std::io::Result<Self> {
        let OpenptyResult { master, slave } = openpty(None, None)
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?;

        let master_fd = master;
        let slave_fd = slave;

        // Configure the slave for raw mode (no echo, no line buffering)
        let mut termios_config = termios::tcgetattr(&slave_fd)
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?;
        termios::cfmakeraw(&mut termios_config);
        termios_config.local_flags &= !(LocalFlags::ECHO | LocalFlags::ICANON | LocalFlags::ISIG);
        termios_config.input_flags &= !(InputFlags::IXON | InputFlags::IXOFF | InputFlags::ICRNL);
        termios_config.output_flags &= !OutputFlags::OPOST;
        termios::tcsetattr(&slave_fd, SetArg::TCSANOW, &termios_config)
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?;

        // Get the slave device path
        let slave_path = get_slave_path(&slave_fd)?;

        // Set master FD to non-blocking
        set_nonblocking(&master_fd)?;

        // Create symlink: remove existing, then symlink
        let link = Path::new(symlink_path);
        if link.exists() || link.is_symlink() {
            let _ = fs::remove_file(link);
        }
        if let Some(parent) = link.parent() {
            let _ = fs::create_dir_all(parent);
        }
        std::os::unix::fs::symlink(&slave_path, link)?;

        info!("PTY created: master_fd={}, slave={}", master_fd.as_raw_fd(), slave_path);
        info!("PTY symlinked: {} → {}", symlink_path, slave_path);

        Ok(Pty {
            master: master_fd,
            _slave: slave_fd,
            symlink_path: symlink_path.to_string(),
        })
    }
}

impl Drop for Pty {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.symlink_path);
        info!("PTY symlink removed: {}", self.symlink_path);
    }
}

/// Get the device path of a slave PTY FD.
fn get_slave_path(fd: &OwnedFd) -> std::io::Result<String> {
    match nix::unistd::ttyname(fd) {
        Ok(path) => Ok(path.to_string_lossy().to_string()),
        Err(e) => Err(std::io::Error::new(std::io::ErrorKind::Other, e)),
    }
}

/// Set a file descriptor to non-blocking mode.
fn set_nonblocking(fd: &OwnedFd) -> std::io::Result<()> {
    use nix::fcntl::{fcntl, FcntlArg, OFlag};
    let flags = fcntl(fd.as_raw_fd(), FcntlArg::F_GETFL)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?;
    let mut flags = OFlag::from_bits_truncate(flags);
    flags.insert(OFlag::O_NONBLOCK);
    fcntl(fd.as_raw_fd(), FcntlArg::F_SETFL(flags))
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?;
    Ok(())
}
