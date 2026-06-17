"""compute_field_bits: bit width chosen for a packed struct field."""

import generate as gen
import pytest

ENUMS = {"Mode": {"variants": ["A", "B", "C"]}}  # 3 variants -> 2 bits


def bits(f):
    return gen.compute_field_bits(f, ENUMS)


def test_bool_is_one_bit():
    assert bits({"type": "bool"}) == 1


def test_enum_uses_enum_bits():
    assert bits({"type": "Mode"}) == 2


def test_string_default_length():
    assert bits({"type": "string"}) == 16 * 8


def test_string_explicit_length():
    assert bits({"type": "string", "max_length": 4}) == 4 * 8


def test_explicit_bits_override():
    assert bits({"type": "uint16", "bits": 5}) == 5


@pytest.mark.parametrize("ftype,expect", [
    ("int8", 8), ("uint8", 8), ("int16", 16), ("uint16", 16),
    ("int32", 32), ("uint32", 32), ("float", 32),
    ("int64", 64), ("uint64", 64),
])
def test_fallback_type_sizes(ftype, expect):
    assert bits({"type": ftype}) == expect


def test_min_max_range_packs_tightly():
    # 0..100 -> 101 values -> ceil(log2(101)) = 7 bits.
    assert bits({"type": "uint8", "min": 0, "max": 100}) == 7


def test_min_max_with_scale():
    # -40..85 C at scale 10 -> wire range (85 - -40)*10 + 1 = 1251 -> 11 bits.
    assert bits({"type": "int16", "min": -40, "max": 85, "scale": 10}) == 11


def test_degenerate_range_is_one_bit():
    # min == max collapses to a single value -> 1 bit (not 0).
    assert bits({"type": "uint8", "min": 5, "max": 5}) == 1


def test_explicit_bits_beats_min_max():
    assert bits({"type": "uint8", "min": 0, "max": 100, "bits": 3}) == 3
