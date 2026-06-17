"""Emitted enum constants. A remap enum's named constants must carry the SEMANTIC
value (so assigning the constant encodes correctly), while the auto-incremented C
`_COUNT` sentinel must stay pinned to the variant count. Plain enums are unchanged
(value == index)."""

import os
import re

import pytest
from protoemb_testkit import CORE_DIR, generate

THERMOSTAT = os.path.normpath(
    os.path.join(CORE_DIR, "..", "examples", "thermostat.yaml"))


def ts_enum_body(ts, name):
    """Extract the `export enum <name> { ... }` body (TS members aren't prefixed,
    and both Mode and FanCmd happen to have an AUTO variant)."""
    m = re.search(rf"export enum {name} \{{(.*?)\}}", ts, re.DOTALL)
    assert m, f"no TS enum {name}"
    return m.group(1)


@pytest.fixture(scope="module")
def gen(tmp_path_factory):
    out = tmp_path_factory.mktemp("enum_const")
    assert generate(THERMOSTAT, "c", out / "c").returncode == 0
    assert generate(THERMOSTAT, "ts", out / "ts").returncode == 0
    return {
        "c": (out / "c" / "thermostat.h").read_text(),
        "ts": (out / "ts" / "thermostat.ts").read_text(),
    }


def test_c_remap_constant_is_semantic_value(gen):
    # FanCmd.AUTO has semantic value 9 (wire index 3) — the constant must be 9.
    assert "THERMOSTAT_FANCMD_AUTO = 9," in gen["c"]
    assert "THERMOSTAT_FANCMD_AUTO = 3," not in gen["c"]


def test_c_remap_count_pinned_to_variant_count(gen):
    # With AUTO = 9, a bare auto-increment sentinel would be 10; it must be pinned.
    assert "THERMOSTAT_FANCMD_COUNT = 4" in gen["c"]


def test_ts_remap_member_is_semantic_value(gen):
    fan = ts_enum_body(gen["ts"], "FanCmd")
    assert "AUTO = 9," in fan
    assert "AUTO = 3," not in fan


def test_plain_enum_constants_unchanged(gen):
    # Mode is a plain enum: value == index, so constants are the declaration order.
    assert "THERMOSTAT_MODE_HEAT = 1," in gen["c"]
    assert "THERMOSTAT_MODE_COUNT = 4" in gen["c"]
    mode = ts_enum_body(gen["ts"], "Mode")
    assert "HEAT = 1," in mode and "AUTO = 3," in mode
