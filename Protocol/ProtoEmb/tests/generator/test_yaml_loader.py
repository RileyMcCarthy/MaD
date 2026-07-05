"""The schema-safe YAML loader. Stock PyYAML (YAML 1.1) coerces OFF/ON/YES/NO to
booleans, which would silently mangle enum-variant names like `OFF`. load_yaml
must keep those as strings while still parsing real true/false as booleans."""

import generate as gen
import pytest


def write(tmp_path, text):
    p = tmp_path / "s.yaml"
    p.write_text(text)
    return p


@pytest.mark.parametrize("token", ["OFF", "ON", "YES", "NO", "On", "Off", "Yes", "No"])
def test_yaml_keywords_stay_strings(tmp_path, token):
    data = gen.load_yaml(write(tmp_path, f"variants: [{token}, OTHER]\n"))
    assert data["variants"][0] == token
    assert isinstance(data["variants"][0], str)


@pytest.mark.parametrize("token,expected", [
    ("true", True), ("false", False), ("True", True), ("False", False),
    ("TRUE", True), ("FALSE", False),
])
def test_real_booleans_still_parse(tmp_path, token, expected):
    data = gen.load_yaml(write(tmp_path, f"flag: {token}\n"))
    assert data["flag"] is expected


def test_off_enum_variant_survives_processing(tmp_path):
    # End-to-end: an OFF/ON enum must keep its names through schema processing.
    yaml_text = (
        "prefix: Demo\n"
        "enums:\n"
        "  Power:\n"
        "    variants: [OFF, ON]\n"
    )
    schema = gen.load_yaml(write(tmp_path, yaml_text))
    data = gen.process_schema(schema, "Demo")
    names = [v["name"] for v in data["enums"]["Power"]["_variants"]]
    assert names == ["OFF", "ON"]
