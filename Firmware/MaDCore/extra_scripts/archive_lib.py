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
    return ret

# Replace the default Program (link) action with our archive action
env.Replace(
    LINKCOM=create_archive,
    PROGSUFFIX=".a"
)
