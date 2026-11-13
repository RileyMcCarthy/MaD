#!/usr/bin/env python3
"""Fail when MaDProtocol.yaml changes the wire without a protocol_version bump.

The firmware reports protocol_version in the device_info handshake, and MaD
Control drives only firmware whose number equals its own. That only works if
the number moves with every wire-incompatible change, so this compares the
schema against a base (normally main) and fails when an existing message's
wire layout changed while protocol_version stayed put.

Layouts come from the ProtoEmb generator's own sizing (process_schema), so a
change counts exactly when it moves bits on the wire:
  breaking   a field removed, reordered, retyped or resized (string length,
             min/max/scale/bits, array count, optional); a field appended to a
             struct (every struct has a fixed wire size); an enum variant
             removed, renamed or reordered, or one appended past a bit width;
             a message removed or moved to another command id, direction or
             payload.
  compatible a new message; a field or variant renamed; an enum variant
             appended within its width; documentation keys.

The handshake itself (the device_info message and its DeviceInfo reply) is
frozen: every app must be able to read every firmware's answer, so it may
only grow by appending, and nothing else about it may change even with a bump.

Usage (repo root):
  python3 Protocol/scripts/check_protocol_compat.py                  # vs origin/main
  python3 Protocol/scripts/check_protocol_compat.py --base FETCH_HEAD
  python3 Protocol/scripts/check_protocol_compat.py --old a.yaml --new b.yaml

Exit status: 0 compatible (or covered by a bump), 1 incompatible, 2 usage error.
"""

from __future__ import annotations

import argparse
import copy
import json
import os
import subprocess
import sys
import tempfile
from dataclasses import dataclass, field
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SCHEMA = ROOT / "Protocol" / "MaDProtocol.yaml"
SCHEMA_IN_REPO = "Protocol/MaDProtocol.yaml"
sys.path.insert(0, str(ROOT / "Protocol" / "ProtoEmb" / "core"))

import generate  # noqa: E402 -- the ProtoEmb generator, from the submodule path above

# The compatibility handshake (MaDProtocol.yaml marks both FROZEN).
HANDSHAKE_MESSAGE = "device_info"


@dataclass
class Report:
    """The outcome of comparing two schemas."""

    old_version: int
    new_version: int
    # Wire changes to existing messages; allowed only with a version bump.
    breaking: list = field(default_factory=list)
    # Changes never allowed: the frozen handshake, or a version going down.
    fatal: list = field(default_factory=list)

    @property
    def ok(self) -> bool:
        """True when the change may merge."""
        return not self.fatal and (not self.breaking or self.new_version > self.old_version)


def load(path):
    """The schema at `path`, enriched with the generator's wire sizing."""
    return generate.process_schema(generate.load_yaml(path))


def message_key(msg):
    """What identifies a message on the wire: its frame and command id."""
    if msg["_command_id"] is None:
        return ("async", msg["_name"])
    return (msg["_command_frame"], msg["_command_id"])


def describe_key(key):
    """A message key as text, e.g. `READ 5`."""
    kind, ident = key
    return f"async {ident}" if kind == "async" else f"{kind.upper()} {ident}"


def enum_variants(data, name):
    """An enum's variants as (name, value) pairs, in wire order."""
    return [(v["name"], v["value"]) for v in data["enums"][name]["_variants"]]


def field_sizing(f):
    """What a field occupies on the wire, apart from its type."""
    size = {"bits": f["_bits"]} if "_bits" in f else {"bytes": f["_byte_size"]}
    size.update(count=f["_array_len"], optional=f["_is_optional"], scale=f["_scale"], min=f["_min"], max=f["_max"])
    return size


def union_signature(data, name):
    """A tagged union's whole layout, for an equality check (MaD uses none)."""
    u = copy.deepcopy(data["unions"][name])
    keep = ("type", "_elem_bits", "_elem_byte_size", "_scale", "_min", "_max")
    variants = [{k: v.get(k) for k in keep} for v in u["variants"]]
    return json.dumps([u["_encoding"], u.get("_total_bits"), u["_wire_size"], variants], sort_keys=True)


def compare_field(old_data, new_data, a, b, where):
    """Problems with field `b` replacing field `a` at the same position."""
    label = where if a["name"] == b["name"] else f"{where} (renamed {b['name']})"
    ta, tb = a["type"], b["type"]
    kinds = ("enum" if a["_is_enum"] else "struct" if a["_is_struct"] else "union" if a["_is_union"] else ta,
             "enum" if b["_is_enum"] else "struct" if b["_is_struct"] else "union" if b["_is_union"] else tb)
    if kinds[0] != kinds[1]:
        return [f"{label}: type {ta} -> {tb}"]
    problems = []
    sa, sb = field_sizing(a), field_sizing(b)
    for key in sa:
        if sa.get(key) != sb.get(key):
            problems.append(f"{label}: {key} {sa.get(key)} -> {sb.get(key)}")
    if kinds[0] == "enum":
        va, vb = enum_variants(old_data, ta), enum_variants(new_data, tb)
        if vb[: len(va)] != va:
            problems.append(f"{label}: enum {ta} variants removed, renamed or reordered ({va} -> {vb})")
    elif kinds[0] == "struct":
        nested, appended = compare_struct(old_data, new_data, ta, tb, label)
        problems += nested + appended
    elif kinds[0] == "union" and union_signature(old_data, ta) != union_signature(new_data, tb):
        problems.append(f"{label}: union {ta} layout changed")
    return problems


