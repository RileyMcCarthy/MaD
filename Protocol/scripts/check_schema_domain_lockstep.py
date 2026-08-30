#!/usr/bin/env python3
"""M12 — Fail if MaDProtocol.yaml MachineConfiguration fields drift from the
domain mapping / display layer.

The TS codec is generated at build time (gitignored). The *domain* layer
(types.ts + mapping.ts) is hand-maintained and must track YAML field names.
A stale mapping (domain naming one generation of the force-gauge calibration
fields while the schema declares the other) silently breaks config
round-trips.

Usage (repo root):
  python3 Protocol/scripts/check_schema_domain_lockstep.py
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

try:
    import yaml
except ImportError:
    print("error: PyYAML required (pip install pyyaml)", file=sys.stderr)
    sys.exit(2)

ROOT = Path(__file__).resolve().parents[2]
SCHEMA = ROOT / "Protocol" / "MaDProtocol.yaml"
MAPPING = ROOT / "Software" / "Control" / "src" / "domain" / "mapping.ts"
TYPES = ROOT / "Software" / "Control" / "src" / "domain" / "types.ts"


def machine_configuration_fields(schema_path: Path) -> list[str]:
    data = yaml.safe_load(schema_path.read_text(encoding="utf-8"))
    # Schema layout: top-level `structs` or nested under protocol keys.
    structs = data.get("structs") or data.get("types") or {}
    if isinstance(structs, list):
        # alternate list form
        for item in structs:
            if isinstance(item, dict) and item.get("name") == "MachineConfiguration":
                return [f["name"] for f in item.get("fields", []) if "name" in f]
        raise SystemExit("MachineConfiguration not found in schema list")
    # Common ProtoEmb layout: dict of name -> {fields: [...]}
    if "MachineConfiguration" in structs:
        fields = structs["MachineConfiguration"].get("fields") or []
        return [f["name"] for f in fields if isinstance(f, dict) and "name" in f]
    # Walk for nested definition
    text = schema_path.read_text(encoding="utf-8")
    # Fallback: parse the MachineConfiguration: block with a simple field scanner
    m = re.search(
        r"MachineConfiguration:\s*\n(?:.*\n)*?(?=^\S|\Z)",
        text,
        re.MULTILINE,
    )
    if not m:
        raise SystemExit("Could not locate MachineConfiguration in schema")
    block = m.group(0)
    return re.findall(r"^\s+-\s+name:\s+(\w+)\s*$", block, re.MULTILINE)


def main() -> int:
    if not SCHEMA.is_file():
        print(f"error: missing schema {SCHEMA}", file=sys.stderr)
        return 2
    if not MAPPING.is_file() or not TYPES.is_file():
        print("error: missing domain mapping/types", file=sys.stderr)
        return 2

    fields = machine_configuration_fields(SCHEMA)
    if not fields:
        print("error: no fields parsed for MachineConfiguration", file=sys.stderr)
        return 1

    mapping_src = MAPPING.read_text(encoding="utf-8")
    types_src = TYPES.read_text(encoding="utf-8")

    # Proto field names must appear in configFromShared / configToShared.
    missing_mapping: list[str] = []
    for name in fields:
        if name == "name":
            # mapped as Name / config.name
            if "config.name" not in mapping_src and "name:" not in mapping_src:
                missing_mapping.append(name)
            continue
        if name not in mapping_src:
            missing_mapping.append(name)

    # Display labels for non-name fields (heuristic: camelCase → present as string key)
    # We only require mapping references; types keys are human labels.
    errors = 0
    if missing_mapping:
        print("FAIL: schema fields missing from domain mapping.ts:")
        for n in missing_mapping:
            print(f"  - {n}")
        errors += 1
    else:
        print(f"OK: all {len(fields)} MachineConfiguration fields referenced in mapping.ts")
        for n in fields:
            print(f"  · {n}")

    # Guard against a half-finished rename: the force-gauge calibration fields
    # have had two generations of naming, and the domain must speak whichever
    # one the schema currently declares. Derived from the schema rather than
    # hardcoded to one generation, so this catches drift in EITHER direction and
    # does not need editing the next time the schema moves.
    generations = {
        "counts-per-force": ["forceGaugeNPerStep", "forceGaugeZeroOffset"],
        "intrinsic load-cell": [
            "loadCellCapacity",
            "loadCellSensitivity",
            "loadCellZeroBalance",
        ],
    }
    live = {g: names for g, names in generations.items() if any(n in fields for n in names)}
    retired = {g: names for g, names in generations.items() if g not in live}

    for gen, names in retired.items():
        hits = sorted(n for n in names if n in mapping_src or n in types_src)
        if hits:
            print(f"FAIL: domain references the retired {gen} naming (schema drift):")
            for n in hits:
                print(f"  - {n}")
            errors += 1

    for gen, names in live.items():
        for n in names:
            if n in fields and n not in mapping_src:
                print(f"FAIL: {n} is in the schema ({gen}) but not in mapping.ts")
                errors += 1

    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
