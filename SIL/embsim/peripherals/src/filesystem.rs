//! Filesystem — Mount/unmount stubs for SD card or local filesystem.

use std::ffi::CStr;
use std::fs;
use std::sync::OnceLock;
use tracing::info;

/// Filesystem mount path (set from project config).
static FS_PATH: OnceLock<String> = OnceLock::new();

/// Initialize the filesystem path.
pub fn init(path: &str) {
    FS_PATH.get_or_init(|| path.to_string());
    let _ = fs::create_dir_all(path);
    info!("Filesystem path: {}", path);
}

/// Mount a filesystem path (create directory).
///
/// # Safety
/// `user_name` must be a valid C string pointer.
pub unsafe fn mount(user_name: *const std::ffi::c_char) -> i32 {
    if user_name.is_null() {
        return -1;
    }
    let name = CStr::from_ptr(user_name).to_string_lossy();
    info!("mount(\"{}\")", name);
    match fs::create_dir_all(name.as_ref()) {
        Ok(_) => 0,
        Err(e) => {
            tracing::error!("mount failed: {}", e);
            -1
        }
    }
}

/// Unmount a filesystem path (no-op).
///
/// # Safety
/// `user_name` must be a valid C string pointer.
pub unsafe fn umount(user_name: *const std::ffi::c_char) -> i32 {
    if user_name.is_null() {
        return -1;
    }
    let name = CStr::from_ptr(user_name).to_string_lossy();
    info!("umount(\"{}\")", name);
    0
}

/// Open VFS (no-op in emulation).
pub fn vfs_open_sdcard() -> *mut std::ffi::c_void {
    std::ptr::null_mut()
}

// ============================================================
// Tests
// ============================================================

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::CString;

    /// Build a unique temp path under the OS temp dir without creating it.
    /// A monotonic counter keeps paths distinct across tests in one process.
    fn temp_path(tag: &str) -> std::path::PathBuf {
        use std::sync::atomic::{AtomicU64, Ordering};
        static N: AtomicU64 = AtomicU64::new(0);
        let n = N.fetch_add(1, Ordering::Relaxed);
        std::env::temp_dir().join(format!("embsim_fs_{}_{}_{}", tag, std::process::id(), n))
    }

    #[test]
    fn init_creates_the_directory() {
        let _g = crate::test_support::guard();
        crate::test_support::ensure_clock();
        let dir = temp_path("init");
        assert!(!dir.exists());
        // FS_PATH is process-once; first init in the process wins. We assert the
        // directory-creation side effect, NOT that FS_PATH changed.
        init(dir.to_str().unwrap());
        assert!(dir.exists() && dir.is_dir());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn mount_valid_path_returns_zero_and_creates_dir() {
        let _g = crate::test_support::guard();
        crate::test_support::ensure_clock();
        let dir = temp_path("mount");
        let cpath = CString::new(dir.to_str().unwrap()).unwrap();
        assert!(!dir.exists());
        let rc = unsafe { mount(cpath.as_ptr()) };
        assert_eq!(rc, 0, "mount of a valid path succeeds");
        assert!(dir.exists() && dir.is_dir(), "mount creates the directory");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn mount_null_returns_minus_one() {
        let _g = crate::test_support::guard();
        crate::test_support::ensure_clock();
        // A null C-string pointer is rejected.
        let rc = unsafe { mount(std::ptr::null()) };
        assert_eq!(rc, -1);
    }

    #[test]
    fn umount_valid_returns_zero() {
        let _g = crate::test_support::guard();
        crate::test_support::ensure_clock();
        let dir = temp_path("umount");
        let cpath = CString::new(dir.to_str().unwrap()).unwrap();
        // umount is a no-op that simply reports success for a valid name.
        let rc = unsafe { umount(cpath.as_ptr()) };
        assert_eq!(rc, 0);
    }

    #[test]
    fn umount_null_returns_minus_one() {
        let _g = crate::test_support::guard();
        crate::test_support::ensure_clock();
        let rc = unsafe { umount(std::ptr::null()) };
        assert_eq!(rc, -1);
    }

    #[test]
    fn vfs_open_sdcard_returns_null() {
        let _g = crate::test_support::guard();
        crate::test_support::ensure_clock();
        // Emulation has no real VFS handle.
        assert!(vfs_open_sdcard().is_null());
    }
}