def compare_struct(old_data, new_data, old_name, new_name, where):
    """(changes to existing fields, fields appended) between two structs."""
    a, b = old_data["structs"][old_name], new_data["structs"][new_name]
    if a["_encoding"] != b["_encoding"]:
        return [f"{where}: encoding {a['_encoding']} -> {b['_encoding']}"], []
    problems = []
    for fa, fb in zip(a["fields"], b["fields"]):
        problems += compare_field(old_data, new_data, fa, fb, f"{where}.{fa['name']}")
    old_fields, new_fields = a["fields"], b["fields"]
    if len(new_fields) < len(old_fields):
        removed = ", ".join(f["name"] for f in old_fields[len(new_fields):])
        problems.append(f"{where}: fields removed from the end: {removed}")
    appended = []
    if len(new_fields) > len(old_fields):
        added = ", ".join(f["name"] for f in new_fields[len(old_fields):])
        appended.append(f"{where}: fields appended: {added} (wire size {a['_wire_size']} -> {b['_wire_size']} bytes)")
    return problems, appended


def compare_payload(old_data, new_data, a, b, side, where):
    """(changes, appends) between two messages' request or response payloads."""
    struct_a, struct_b = a[f"_{side}_name"], b[f"_{side}_name"]
    if side == "request" and a["_request_scalar"] != b["_request_scalar"]:
        return [f"{where}: request {a['_request_scalar'] or struct_a} -> {b['_request_scalar'] or struct_b}"], []
    if struct_a is None and struct_b is None:
        return [], []
    if struct_a is None or struct_b is None:
        return [f"{where}: {side} {struct_a} -> {struct_b}"], []
    return compare_struct(old_data, new_data, struct_a, struct_b, f"{where} {side} {struct_a}")


def compare(old_path, new_path) -> Report:
    """Compare the schema at `new_path` against the one at `old_path`."""
    old_data, new_data = load(old_path), load(new_path)
    report = Report(int(old_data["protocol_version"]), int(new_data["protocol_version"]))
    if report.new_version < report.old_version:
        report.fatal.append(f"protocol_version went down: {report.old_version} -> {report.new_version}")

    new_by_key = {message_key(m): m for m in new_data["messages"].values()}
    for name, a in old_data["messages"].items():
        key = message_key(a)
        where = f"message {name} ({describe_key(key)})"
        handshake = name == HANDSHAKE_MESSAGE
        b = new_by_key.get(key)
        if b is None:
            moved = new_data["messages"].get(name)
            change = f"moved to {describe_key(message_key(moved))}" if moved else "removed"
            (report.fatal if handshake else report.breaking).append(f"{where}: {change}")
            continue
        problems, appended = [], []
        sender_a, sender_b = a.get("tx_node", ""), b.get("tx_node", "")
        if sender_a != sender_b:
            problems.append(f"{where}: sent by {sender_a} -> {sender_b}")
        for side in ("request", "response"):
            changed, grown = compare_payload(old_data, new_data, a, b, side, where)
            problems += changed
            appended += grown
        if handshake:
            # Frozen: every app zero-fills a shorter reply, so appending is the one allowed change.
            report.fatal += [f"{p} (the frozen compatibility handshake)" for p in problems]
        else:
            report.breaking += problems + appended
    return report


def schema_at(ref, workdir):
    """Write MaDProtocol.yaml as of git `ref` to a file in `workdir`; None if it did not exist."""
    out = subprocess.run(
        ["git", "-C", str(ROOT), "show", f"{ref}:{SCHEMA_IN_REPO}"],
        capture_output=True,
        text=True,
    )
    if out.returncode != 0:
        if "exists on disk, but not in" in out.stderr or "does not exist in" in out.stderr:
            return None
        raise SystemExit(f"error: cannot read {SCHEMA_IN_REPO} at {ref}: {out.stderr.strip()}")
    path = Path(workdir) / "base.yaml"
    path.write_text(out.stdout)
    return path


def emit(level, message):
    """Print a finding, as a GitHub annotation when running in Actions."""
    if os.environ.get("GITHUB_ACTIONS") == "true" and level == "error":
        print(f"::error file={SCHEMA_IN_REPO}::{message}")
    else:
        print(f"{level}: {message}")


def main():
    """Command line entry point."""
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--base", default="origin/main", help="git ref to compare against (default origin/main)")
    parser.add_argument("--old", type=Path, help="compare this schema file instead of --base")
    parser.add_argument("--new", type=Path, default=SCHEMA, help="the changed schema (default the working tree's)")
    args = parser.parse_args()

    with tempfile.TemporaryDirectory() as tmp:
        old = args.old or schema_at(args.base, tmp)
        if old is None:
            print(f"{SCHEMA_IN_REPO} does not exist at {args.base}; nothing to compare.")
            return 0
        report = compare(old, args.new)

    for problem in report.fatal:
        emit("error", problem)
    if report.breaking and report.new_version > report.old_version:
        print(f"protocol_version {report.old_version} -> {report.new_version} covers these wire changes:")
        for problem in report.breaking:
            print(f"  {problem}")
    elif report.breaking:
        for problem in report.breaking:
            emit("error", problem)
        emit(
            "error",
            f"wire-incompatible change without a protocol_version bump: set protocol_version: "
            f"{report.old_version + 1} in {SCHEMA_IN_REPO}, and release firmware before MaD Control",
        )
    if report.ok:
        print(f"Protocol compatible with {args.old or args.base} (protocol_version {report.new_version}).")
    return 0 if report.ok else 1


if __name__ == "__main__":
    sys.exit(main())
