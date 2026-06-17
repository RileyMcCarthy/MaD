"""Reusable helpers for the ProtoEmb generator tests.

Two layers:

* **Schema builders** (`enum`, `field`, `struct`, `union`, `message`, `schema`)
  produce fresh plain-dict schemas. They are intentionally thin — the tests want
  to assert on exactly what they pass in, and `process_schema` mutates its input,
  so every test must start from a fresh dict.
* **Pipeline wrappers** (`process`, `validate`, `expect_exit`, `generate`) drive
  `generate.py` the way `main()` does, so unit tests exercise the real code path.
"""

from __future__ import annotations

import copy
import os
import subprocess
import sys

import generate as gen

CORE_DIR = os.path.dirname(gen.__file__)
TEMPLATES_DIR = os.path.join(CORE_DIR, "templates")
GENERATE_PY = os.path.join(CORE_DIR, "generate.py")


# ── Schema builders ──────────────────────────────────────────────────────────

def enum(*variants, remap=False, **extra):
    """A plain or remap enum.

    Plain:  enum("OFF", "ON")
    Remap:  enum({"name": "OFF", "value": 0}, {"name": "AUTO", "value": 9},
                 remap=True)
    """
    d = {"variants": list(variants)}
    if remap:
        d["remap"] = True
    d.update(extra)
    return d


def field(name, type, **extra):
    """A single struct field; extra kwargs map straight onto the field dict."""
    d = {"name": name, "type": type}
    d.update(extra)
    return d


def struct(*fields, encoding="packed", **extra):
    d = {"encoding": encoding, "fields": list(fields)}
    d.update(extra)
    return d


def union(*variants, encoding="packed", **extra):
    d = {"encoding": encoding, "variants": list(variants)}
    d.update(extra)
    return d


def message(tx_node="dev", **extra):
    d = {"tx_node": tx_node}
    d.update(extra)
    return d


def schema(*, prefix=None, enums=None, structs=None, unions=None, messages=None,
           nodes=None, defaults=None, protocol_version=1, **extra):
    """Assemble a full schema dict. Only non-empty sections are included."""
    s = {"protocol_version": protocol_version}
    if prefix is not None:
        s["prefix"] = prefix
    if defaults is not None:
        s["defaults"] = defaults
    if nodes is not None:
        s["nodes"] = nodes
    if enums:
        s["enums"] = enums
    if structs:
        s["structs"] = structs
    if unions:
        s["unions"] = unions
    if messages:
        s["messages"] = messages
    s.update(extra)
    return s


# ── Pipeline wrappers ────────────────────────────────────────────────────────

def process(s, prefix="Test"):
    """Run `process_schema` on a copy, returning the enriched template data."""
    return gen.process_schema(copy.deepcopy(s), prefix)


def validate(s, prefix="Test", nodes=None, generator_config=None):
    """Mirror `main()`: process, attach nodes/config, then `validate_schema`.

    Returns the processed `data` so callers can assert on enriched fields too.
    """
    raw = copy.deepcopy(s)
    data = gen.process_schema(raw, prefix)
    data["nodes"] = nodes if nodes is not None else raw.get("nodes", [])
    data["generator_config"] = generator_config or {}
    gen.validate_schema(data)
    return data


def expect_exit(fn, *args, **kwargs):
    """Call `fn`, asserting it raises `SystemExit`; return the message string."""
    try:
        fn(*args, **kwargs)
    except SystemExit as e:
        return str(e.code)
    raise AssertionError(f"expected SystemExit from {getattr(fn, '__name__', fn)!r}")


def generate(schema_path, target, out_dir, prefix=None, config=None):
    """Invoke generate.py as a subprocess (the real CLI path). Returns CompletedProcess."""
    cmd = [
        sys.executable, GENERATE_PY,
        "--schema", str(schema_path),
        "--target", target,
        "--output", str(out_dir),
        "--templates", TEMPLATES_DIR,
    ]
    if prefix:
        cmd += ["--prefix", prefix]
    if config:
        cmd += ["--config", str(config)]
    return subprocess.run(cmd, capture_output=True, text=True)
