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
