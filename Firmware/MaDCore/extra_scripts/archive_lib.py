"""
PlatformIO build script: Replace the link step with static archive creation.
Used by the native_emulator environment for Rust SIL linking.

Instead of linking into an executable (which would fail due to missing HAL symbols),
this script replaces the Program builder with a Library builder that produces
libfirmware.a from the compiled .o files.
"""
import os

from SCons.Script import Import

Import("env")

def create_archive(target, source, env):
    """Replace the linker step: package .o files into a static archive."""
    build_dir = env.subst("$BUILD_DIR")
    lib_path = os.path.join(build_dir, "libfirmware.a")

    # source contains all the .o files SCons collected
    obj_files = [str(s) for s in source]

    if not obj_files:
        print("ERROR: No object files to archive")
        return 1

    # Use ar to create static archive
    ar_cmd = "ar rcs %s %s" % (lib_path, " ".join(obj_files))
    print("Creating libfirmware.a with %d object files" % len(obj_files))
    ret = env.Execute(ar_cmd)
    if ret == 0:
        print("Created: %s" % lib_path)
        ret = verify_config_tables(lib_path)
    return ret


# HAL config tables the SIL emulator reads from the archive (pin/baud truth —
# part of the firmware<->emulator contract). Fail the build if one goes missing
# so "table optimized away" is a build error, not a mystery unwired pin.
REQUIRED_CONFIG_SYMBOLS = [
    "HAL_serial_channelConfig",
    "HAL_GPIO_channelConfig",
    "HAL_encoder_config",
    "HAL_pulseOut_channelConfig",
]


def verify_config_tables(lib_path):
    import subprocess
    out = subprocess.run(["nm", lib_path], capture_output=True, text=True).stdout
    missing = [s for s in REQUIRED_CONFIG_SYMBOLS if s not in out]
    if missing:
        print("ERROR: libfirmware.a is missing HAL config table symbols: %s" % ", ".join(missing))
        return 1
    print("Verified HAL config tables present: %s" % ", ".join(REQUIRED_CONFIG_SYMBOLS))
    return 0

# Replace the default Program (link) action with our archive action
env.Replace(
    LINKCOM=create_archive,
    PROGSUFFIX=".a"
)
