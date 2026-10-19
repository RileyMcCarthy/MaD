"""
PlatformIO pre-build script: refuse a FIRMWARE_VERSION the protocol can't carry.

The FirmwareVersion reply is a fixed string field (Protocol/MaDProtocol.yaml,
FirmwareVersion.version max_length, NUL included) and app_messageSlave.c
strncpy's into it, so a longer version builds fine and is silently truncated
on the wire ("0.0.0-hil.5593c8a" read back as "0.0.0-hil.5593c"). flexcc has
no working compile-time size check, so the guard lives here, where it covers
every env however FIRMWARE_VERSION arrives (build_flags or
PLATFORMIO_BUILD_FLAGS).
Added to platformio.ini as: extra_scripts = pre:extra_scripts/check_firmware_version.py
"""
import os

import yaml
from SCons.Script import Import

Import("env")

firmware_dir = env.subst("$PROJECT_DIR")
schema_path = os.path.normpath(os.path.join(firmware_dir, "..", "..", "Protocol", "MaDProtocol.yaml"))


def _firmware_version():
    flags = env.ParseFlags(env.get("BUILD_FLAGS", []))
    for define in flags.get("CPPDEFINES", []):
        if isinstance(define, (list, tuple)) and define[0] == "FIRMWARE_VERSION":
            return str(define[1]).strip('"\\')
    return None


def _max_length():
    with open(schema_path, encoding="utf-8") as schema_file:
        schema = yaml.safe_load(schema_file)
    for field in schema["structs"]["FirmwareVersion"]["fields"]:
        if field["name"] == "version":
            return int(field["max_length"])
    raise KeyError("FirmwareVersion.version not found in " + schema_path)


version = _firmware_version()
if version is not None:
    limit = _max_length() - 1  # the field's last byte is the NUL terminator
    if len(version) > limit:
        print(
            f"ERROR: FIRMWARE_VERSION '{version}' is {len(version)} chars; the protocol "
            f"FirmwareVersion field carries {limit} (would read back as '{version[:limit]}')."
        )
        env.Exit(1)
    print(f"FIRMWARE_VERSION '{version}' ({len(version)}/{limit} chars)")
