"""resolve_prefix: CLI > schema `prefix` > schema `library_name` > default."""

import generate as gen
import pytest


def test_default_prefix():
    assert gen.resolve_prefix({}) == "ProtoEmb"


def test_schema_prefix_key():
    assert gen.resolve_prefix({"prefix": "Thermostat"}) == "Thermostat"


def test_schema_library_name_key():
    assert gen.resolve_prefix({"library_name": "Widget"}) == "Widget"


def test_prefix_key_beats_library_name():
    assert gen.resolve_prefix({"prefix": "A", "library_name": "B"}) == "A"


def test_cli_prefix_beats_schema():
    assert gen.resolve_prefix({"prefix": "Schema"}, "Cli") == "Cli"


@pytest.mark.parametrize("bad", ["9lives", "has space", "has-dash", "a.b"])
def test_invalid_prefix_rejected(bad):
    with pytest.raises(SystemExit):
        gen.resolve_prefix({"prefix": bad})


def test_empty_prefix_falls_back_to_default():
    # An empty string is falsy, so it is treated as "unset", not invalid.
    assert gen.resolve_prefix({"prefix": ""}) == "ProtoEmb"


def test_non_string_prefix_rejected():
    with pytest.raises(SystemExit):
        gen.resolve_prefix({"prefix": 42})
