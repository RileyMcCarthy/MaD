#!/usr/bin/env python3
"""
ProtoEmb Cargo build helper.

Called from a platform crate's build.rs to generate Rust code from the
platform's protocol YAML schema.

Usage (from build.rs):
    python3 <core_dir>/cargo_build.py \\
        --schema <platform_dir>/protocol.yaml \\
        --output <crate_dir>/src/generated/

This is a thin wrapper around generate.py that resolves paths relative
to the calling crate.
"""

import argparse
import os
import subprocess
import sys
from pathlib import Path


def main():
    """Parse CLI args and run the cargo build helper."""
    parser = argparse.ArgumentParser(description="ProtoEmb Cargo build helper")
    parser.add_argument("--schema", required=True, help="Path to protocol YAML schema")
    parser.add_argument("--config", required=False, help="Path to generator config YAML")
    parser.add_argument("--output", required=True, help="Output directory for generated code")
    args = parser.parse_args()

    core_dir = Path(__file__).parent
    generate_script = core_dir / "generate.py"
    template_dir = core_dir / "templates"

    # Ensure output directory exists
    os.makedirs(args.output, exist_ok=True)

    # Run the generator
    command = [
        sys.executable,
        str(generate_script),
        "--schema", args.schema,
        "--target", "rs",
        "--output", args.output,
        "--templates", str(template_dir),
    ]

    if args.config:
        command.extend(["--config", args.config])

    result = subprocess.run(
        command,
        capture_output=True,
        text=True,
    )

    if result.stdout:
        print(result.stdout, end="")
    if result.stderr:
        print(result.stderr, end="", file=sys.stderr)

    sys.exit(result.returncode)


if __name__ == "__main__":
    main()
