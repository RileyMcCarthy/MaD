"""Cross-language wire conformance for the binary-search remap path.

The thermostat example's FanCmd is small and dense, so it uses the generator's
dense value<->wire array. This schema's GCode enum is sparse over 0..122, forcing
the *binary-search* strategy. The suite proves that strategy — and a union over a
remap enum — encodes byte-identically across C / Rust / TypeScript, including the
values where the semantic value (e.g. 122) differs from the compact wire index.
"""

import os

import pytest
from _harness import pivot_by_label, run_all

SCHEMA = os.path.join(os.path.dirname(__file__), "schemas", "search_remap.yaml")
PREFIX = "Gcodes"

VECTORS = [
    # Command: a search-remap enum field at every variant + arg extremes.
    ("cmd_rapid", "Command", {"code": "RAPID", "arg": 0}),
    ("cmd_move", "Command", {"code": "MOVE", "arg": -1000}),
    ("cmd_dwell", "Command", {"code": "DWELL", "arg": 1000}),
    ("cmd_home", "Command", {"code": "HOME", "arg": -250}),
    ("cmd_end", "Command", {"code": "END", "arg": 777}),  # value 122 != wire index 4

    # Packet: a union whose variants are a remap enum and a raw uint16.
    ("pkt_gcode_rapid", "Packet", {"seq": 0, "op": ("gcode", "RAPID")}),
    ("pkt_gcode_end", "Packet", {"seq": 200, "op": ("gcode", "END")}),
    ("pkt_raw_zero", "Packet", {"seq": 1, "op": ("raw", 0)}),
    ("pkt_raw_max", "Packet", {"seq": 255, "op": ("raw", 65535)}),
    ("pkt_raw_mid", "Packet", {"seq": 42, "op": ("raw", 12345)}),
]


@pytest.fixture(scope="module")
def outputs(tmp_path_factory):
    work = str(tmp_path_factory.mktemp("search_remap_conf"))
    return run_all(SCHEMA, PREFIX, VECTORS, work)


def test_uses_search_remap_style():
    # Guards the premise: if generation tuning makes GCode dense, this schema no
    # longer covers the search path and should be made sparser.
    import generate as gen
    data = gen.process_schema(gen.load_yaml(SCHEMA), PREFIX)
    assert data["enums"]["GCode"]["_remap_style"] == "search"


def test_at_least_two_languages_available(outputs):
    assert len(outputs) >= 2, f"need >=2 toolchains, ran: {sorted(outputs)}"


def test_no_roundtrip_mismatch(outputs):
    for lang, lines in outputs.items():
        bad = [ln for ln in lines if ln.endswith("ROUNDTRIP_MISMATCH")]
        assert not bad, f"{lang} round-trip failures: {bad}"


def test_wire_is_byte_identical_across_languages(outputs):
    langs = sorted(outputs)
    mismatches = []
    for label, per_lang in sorted(pivot_by_label(outputs).items()):
        if len(set(per_lang.values())) != 1:
            mismatches.append(f"{label}: " + ", ".join(
                f"{lg}={per_lang[lg]}" for lg in langs if lg in per_lang))
    assert not mismatches, "wire divergence:\n" + "\n".join(mismatches)
