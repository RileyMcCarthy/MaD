# The FlexC VFS sources (fatfs_vfs.c, sdmm.cc, fatfs.cc) are not compiled with
# the per-file build_flags: they resolve lazily through `__fromfile`/`__using`
# during the LINK step, and PlatformIO's link line carries no -D defines at
# all. So a `-D_DEBUG_SDMM` in build_flags changes nothing — byte-identical
# image — while the same define appended to LINKFLAGS reaches exactly the
# compile that matters. flexcc is both compiler and linker, so it accepts it.
Import("env")

for flag in env.get("BUILD_FLAGS", []):
    if flag.startswith("-D_DEBUG"):
        env.Append(LINKFLAGS=[flag])
