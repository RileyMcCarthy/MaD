"""topo_sort_types: a referenced struct/union must be emitted before its users,
so nested children sized and declared ahead of their parents."""

import generate as gen
import pytest
from protoemb_testkit import field, process, schema, struct, union


def test_referenced_struct_precedes_user():
    structs = {
        "Outer": {"fields": [{"type": "Inner"}, {"type": "uint8"}]},
        "Inner": {"fields": [{"type": "uint8"}]},
    }
    order = gen.topo_sort_types(structs, {})
    names = [n for _k, n in order]
    assert names.index("Inner") < names.index("Outer")


def test_no_references_preserves_definition_order():
    structs = {
        "A": {"fields": [{"type": "uint8"}]},
        "B": {"fields": [{"type": "uint8"}]},
    }
    unions = {"U": {"variants": [{"type": "uint8"}]}}
    order = gen.topo_sort_types(structs, unions)
    # structs in definition order, then unions
    assert order == [("struct", "A"), ("struct", "B"), ("union", "U")]


def test_struct_referencing_union_orders_union_first():
    structs = {"Datum": {"fields": [{"type": "Sample"}, {"type": "uint8"}]}}
    unions = {"Sample": {"variants": [{"type": "uint8"}]}}
    order = gen.topo_sort_types(structs, unions)
    names = [n for _k, n in order]
    assert names.index("Sample") < names.index("Datum")


def test_cycle_is_rejected():
    structs = {
        "A": {"fields": [{"type": "B"}]},
        "B": {"fields": [{"type": "A"}]},
    }
    with pytest.raises(SystemExit):
        gen.topo_sort_types(structs, {})


def test_process_schema_rekeys_structs_into_dependency_order():
    # Outer declared before Inner, but Inner must come first in the emitted dict.
    s = schema(structs={
        "Outer": struct(field("c", "Inner"), field("n", "uint8")),
        "Inner": struct(field("x", "uint8")),
    })
    data = process(s)
    assert list(data["structs"].keys()) == ["Inner", "Outer"]
