use std::path::PathBuf;

fn main() {
    // Link against the pre-built firmware static library produced by PlatformIO.
    //
    // Build the library first:
    //   cd Firmware/MaDCore && pio run -e native_emulator
    //
    // This produces .pio/build/native_emulator/libfirmware.a containing all
    // firmware C code (APP, DEV, IO, Library, Main/MaD.c) compiled for the
    // native target. HAL implementations are provided by embsim-p2,
    // so HAL/Native/ and HW/Native/ are NOT included in the library.
    let lib_dir = PathBuf::from("../../Firmware/MaDCore/.pio/build/native_emulator")
        .canonicalize()
        .expect(
            "Firmware library not found. Build it first:\n\
             cd Firmware/MaDCore && pio run -e native_emulator",
        );

    let lib_path = lib_dir.join("libfirmware.a");
    if !lib_path.exists() {
        panic!(
            "libfirmware.a not found at {:?}.\n\
             Build it first: cd Firmware/MaDCore && pio run -e native_emulator",
            lib_path
        );
    }

    // Tell cargo where to find the library and to link it
    println!("cargo:rustc-link-search=native={}", lib_dir.display());
    println!("cargo:rustc-link-lib=static=firmware");

    // Re-run if the library changes
    println!("cargo:rerun-if-changed={}", lib_path.display());
}
