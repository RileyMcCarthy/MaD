//! FlexC runtime stubs — filesystem VFS functions required by the FlexC
//! C runtime when targeting the Propeller 2.

use embsim_peripherals::filesystem;

/// Mount SD card filesystem (redirects to filesystem module).
#[no_mangle]
pub unsafe extern "C" fn mount(
    user_name: *const std::ffi::c_char,
    _v: *mut std::ffi::c_void,
) -> i32 {
    filesystem::mount(user_name)
}

/// Unmount SD card filesystem (redirects to filesystem module).
#[no_mangle]
pub unsafe extern "C" fn umount(user_name: *const std::ffi::c_char) -> i32 {
    filesystem::umount(user_name)
}

/// Open SD card VFS (FlexC runtime).
#[no_mangle]
pub unsafe extern "C" fn _vfs_open_sdcard() -> *mut std::ffi::c_void {
    filesystem::vfs_open_sdcard()
}
