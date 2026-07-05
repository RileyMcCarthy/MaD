"""Enum sizing, variant indexing, and remap value-table strategy selection."""

import generate as gen
import pytest
from protoemb_testkit import enum, process, schema


@pytest.mark.parametrize("count,bits", [
    (1, 1), (2, 1), (3, 2), (4, 2), (5, 3), (8, 3), (9, 4), (16, 4), (17, 5),
])
def test_compute_enum_bits(count, bits):
    e = {"variants": [f"V{i}" for i in range(count)]}
    assert gen.compute_enum_bits(e) == bits


def test_plain_enum_indices_and_values():
    data = process(schema(enums={"Mode": enum("OFF", "HEAT", "COOL", "AUTO")}))
    e = data["enums"]["Mode"]
    assert e["_bits"] == 2
    assert e["_count"] == 4
    assert not e["_is_remap"]
    # A plain enum's wire value is its declaration index.
    assert [(v["name"], v["index"], v["value"]) for v in e["_variants"]] == [
        ("OFF", 0, 0), ("HEAT", 1, 1), ("COOL", 2, 2), ("AUTO", 3, 3),
    ]


def test_remap_enum_carries_sparse_values():
    fan = enum(
        {"name": "OFF", "value": 0},
        {"name": "LOW", "value": 1},
        {"name": "HIGH", "value": 2},
        {"name": "AUTO", "value": 9},
        remap=True,
    )
    data = process(schema(enums={"FanCmd": fan}))
    e = data["enums"]["FanCmd"]
    assert e["_is_remap"]
    assert e["_bits"] == 2  # 4 variants -> compact 2-bit wire index
    assert e["_max_value"] == 9
    # _variants keep declaration order with their sparse semantic value...
    assert [v["value"] for v in e["_variants"]] == [0, 1, 2, 9]
    # ...and _sorted_variants are ordered by value for binary search.
    assert [v["value"] for v in e["_sorted_variants"]] == [0, 1, 2, 9]


def test_remap_style_dense_array_for_small_span():
    # max_value 9 -> dense array of 10 bytes; not sparse enough to warrant search.
    fan = enum(
        {"name": "OFF", "value": 0}, {"name": "AUTO", "value": 9}, remap=True,
    )
    e = process(schema(enums={"F": fan}))["enums"]["F"]
    assert e["_remap_style"] == "array"


def test_remap_style_search_for_large_sparse_span():
    # 4 values spread across 0..122 (GCode-like): dense array would be 123 bytes
    # and mostly empty -> auto-select binary search.
    g = enum(
        {"name": "RAPID", "value": 0},
        {"name": "MOVE", "value": 1},
        {"name": "DWELL", "value": 4},
        {"name": "END", "value": 122},
        remap=True,
    )
    e = process(schema(enums={"GCode": g}))["enums"]["GCode"]
    assert e["_remap_style"] == "search"


def test_remap_style_explicit_override():
    g = enum(
        {"name": "A", "value": 0}, {"name": "B", "value": 122},
        remap=True, remap_style="array",
    )
    e = process(schema(enums={"G": g}))["enums"]["G"]
    assert e["_remap_style"] == "array"

    g2 = enum(
        {"name": "A", "value": 0}, {"name": "B", "value": 1},
        remap=True, remap_style="search",
    )
    e2 = process(schema(enums={"G": g2}))["enums"]["G"]
    assert e2["_remap_style"] == "search"
