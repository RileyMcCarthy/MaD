"""End-to-end generation through the real CLI: every target emits the expected
files and symbols, output is deterministic, and --prefix is honoured."""

import os

import generate as gen
import pytest
from protoemb_testkit import CORE_DIR, generate

PROTOEMB_ROOT = os.path.normpath(os.path.join(CORE_DIR, ".."))
THERMOSTAT = os.path.join(PROTOEMB_ROOT, "examples", "thermostat.yaml")
MAD_PROTOCOL = os.path.normpath(os.path.join(PROTOEMB_ROOT, "..", "MaDProtocol.yaml"))

TARGETS = ["c", "ts", "rs"]


def read(path):
    with open(path) as f:
        return f.read()


@pytest.mark.parametrize("target", TARGETS)
def test_thermostat_generates_expected_files(tmp_path, target):
    out = tmp_path / target
    r = generate(THERMOSTAT, target, out)
    assert r.returncode == 0, r.stderr

    # The schema sets prefix: Thermostat, so files are named thermostat.*
    expected = [name for _tmpl, name in gen.target_files("thermostat")[target]]
    for name in expected:
        assert (out / name).exists(), f"missing {name}\n{r.stdout}\n{r.stderr}"


def test_c_output_has_codec_symbols(tmp_path):
    out = tmp_path / "c"
    assert generate(THERMOSTAT, "c", out).returncode == 0
    header = read(out / "thermostat.h")
    assert "THERMOSTAT_READING_WIRE_SIZE" in header
    assert "Thermostat_Reading_encode" in header
    assert "Thermostat_Reading_decode" in header
    assert "PROTOCOL_VERSION" in header.upper()


def test_ts_output_has_codec_symbols(tmp_path):
    out = tmp_path / "ts"
    assert generate(THERMOSTAT, "ts", out).returncode == 0
    ts = read(out / "thermostat.ts")
    assert "export function encodeReading" in ts
    assert "export function decodeReading" in ts


def test_rs_output_has_codec_symbols(tmp_path):
    out = tmp_path / "rs"
    assert generate(THERMOSTAT, "rs", out).returncode == 0
    rs = read(out / "thermostat.rs")
    assert "fn encode" in rs and "fn decode" in rs


@pytest.mark.parametrize("target", TARGETS)
def test_generation_is_deterministic(tmp_path, target):
    a, b = tmp_path / "a", tmp_path / "b"
    assert generate(THERMOSTAT, target, a).returncode == 0
    assert generate(THERMOSTAT, target, b).returncode == 0
    for _tmpl, name in gen.target_files("thermostat")[target]:
        assert read(a / name) == read(b / name), f"{name} not reproducible"


def test_custom_prefix_renames_files_and_symbols(tmp_path):
    out = tmp_path / "c"
    r = generate(THERMOSTAT, "c", out, prefix="Widget")
    assert r.returncode == 0, r.stderr
    assert (out / "widget.h").exists()
    assert not (out / "thermostat.h").exists()
    assert "Widget_Reading_encode" in read(out / "widget.h")


@pytest.mark.parametrize("target", TARGETS)
def test_mad_protocol_generates(tmp_path, target):
    if not os.path.exists(MAD_PROTOCOL):
        pytest.skip("MaDProtocol.yaml not present (library split out)")
    r = generate(MAD_PROTOCOL, target, tmp_path / target)
    assert r.returncode == 0, r.stderr
    assert any((tmp_path / target).iterdir())


def test_invalid_schema_exits_nonzero(tmp_path):
    bad = tmp_path / "bad.yaml"
    bad.write_text(
        "structs:\n"
        "  S:\n"
        "    fields:\n"
        "      - { name: x, type: int8, min: -200, max: 0 }\n"  # below int8 range
    )
    r = generate(bad, "c", tmp_path / "out")
    assert r.returncode != 0
    assert "int8 minimum" in r.stderr
