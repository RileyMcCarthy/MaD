#!/usr/bin/env python3
"""Tests for check_protocol_compat.py.

Each test writes a small base schema and a changed copy, then asks whether the
change may merge. Run from the repo root:
  python3 -m unittest discover -s Protocol/scripts -p 'test_*.py'
"""

from __future__ import annotations

import sys
import tempfile
import textwrap
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import check_protocol_compat as compat  # noqa: E402 -- the module under test, beside this file

BASE = """
protocol_version: {version}
nodes: [ui, madcore]
defaults: {{ encoding: packed }}
enums:
  Mode:
    variants: [{mode_variants}]
structs:
  State:
    encoding: packed
    fields:
{state_fields}
  Config:
    encoding: aligned
    fields:
{config_fields}
  DeviceInfo:
    encoding: aligned
    fields:
{info_fields}
messages:
  state:
    tx_node: madcore
    period_ms: 100
    command_id: 1
    response: State
  config:
    tx_node: ui
    command_id: {config_id}
    response: Config
  config_write:
    tx_node: ui
    command_id: 0
    request: Config
  device_info:
    tx_node: ui
    command_id: 5
    response: DeviceInfo
{extra_messages}
"""

DEFAULTS = {
    "version": 2,
    "mode_variants": "IDLE, RUN, STOP",
    "state_fields": """
      - { name: mode, type: Mode }
      - { name: running, type: bool }""",
    "config_fields": """
      - { name: speed, type: uint32, scale: 1000, raw_storage: true }
      - { name: name, type: string, max_length: 8 }""",
    "info_fields": """
      - { name: protocolVersion, type: uint32 }""",
    "config_id": 2,
    "extra_messages": "",
}


def schema(**changes):
    """The base schema text with some parts replaced."""
    parts = {**DEFAULTS, **changes}
    return textwrap.dedent(BASE).format(**parts)


class CompatTest(unittest.TestCase):
    """One change to the base schema per test."""

    def report(self, **changes):
        """Compare the base schema against one with `changes`."""
        with tempfile.TemporaryDirectory() as tmp:
            old, new = Path(tmp) / "old.yaml", Path(tmp) / "new.yaml"
            old.write_text(schema())
            new.write_text(schema(**changes))
            return compat.compare(old, new)

    def assert_breaking(self, report, text):
        """The change is wire-incompatible, named by `text`, and refused at the same version."""
        self.assertTrue(any(text in p for p in report.breaking), report.breaking)
        self.assertFalse(report.ok)

    def test_unchanged_schema_is_compatible(self):
        report = self.report()
        self.assertEqual((report.breaking, report.fatal), ([], []))
        self.assertTrue(report.ok)

    def test_appended_field_needs_a_bump(self):
        fields = DEFAULTS["config_fields"] + "\n      - { name: extra, type: uint8 }"
        self.assert_breaking(self.report(config_fields=fields), "fields appended: extra")

    def test_appended_field_with_bump_is_allowed(self):
        fields = DEFAULTS["config_fields"] + "\n      - { name: extra, type: uint8 }"
        report = self.report(config_fields=fields, version=3)
        self.assertTrue(report.breaking)
        self.assertTrue(report.ok)

    def test_removed_field_needs_a_bump(self):
        fields = "\n      - { name: speed, type: uint32, scale: 1000, raw_storage: true }"
        self.assert_breaking(self.report(config_fields=fields), "fields removed from the end: name")

    def test_retyped_field_needs_a_bump(self):
        fields = DEFAULTS["config_fields"].replace("type: uint32", "type: int32")
        self.assert_breaking(self.report(config_fields=fields), "type uint32 -> int32")

    def test_rescaled_field_needs_a_bump(self):
        fields = DEFAULTS["config_fields"].replace("scale: 1000", "scale: 100")
        self.assert_breaking(self.report(config_fields=fields), "scale 1000 -> 100")

    def test_longer_string_needs_a_bump(self):
        fields = DEFAULTS["config_fields"].replace("max_length: 8", "max_length: 12")
        self.assert_breaking(self.report(config_fields=fields), "bytes 8 -> 12")

    def test_reordered_fields_need_a_bump(self):
        fields = """
      - { name: name, type: string, max_length: 8 }
      - { name: speed, type: uint32, scale: 1000, raw_storage: true }"""
        self.assert_breaking(self.report(config_fields=fields), "type uint32 -> string")

    def test_renamed_field_is_compatible(self):
        fields = DEFAULTS["config_fields"].replace("name: speed", "name: velocity")
        self.assertTrue(self.report(config_fields=fields).ok)

    def test_moved_command_id_needs_a_bump(self):
        self.assert_breaking(self.report(config_id=4), "message config (READ 2): moved to READ 4")

    def test_new_message_is_compatible(self):
        extra = """  zero:
    tx_node: ui
    command_id: 7
    request: none"""
        self.assertTrue(self.report(extra_messages=extra).ok)

    def test_enum_variant_appended_within_width_is_compatible(self):
        self.assertTrue(self.report(mode_variants="IDLE, RUN, STOP, PAUSE").ok)

    def test_enum_variant_past_width_needs_a_bump(self):
        report = self.report(mode_variants="IDLE, RUN, STOP, PAUSE, FAULT")
        self.assert_breaking(report, "bits 2 -> 3")

    def test_enum_variants_reordered_need_a_bump(self):
        self.assert_breaking(self.report(mode_variants="RUN, IDLE, STOP"), "variants removed, renamed or reordered")

    def test_version_going_down_is_refused(self):
        report = self.report(version=1)
        self.assertIn("protocol_version went down: 2 -> 1", report.fatal)
        self.assertFalse(report.ok)

    def test_handshake_may_grow_without_a_bump(self):
        fields = DEFAULTS["info_fields"] + "\n      - { name: boardRevision, type: uint8 }"
        report = self.report(info_fields=fields)
        self.assertEqual((report.breaking, report.fatal), ([], []))

    def test_handshake_change_is_refused_even_with_a_bump(self):
        fields = DEFAULTS["info_fields"].replace("uint32", "uint16")
        report = self.report(info_fields=fields, version=3)
        self.assertTrue(any("frozen compatibility handshake" in p for p in report.fatal), report.fatal)
        self.assertFalse(report.ok)

    def test_handshake_moved_is_refused_even_with_a_bump(self):
        text = schema(version=3).replace("command_id: 5", "command_id: 6")
        with tempfile.TemporaryDirectory() as tmp:
            old, new = Path(tmp) / "old.yaml", Path(tmp) / "new.yaml"
            old.write_text(schema())
            new.write_text(text)
            report = compat.compare(old, new)
        self.assertIn("message device_info (READ 5): moved to READ 6", report.fatal)

    def test_real_schema_matches_itself(self):
        report = compat.compare(compat.SCHEMA, compat.SCHEMA)
        self.assertTrue(report.ok)
        self.assertEqual(report.breaking, [])


if __name__ == "__main__":
    unittest.main()
