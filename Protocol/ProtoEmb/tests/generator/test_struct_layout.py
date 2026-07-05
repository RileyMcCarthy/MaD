"""Struct layout: packed bit offsets, aligned byte offsets, wire sizes,
optional presence flags, fixed-count arrays, and nested-struct inlining."""

import generate as gen
import pytest
from protoemb_testkit import enum, field, process, schema, struct


def fields_by_name(struct_def):
    return {f["name"]: f for f in struct_def["fields"]}


# ── Packed scalars ───────────────────────────────────────────────────────────

def test_packed_offsets_and_wire_size():
    reading = struct(
        field("temp", "int16", min=-40, max=85, scale=10, unit="C"),  # 11 bits
        field("humidity", "uint8", min=0, max=100),                   # 7 bits
    )
    s = process(schema(structs={"Reading": reading}))["structs"]["Reading"]
    f = fields_by_name(s)
    assert s["_is_packed"]
    assert f["temp"]["_bits"] == 11
    assert f["temp"]["_bit_offset"] == 0
    assert f["humidity"]["_bits"] == 7
    assert f["humidity"]["_bit_offset"] == 11
    assert s["_total_bits"] == 18
    assert s["_wire_size"] == 3  # ceil(18 / 8)
    assert not s["_has_nested"]


def test_packed_min_max_wire_steps():
    reading = struct(field("temp", "int16", min=-40, max=85, scale=10))
    s = process(schema(structs={"R": reading}))["structs"]["R"]
    f = fields_by_name(s)["temp"]
    assert f["_min_wire"] == -400 and f["_max_wire"] == 850
    assert f["_scale"] == 10 and f["_has_scale"]


def test_scale_one_has_no_scale_flag():
    s = process(schema(structs={"R": struct(field("x", "uint8"))}))["structs"]["R"]
    assert fields_by_name(s)["x"]["_has_scale"] is False


# ── Optional presence flags ──────────────────────────────────────────────────

def test_packed_optional_prepends_one_flag_bit():
    s = struct(
        field("a", "uint8", min=0, max=7),                 # 3 bits
        field("b", "bool", optional=True),                 # 1 flag + 1 value
    )
    sd = process(schema(structs={"S": s}))["structs"]["S"]
    f = fields_by_name(sd)
    assert f["b"]["_is_optional"]
    assert f["b"]["_bits"] == 2                             # flag + value
    assert f["b"]["_bit_offset"] == 3                       # flag bit
    assert f["b"]["_value_bit_offset"] == 4                 # value after flag
    assert sd["_total_bits"] == 5


def test_aligned_optional_prepends_one_flag_byte():
    s = struct(
        field("a", "uint8"),
        field("b", "uint16", optional=True),
        encoding="aligned",
    )
    sd = process(schema(structs={"S": s}))["structs"]["S"]
    f = fields_by_name(sd)
    assert f["b"]["_byte_size"] == 3                        # 1 flag + 2 value
    assert f["b"]["_byte_offset"] == 1
    assert f["b"]["_value_byte_offset"] == 2
    assert sd["_wire_size"] == 4


# ── Fixed-count arrays ───────────────────────────────────────────────────────

def test_aligned_array_multiplies_element_size():
    s = struct(
        field("name", "string", max_length=16),
        field("slots", "int16", count=8, scale=10),
        field("active", "bool"),
        encoding="aligned",
    )
    sd = process(schema(structs={"Sch": s}))["structs"]["Sch"]
    f = fields_by_name(sd)
    assert f["name"]["_byte_size"] == 16
    assert f["slots"]["_is_array"] and f["slots"]["_array_len"] == 8
    assert f["slots"]["_byte_size"] == 16                   # 8 * int16
    assert f["slots"]["_byte_offset"] == 16
    assert f["active"]["_byte_offset"] == 32
    assert sd["_wire_size"] == 33


def test_packed_array_multiplies_bits():
    s = struct(field("xs", "uint8", count=4, min=0, max=15))  # 4 bits each
    sd = process(schema(structs={"S": s}))["structs"]["S"]
    assert fields_by_name(sd)["xs"]["_bits"] == 16             # 4 * 4


# ── Aligned scalar sizes ─────────────────────────────────────────────────────

@pytest.mark.parametrize("ftype,size", [
    ("int8", 1), ("uint8", 1), ("int16", 2), ("uint16", 2),
    ("int32", 4), ("uint32", 4), ("bool", 1),
])
def test_aligned_scalar_byte_sizes(ftype, size):
    s = struct(field("x", ftype), encoding="aligned")
    sd = process(schema(structs={"S": s}))["structs"]["S"]
    assert fields_by_name(sd)["x"]["_byte_size"] == size


def test_aligned_enum_is_one_byte():
    s = struct(field("m", "Mode"), encoding="aligned")
    sd = process(schema(
        enums={"Mode": enum("A", "B", "C")},
        structs={"S": s},
    ))["structs"]["S"]
    assert fields_by_name(sd)["m"]["_byte_size"] == 1


# ── Nested structs ───────────────────────────────────────────────────────────

def test_nested_struct_inlines_child_and_marks_pack_helper():
    inner = struct(field("temp", "int16", min=-40, max=85, scale=10),  # 11
                   field("humidity", "uint8", min=0, max=100))         # 7  -> 18 bits
    outer = struct(field("id", "uint8", min=0, max=31),                # 5
                   field("reading", "Reading"))
    data = process(schema(structs={"Reading": inner, "Outer": outer}))
    child = data["structs"]["Reading"]
    parent = data["structs"]["Outer"]
    assert child["_needs_pack_helper"] is True
    assert parent["_has_nested"] is True
    rf = fields_by_name(parent)["reading"]
    assert rf["_is_struct"] and rf["_elem_bits"] == child["_total_bits"] == 18
    # parent = 5 (id) + 18 (nested) = 23 bits -> 3 bytes
    assert parent["_total_bits"] == 23 and parent["_wire_size"] == 3


def test_nested_encoding_mismatch_is_rejected():
    inner = struct(field("x", "uint8"), encoding="aligned")
    outer = struct(field("c", "Inner"), encoding="packed")  # packed parent, aligned child
    with pytest.raises(SystemExit):
        process(schema(structs={"Inner": inner, "Outer": outer}))
