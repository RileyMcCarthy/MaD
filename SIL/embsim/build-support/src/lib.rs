//! embsim-build — build-script helpers for emulator binaries.
//!
//! An emulator binary links a firmware static library (built out-of-band, e.g.
//! by PlatformIO) and provides the HAL implementation via a platform crate.
//! This crate centralizes the "find and link `lib<name>.a`" dance so every
//! consumer's `build.rs` is two lines and honors the same env-var overrides.
//!
//! # Usage
//!
//! ```rust,ignore
//! // build.rs
//! fn main() {
//!     embsim_build::link_firmware_static(
//!         "../../Firmware/MaDCore/.pio/build/native_emulator", // default dir
//!         "firmware",                                          // default lib name
//!     );
//! }
//! ```
//!
//! # Overrides
//!
//! - `EMBSIM_FIRMWARE_LIB_DIR` — directory containing `lib<name>.a`
//! - `EMBSIM_FIRMWARE_LIB_NAME` — library name (without `lib` prefix / `.a` suffix)
//!
//! Both fall back to the arguments passed to [`link_firmware_static`], so the
//! in-tree build "just works" while out-of-tree consumers can point elsewhere
//! without editing `build.rs`.

use std::path::PathBuf;

/// Locate a firmware static library and emit the cargo directives to link it.
///
/// Resolves the directory from `EMBSIM_FIRMWARE_LIB_DIR` (else `default_dir`)
/// and the library name from `EMBSIM_FIRMWARE_LIB_NAME` (else `default_name`),
/// then emits `rustc-link-search` / `rustc-link-lib=static` plus the
/// appropriate `rerun-if-*` triggers.
///
/// # Panics
/// Panics with an actionable message if the directory cannot be resolved or
/// `lib<name>.a` is missing — a build-time misconfiguration that should fail
/// loudly rather than produce a binary with unresolved HAL symbols.
pub fn link_firmware_static(default_dir: &str, default_name: &str) {
    println!("cargo:rerun-if-env-changed=EMBSIM_FIRMWARE_LIB_DIR");
    println!("cargo:rerun-if-env-changed=EMBSIM_FIRMWARE_LIB_NAME");

    let lib_dir_raw =
        std::env::var("EMBSIM_FIRMWARE_LIB_DIR").unwrap_or_else(|_| default_dir.to_string());
    let lib_name =
        std::env::var("EMBSIM_FIRMWARE_LIB_NAME").unwrap_or_else(|_| default_name.to_string());

    let lib_dir = PathBuf::from(&lib_dir_raw).canonicalize().unwrap_or_else(|e| {
        panic!(
            "embsim-build: firmware library directory {lib_dir_raw:?} not found ({e}).\n\
             Build the firmware static library first, or set EMBSIM_FIRMWARE_LIB_DIR \
             to the directory containing lib{lib_name}.a."
        )
    });

    let lib_path = lib_dir.join(format!("lib{lib_name}.a"));
    if !lib_path.exists() {
        panic!(
            "embsim-build: lib{lib_name}.a not found at {lib_path:?}.\n\
             Build the firmware static library first, or set \
             EMBSIM_FIRMWARE_LIB_DIR / EMBSIM_FIRMWARE_LIB_NAME."
        );
    }

    println!("cargo:rustc-link-search=native={}", lib_dir.display());
    println!("cargo:rustc-link-lib=static={lib_name}");
    println!("cargo:rerun-if-changed={}", lib_path.display());
}
