//! Link against the pre-built firmware static library produced by PlatformIO.
//!
//! Build the library first:
//!   cd Firmware/MaDCore && pio run -e native_emulator
//!
//! This produces `.pio/build/native_emulator/libfirmware.a` containing all
//! firmware C code (APP, DEV, IO, Library, Main/MaD.c) compiled for the native
//! target. HAL implementations are provided by `embsim-p2`, so `HAL/P2/` is
//! not compiled into the library.
//!
//! Override the location without editing this file via `EMBSIM_FIRMWARE_LIB_DIR`
//! / `EMBSIM_FIRMWARE_LIB_NAME` (see the `embsim-build` crate).

fn main() {
    embsim_build::link_firmware_static(
        "../../Firmware/MaDCore/.pio/build/native_emulator",
        "firmware",
    );
}
