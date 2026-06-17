"""Tagged-union sizing: a discriminant tag plus a payload sized to the largest
variant, so the wire size stays fixed regardless of the active variant."""

from protoemb_testkit import enum, process, schema, union


def variants_by_name(udef):
    return {v["name"]: v for v in udef["variants"]}


def test_packed_union_tag_and_largest_payload():
    sample = union(
        {"name": "temperature", "type": "int16", "min": -40, "max": 85, "scale": 10},  # 11 bits
        {"name": "humidity", "type": "uint8", "min": 0, "max": 100},                   # 7 bits
        {"name": "fan", "type": "FanCmd"},                                             # 2 bits
    )
    data = process(schema(
        enums={"FanCmd": enum("OFF", "LOW", "HIGH", "AUTO")},
        unions={"Sample": sample},
    ))
    u = data["unions"]["Sample"]
    assert u["_is_packed"]
    assert u["_tag_count"] == 3
    assert u["_tag_bits"] == 2                       # ceil(log2(3))
    assert u["_payload_offset"] == 2                 # payload starts after tag
    assert u["_total_bits"] == 2 + 11                # tag + largest variant
    assert u["_wire_size"] == 2                      # ceil(13 / 8)

    v = variants_by_name(u)
    assert v["temperature"]["_index"] == 0 and v["temperature"]["_elem_bits"] == 11
    assert v["temperature"]["_min_wire"] == -400 and v["temperature"]["_max_wire"] == 850
    assert v["fan"]["_is_enum"] and v["fan"]["_elem_bits"] == 2


def test_aligned_union_one_byte_tag_plus_largest():
    u = union(
        {"name": "a", "type": "uint8"},     # 1 byte
        {"name": "b", "type": "int32"},     # 4 bytes
        {"name": "c", "type": "int16"},     # 2 bytes
        encoding="aligned",
    )
    data = process(schema(unions={"U": u}))
    ud = data["unions"]["U"]
    assert not ud["_is_packed"]
    assert ud["_payload_offset"] == 1
    assert ud["_wire_size"] == 1 + 4                 # tag byte + largest variant
    assert variants_by_name(ud)["b"]["_elem_byte_size"] == 4


def test_single_variant_union_has_one_tag_bit():
    u = union({"name": "only", "type": "uint8", "min": 0, "max": 3})  # 2 bits
    ud = process(schema(unions={"U": u}))["unions"]["U"]
    assert ud["_tag_bits"] == 1
    assert ud["_total_bits"] == 1 + 2
