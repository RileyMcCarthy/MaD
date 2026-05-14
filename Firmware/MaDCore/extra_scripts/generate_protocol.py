"""
PlatformIO pre-build script: Generate protocol C code from YAML schema.

Runs ProtoEmb/core/generate.py to produce protoemb.h and protoemb.c in src/Generated/.
Added to platformio.ini as: extra_scripts = pre:extra_scripts/generate_protocol.py
"""
import os
import subprocess
import sys
from SCons.Script import Import

Import("env")

# Paths relative to the firmware project root
firmware_dir = env.subst("$PROJECT_DIR")
protoemb_dir = os.path.normpath(os.path.join(firmware_dir, "..", "..", "Protocol", "ProtoEmb"))
core_dir = os.path.join(protoemb_dir, "core")
schema_path = os.path.normpath(os.path.join(firmware_dir, "..", "..", "Protocol", "MaDProtocol.yaml"))
generate_script = os.path.join(core_dir, "generate.py")
template_dir = os.path.join(core_dir, "templates")
output_dir = os.path.join(firmware_dir, "src", "Generated")

# Skip if schema or generator don't exist
if not os.path.exists(schema_path) or not os.path.exists(generate_script):
    print("WARNING: Protocol schema or generator not found, skipping codegen")
else:
    # Ensure dependencies are installed in PlatformIO's Python
    requirements_path = os.path.join(core_dir, "requirements.txt")
    if os.path.exists(requirements_path):
        subprocess.run(
            [sys.executable, "-m", "pip", "install", "-q", "-r", requirements_path],
            capture_output=True,
        )

    print("Generating protocol C code from YAML schema...")
    result = subprocess.run(
        [sys.executable, generate_script,
         "--schema", schema_path,
         "--target", "c",
         "--output", output_dir,
         "--templates", template_dir],
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        print("ERROR: Protocol code generation failed:")
        print(result.stderr)
        env.Exit(1)
    else:
        print(result.stdout.strip())
