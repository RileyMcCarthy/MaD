#!/usr/bin/env python3
"""
ProtoEmb Code Generator

Reads a protocol YAML schema and generates encode/decode code for C, TypeScript,
and Rust using Jinja2 templates.

All generated types/functions use the fixed "ProtoEmb" prefix:
  C:  ProtoEmb_<Name>_t, ProtoEmb_<Name>_encode(), PROTOEMB_<NAME>_WIRE_SIZE
  TS: interfaces and functions use schema names directly (no prefix)
  RS: structs and functions use schema names directly (no prefix)

Usage:
    python3 generate.py --schema <schema.yaml> --target c  --output <dir>
    python3 generate.py --schema <schema.yaml> --target ts --output <dir>
    python3 generate.py --schema <schema.yaml> --target rs --output <dir>
"""

import argparse
import math
import os
import sys
from pathlib import Path

import yaml
from jinja2 import Environment, FileSystemLoader

# ── Library prefix / identity ──
# Default is "ProtoEmb", but it is configurable so multiple independent
# protocols can be generated into one codebase without symbol/file collisions.
# Resolution order (highest first): --prefix CLI flag, schema `prefix` (or
# `library_name`) key, then this default.
DEFAULT_PREFIX = "ProtoEmb"


def resolve_prefix(schema, cli_prefix=None):
    """Resolve the library prefix from CLI flag, schema, or default."""
    prefix = (
        cli_prefix
        or schema.get("prefix")
        or schema.get("library_name")
        or DEFAULT_PREFIX
    )
    if not isinstance(prefix, str) or not prefix.isidentifier():
        raise SystemExit(
            f"Invalid prefix {prefix!r}: must be a valid identifier "
            "(letters, digits, underscore; not starting with a digit)"
        )
    return prefix


# ============================================================
# Schema Processing
# ============================================================

def compute_enum_bits(enum_def):
    """Compute bits needed to represent an enum."""
    count = len(enum_def["variants"])
    if count <= 1:
        return 1
    return math.ceil(math.log2(count))


def compute_field_bits(field, enums):
    """Compute bits needed for a struct field."""
    ftype = field["type"]

    # Bool
    if ftype == "bool":
        return 1

    # Enum reference
    if ftype in enums:
        return compute_enum_bits(enums[ftype])

    # String — not bit-packed
    if ftype == "string":
        return field.get("max_length", 16) * 8

    # Explicit bit-width override for packed numeric fields.
    explicit_bits = field.get("bits", None)
    if explicit_bits is not None:
        return int(explicit_bits)

    # Numeric with min/max
    fmin = field.get("min", None)
    fmax = field.get("max", None)
    scale = field.get("scale", 1)

    if fmin is not None and fmax is not None:
        # scale is a multiplier (steps per unit), so wire range = (max-min)*scale
        value_range = int((fmax - fmin) * scale) + 1
        if value_range <= 1:
            return 1
        bits = math.ceil(math.log2(value_range))
        return bits
    else:
        # Fallback to standard type sizes
        type_bits = {
            "int8": 8, "uint8": 8,
            "int16": 16, "uint16": 16,
            "int32": 32, "uint32": 32, "float": 32,
            "int64": 64, "uint64": 64,
        }
        return type_bits.get(ftype, 32)


def topo_sort_structs(structs):
    """Order structs so nested-struct children precede their parents.

    Raises SystemExit on a reference cycle. With no nested-struct fields this
    returns the structs in their original definition order.
    """
    state = {}  # name -> "visiting" | "done"
    order = []

    def visit(name, stack):
        st = state.get(name)
        if st == "done":
            return
        if st == "visiting":
            raise SystemExit(f"Struct reference cycle: {' -> '.join(stack + [name])}")
        state[name] = "visiting"
        for field in structs[name]["fields"]:
            ftype = field["type"]
            if ftype in structs:
                visit(ftype, stack + [name])
        state[name] = "done"
        order.append(name)

    for name in structs:
        visit(name, [])
    return order


def process_schema(schema, prefix=DEFAULT_PREFIX):
    """Process raw schema YAML into enriched data for templates."""
    prefix_upper = prefix.upper()
    prefix_lower = prefix.lower()
    enums = schema.get("enums", {})
    structs = schema.get("structs", {})
    messages = schema.get("messages", {})

    # Enrich enums
    for name, enum_def in enums.items():
        enum_def["_name"] = name
        variants = enum_def["variants"]
        is_remap = enum_def.get("remap", False)
        enum_def["_is_remap"] = is_remap
        enum_def["_bits"] = compute_enum_bits(enum_def)

        processed_variants = []
        for i, v in enumerate(variants):
            if isinstance(v, dict):
                processed_variants.append({
                    "name": v["name"],
                    "value": v["value"],
                    "index": i,
                })
            else:
                processed_variants.append({
                    "name": v,
                    "value": i,
                    "index": i,
                })
        enum_def["_variants"] = processed_variants
        enum_def["_count"] = len(processed_variants)

        # For remap enums, compute max actual value for C array sizing, and
        # pick a value→wire strategy: a dense lookup array (fast, but O(max_value)
        # bytes) or a binary search over a sorted table (compact for sparse,
        # large-valued enums). Auto-selects search when the dense array would
        # exceed 256 entries; override per-enum with `remap_style: array|search`.
        if is_remap:
            max_value = max(v["value"] for v in processed_variants)
            enum_def["_max_value"] = max_value
            style = enum_def.get("remap_style", None)
            if style not in ("array", "search"):
                # Dense array costs (max_value + 1) bytes. Switch to a sorted
                # table + binary search when that array is both non-trivial and
                # mostly empty (sparse), e.g. GCode's 9 values spread over 0..122.
                dense_size = max_value + 1
                sparse = dense_size > 32 and (len(processed_variants) * 2) < dense_size
                style = "search" if sparse else "array"
            enum_def["_remap_style"] = style
            enum_def["_sorted_variants"] = sorted(
                processed_variants, key=lambda v: v["value"]
            )

    # Enrich structs. Nested-struct fields need their child sized first, so we
    # process in dependency (topological) order, then re-key `structs` into that
    # order so generated typedefs/functions emit children before parents.
    defaults = schema.get("defaults", {})
    struct_order = topo_sort_structs(structs)
    for name in struct_order:
        struct_def = structs[name]
        struct_def["_name"] = name
        encoding = struct_def.get("encoding", defaults.get("encoding", "packed"))
        struct_def["_encoding"] = encoding
        is_packed = encoding == "packed"
        struct_def["_is_packed"] = is_packed
        struct_def.setdefault("_needs_pack_helper", False)

        total_bits = 0
        has_nested = False
        for field in struct_def["fields"]:
            ftype = field["type"]
            field["_is_enum"] = ftype in enums
            field["_is_struct"] = ftype in structs
            field["_is_bool"] = ftype == "bool"
            field["_is_string"] = ftype == "string"
            field["_is_float"] = ftype == "float"
            field["_is_numeric"] = not (field["_is_enum"] or field["_is_bool"]
                                        or field["_is_string"] or field["_is_struct"])
            field["_is_signed"] = ftype.startswith("int") and not ftype.startswith("uint")

            if field["_is_struct"]:
                has_nested = True
                child = structs[ftype]
                # A nested child must share the parent's encoding so its layout
                # composes cleanly (bit-packed into bits, byte-aligned into bytes).
                if child["_is_packed"] != is_packed:
                    raise SystemExit(
                        f"Struct {name}.{field['name']}: nested struct '{ftype}' uses "
                        f"'{child['_encoding']}' encoding but parent is '{encoding}'"
                    )

            # Fixed-count arrays: a `count: N` makes the field N consecutive
            # elements of `type`. The element size is computed as for a scalar
            # and multiplied by N (preserves the fixed-wire-size model).
            field["_is_array"] = "count" in field
            field["_array_len"] = field.get("count", 1)
            n = field["_array_len"]

            if is_packed:
                if field["_is_struct"]:
                    child = structs[ftype]
                    child["_needs_pack_helper"] = True
                    elem_bits = child["_total_bits"]
                else:
                    elem_bits = compute_field_bits(field, enums)
                field["_elem_bits"] = elem_bits
                field["_bits"] = elem_bits * n
                field["_bit_offset"] = total_bits
                total_bits += field["_bits"]
            else:
                # Aligned — use standard C type sizes
                if field["_is_struct"]:
                    structs[ftype]["_needs_pack_helper"] = True
                    elem_bs = structs[ftype]["_wire_size"]
                elif field["_is_string"]:
                    elem_bs = field.get("max_length", 16)
                elif field["_is_enum"]:
                    elem_bs = 1
                elif field["_is_bool"]:
                    elem_bs = 1
                else:
                    type_sizes = {
                        "int8": 1, "uint8": 1,
                        "int16": 2, "uint16": 2,
                        "int32": 4, "uint32": 4,
                    }
                    elem_bs = type_sizes.get(ftype, 4)
                field["_elem_byte_size"] = elem_bs
                field["_byte_size"] = elem_bs * n

            field["_scale"] = field.get("scale", 1)
            field["_has_scale"] = field.get("scale", 1) != 1
            field["_raw_storage"] = field.get("raw_storage", False)
            field["_unit"] = field.get("unit", "")
            field["_min"] = field.get("min", None)
            field["_max"] = field.get("max", None)
            # Wire min/max in wire steps (for C/RS literal use)
            fscale = field["_scale"]
            fmin = field["_min"]
            fmax = field["_max"]
            field["_min_wire"] = int(fmin * fscale) if fmin is not None else None
            field["_max_wire"] = int(fmax * fscale) if fmax is not None else None

        if is_packed:
            struct_def["_total_bits"] = total_bits
            struct_def["_wire_size"] = math.ceil(total_bits / 8)
        else:
            byte_offset = 0
            for field in struct_def["fields"]:
                field["_byte_offset"] = byte_offset
                byte_offset += field["_byte_size"]
            struct_def["_wire_size"] = byte_offset
        struct_def["_has_nested"] = has_nested

    # Re-key structs into dependency order so generated typedefs/functions emit
    # nested children before the parents that embed them.
    structs = {name: structs[name] for name in struct_order}

    # Enrich messages
    read_messages = []
    write_messages = []
    for name, msg_def in messages.items():
        msg_def["_name"] = name
        msg_def["_command_id"] = msg_def.get("command_id", None)

        # New schema only: tx_node + request/response + optional period_ms
        msg_def["_tx_node"] = msg_def.get("tx_node", "")

        # Request payload type (for command/query calls)
        request_name = msg_def.get("request", None)
        request_scalar = None

        if isinstance(request_name, str) and request_name in ("bool", "none", "raw", "bytes"):
            request_scalar = request_name
            request_name = None

        # Response payload type
        response_name = msg_def.get("response", None)

        msg_def["_request_name"] = request_name
        msg_def["_request_scalar"] = request_scalar
        msg_def["_response_name"] = response_name

        # Runtime payload names for callback templates
        msg_def["_payload_name"] = request_name if request_name is not None else response_name
        msg_def["_payload_type"] = request_scalar

        is_periodic = msg_def.get("period_ms", None) is not None
        is_async = (msg_def.get("_command_id") is None) and (response_name is not None) and not is_periodic

        msg_def["_is_periodic"] = is_periodic
        msg_def["_is_async"] = is_async

        has_request_payload = (request_name is not None) or (request_scalar in ("bool", "raw", "bytes"))
        msg_def["_has_request_payload"] = has_request_payload

        # Wire command frame kind. An explicit `command_frame: read|write` in the
        # schema overrides inference; otherwise it is auto-derived:
        # - periodic and plain request/response reads => READ frame
        # - state-changing commands and payload queries => WRITE frame
        explicit_frame = msg_def.get("command_frame", None)
        if msg_def["_command_id"] is not None:
            if explicit_frame in ("read", "write"):
                command_frame = explicit_frame
            elif is_periodic:
                command_frame = "read"
            elif (response_name is not None) and (not has_request_payload):
                command_frame = "read"
            else:
                command_frame = "write"
        else:
            command_frame = None

        msg_def["_command_frame"] = command_frame
        msg_def["_command_frame_explicit"] = explicit_frame is not None

        # Priority is informational metadata (enforced by the host queue, not on
        # the wire). Normalize + default it so it can be emitted as a constant.
        priority = msg_def.get("priority", None)
        if priority is None:
            priority = "low" if is_periodic else "high"
        msg_def["_priority"] = priority

        # Semantic class (for docs/templates, not wire bytes)
        if is_periodic:
            semantic = "periodic"
        elif is_async:
            semantic = "async"
        elif msg_def["_command_id"] is not None:
            if response_name is not None:
                semantic = "query"
            else:
                semantic = "command"
        else:
            semantic = "unknown"
        msg_def["_semantic"] = semantic

        payload_name = response_name if response_name is not None else request_name
        if payload_name and payload_name in structs:
            msg_def["_payload_struct"] = structs[payload_name]
        else:
            msg_def["_payload_struct"] = None

        # READ-like runtime callbacks handled on READ frames.
        if msg_def["_command_id"] is not None and msg_def["_command_frame"] == "read":
            read_messages.append(msg_def)

        # WRITE messages are command->ACK/NACK (or optional DATA) routes.
        if msg_def["_command_id"] is not None and msg_def["_command_frame"] == "write":
            write_messages.append(msg_def)

    read_messages.sort(key=lambda m: m["_command_id"])
    write_messages.sort(key=lambda m: m["_command_id"])

    # Runtime config (device-side frame assembly). Defaults preserve the
    # historical hardcoded values so existing protocols regenerate unchanged.
    runtime_cfg = schema.get("runtime", {}) or {}

    return {
        "protocol_version": schema.get("protocol_version", 1),
        "prefix": prefix,
        "prefix_upper": prefix_upper,
        "prefix_lower": prefix_lower,
        "byte_order": defaults.get("byte_order", "little_endian"),
        "bit_order": defaults.get("bit_order", "lsb_first"),
        "runtime_max_payload": int(runtime_cfg.get("max_payload", 4096)),
        "runtime_timeout_ms": int(runtime_cfg.get("frame_timeout_ms", 100)),
        "enums": enums,
        "structs": structs,
        "messages": messages,
        "runtime_read_messages": read_messages,
        "runtime_write_messages": write_messages,
    }


def load_generator_config(config_path):
    """Load optional generator config YAML."""
    if not config_path:
        return {}

    with open(config_path, "r") as f:
        cfg = yaml.safe_load(f) or {}

    if not isinstance(cfg, dict):
        raise SystemExit("Generator config must be a YAML mapping")

    return cfg


# ============================================================
# Validation
# ============================================================

# Native integer type ranges, used to validate that a field's declared
# min/max actually fit the storage type (catches e.g. int8 with min -1000).
TYPE_RANGES = {
    "int8":  (-128, 127),
    "uint8": (0, 255),
    "int16": (-32768, 32767),
    "uint16": (0, 65535),
    "int32": (-2147483648, 2147483647),
    "uint32": (0, 4294967295),
    "int64": (-9223372036854775808, 9223372036854775807),
    "uint64": (0, 18446744073709551615),
}


def validate_schema(data):
    """Validate the processed schema. Raises on error."""
    errors = []
    enums = data["enums"]
    structs = data["structs"]
    messages = data["messages"]
    generator_config = data.get("generator_config", {})
    schema_nodes = data.get("nodes", [])
    config_nodes = generator_config.get("nodes", [])
    allowed_nodes = schema_nodes if schema_nodes else config_nodes
    seen_read_command_ids = {}
    seen_write_command_ids = {}
    seen_data_command_ids = {}

    if allowed_nodes and not isinstance(allowed_nodes, list):
        errors.append("Generator config 'nodes' must be a list of strings")
        allowed_nodes = []

    # Validate enum bit widths
    for name, enum_def in enums.items():
        bits = enum_def["_bits"]
        count = enum_def["_count"]
        max_representable = 2 ** bits
        if count > max_representable:
            errors.append(
                f"Enum {name}: {count} variants need {math.ceil(math.log2(count))} bits "
                f"but only {bits} allocated (max {max_representable} values)"
            )

    # Validate struct fields
    for name, struct_def in structs.items():
        field_names = set()
        for field in struct_def["fields"]:
            if field["name"] in field_names:
                errors.append(f"Struct {name}: duplicate field name '{field['name']}'")
            field_names.add(field["name"])

            if field["_is_enum"] and field["type"] not in enums:
                errors.append(f"Struct {name}.{field['name']}: references unknown enum '{field['type']}'")

            # Field min/max must fit the declared storage type.
            ftype = field["type"]
            if ftype in TYPE_RANGES:
                tmin, tmax = TYPE_RANGES[ftype]
                fmin = field.get("min", None)
                fmax = field.get("max", None)
                if fmin is not None and fmin < tmin:
                    errors.append(
                        f"Struct {name}.{field['name']}: min {fmin} below {ftype} "
                        f"minimum {tmin} — widen the type or raise min"
                    )
                if fmax is not None and fmax > tmax:
                    errors.append(
                        f"Struct {name}.{field['name']}: max {fmax} above {ftype} "
                        f"maximum {tmax} — widen the type or lower max"
                    )

            # Fixed-count array constraints.
            count = field.get("count", None)
            if count is not None:
                if not isinstance(count, int) or count < 1:
                    errors.append(
                        f"Struct {name}.{field['name']}: count must be a positive integer, got {count!r}"
                    )
                if field.get("_is_string"):
                    errors.append(
                        f"Struct {name}.{field['name']}: string arrays are not supported"
                    )

            # A fractional scale only has a well-defined wire representation on a
            # float field; on an integer field it would silently truncate.
            if field["_is_numeric"] and not field["_is_float"]:
                fscale = field.get("scale", 1)
                if isinstance(fscale, float) and not fscale.is_integer():
                    errors.append(
                        f"Struct {name}.{field['name']}: fractional scale {fscale} "
                        f"requires a 'float' field type (integer fields need an integer scale)"
                    )

            if struct_def["_is_packed"] and field["_is_numeric"]:
                fmin = field.get("min", None)
                fmax = field.get("max", None)
                scale = field.get("scale", 1)
                if fmin is not None and fmax is not None:
                    value_range = int((fmax - fmin) * scale) + 1
                    needed = math.ceil(math.log2(value_range)) if value_range > 1 else 1
                    if needed > field["_bits"]:
                        errors.append(
                            f"Struct {name}.{field['name']}: range [{fmin}, {fmax}] * scale {scale} "
                            f"needs {needed} bits but only {field['_bits']} allocated"
                        )

    # Validate message schema and struct references
    for name, msg_def in messages.items():
        tx_node = msg_def.get("tx_node")
        if not isinstance(tx_node, str) or not tx_node:
            errors.append(f"Message {name}.tx_node: must be a non-empty string")
        elif allowed_nodes and tx_node not in allowed_nodes:
            errors.append(
                f"Message {name}.tx_node: '{tx_node}' is not in configured nodes {allowed_nodes}"
            )

        command_id = msg_def.get("command_id", None)
        period_ms = msg_def.get("period_ms", None)
        request = msg_def.get("request", None)
        response = msg_def.get("response", None)

        if command_id is None and response is None:
            errors.append(f"Message {name}: requires response when command_id is omitted")

        if period_ms is not None and command_id is None:
            errors.append(f"Message {name}: periodic message requires command_id")

        if period_ms is not None:
            if not isinstance(period_ms, int):
                errors.append(f"Message {name}.period_ms: must be an integer")
            elif period_ms <= 0:
                errors.append(f"Message {name}.period_ms: must be > 0")

        if request is not None:
            if isinstance(request, str) and request in ("bool", "none", "raw", "bytes"):
                pass
            elif request not in structs:
                errors.append(f"Message {name}.request: references unknown struct '{request}'")

        if response is not None and response not in structs:
            errors.append(f"Message {name}.response: references unknown struct '{response}'")

        explicit_frame = msg_def.get("command_frame", None)
        if explicit_frame is not None and explicit_frame not in ("read", "write"):
            errors.append(
                f"Message {name}.command_frame: must be 'read' or 'write', got {explicit_frame!r}"
            )

        priority = msg_def.get("priority", None)
        if priority is not None and priority not in ("high", "low"):
            errors.append(
                f"Message {name}.priority: must be 'high' or 'low', got {priority!r}"
            )

        command_frame = msg_def.get("_command_frame", None)
        if command_id is not None and command_frame == "read":
            if command_id in seen_read_command_ids:
                errors.append(
                    f"Message {name}.command_id: duplicate READ command_id {command_id} "
                    f"already used by {seen_read_command_ids[command_id]}"
                )
            else:
                seen_read_command_ids[command_id] = name

        if command_id is not None and command_frame == "write":
            if command_id in seen_write_command_ids:
                errors.append(
                    f"Message {name}.command_id: duplicate WRITE command_id {command_id} "
                    f"already used by {seen_write_command_ids[command_id]}"
                )
            else:
                seen_write_command_ids[command_id] = name

        # DATA-producing messages (read responses + write-frame queries) must have
        # unique command ids so the typed facade can dispatch a DATA frame
        # unambiguously back to its payload type.
        if command_id is not None and response is not None:
            if command_id in seen_data_command_ids:
                errors.append(
                    f"Message {name}.command_id: DATA command_id {command_id} collides with "
                    f"{seen_data_command_ids[command_id]} — both return a payload, so the "
                    f"typed facade cannot tell their DATA frames apart"
                )
            else:
                seen_data_command_ids[command_id] = name

    if errors:
        for e in errors:
            print(f"ERROR: {e}", file=sys.stderr)
        raise SystemExit(f"Schema validation failed with {len(errors)} error(s)")

    print(f"Schema validation passed: {len(enums)} enums, {len(structs)} structs, {len(messages)} messages")


# ============================================================
# Code Generation
# ============================================================

def target_files(prefix_lower):
    """Return the (template, output-filename) pairs for each target, named by prefix."""
    return {
        "c":  [
            ("protocol.h.j2", f"{prefix_lower}.h"),
            ("protocol.c.j2", f"{prefix_lower}.c"),
            ("protocol_runtime.h.j2", f"{prefix_lower}_runtime.h"),
            ("protocol_runtime.c.j2", f"{prefix_lower}_runtime.c"),
        ],
        "ts": [("protocol.ts.j2", f"{prefix_lower}.ts")],
        "rs": [("protocol.rs.j2", f"{prefix_lower}.rs")],
    }


def generate(data, target, output_dir, template_dir):
    """Generate code for the given target language."""
    env = Environment(
        loader=FileSystemLoader(template_dir),
        keep_trailing_newline=True,
        trim_blocks=True,
        lstrip_blocks=True,
    )

    # Add custom filters
    env.filters["upper_snake"] = lambda s: s.upper()
    env.filters["camel_case"] = lambda s: "".join(w.capitalize() for w in s.split("_"))
    env.filters["lower_camel"] = lambda s: s[0].lower() + "".join(w.capitalize() for w in s.split("_"))[1:] if s else s

    import re
    def to_snake_case(s):
        """Convert camelCase or PascalCase to snake_case."""
        s1 = re.sub(r'([a-z0-9])([A-Z])', r'\1_\2', s)
        s2 = re.sub(r'([A-Z]+)([A-Z][a-z])', r'\1_\2', s1)
        return s2.lower()
    env.filters["snake_case"] = to_snake_case

    # Rust reserved keyword escaping
    _RUST_KEYWORDS = {
        "as", "break", "const", "continue", "crate", "else", "enum", "extern",
        "false", "fn", "for", "if", "impl", "in", "let", "loop", "match", "mod",
        "move", "mut", "pub", "ref", "return", "self", "Self", "static", "struct",
        "super", "trait", "true", "type", "unsafe", "use", "where", "while",
        "async", "await", "dyn", "abstract", "become", "box", "do", "final",
        "macro", "override", "priv", "typeof", "unsized", "virtual", "yield", "try",
    }
    env.filters["rust_safe"] = lambda s: f"r#{s}" if s in _RUST_KEYWORDS else s

    env.globals["ceil"] = math.ceil
    env.globals["log2"] = math.log2
    env.globals["int"] = int

    os.makedirs(output_dir, exist_ok=True)

    files = target_files(data["prefix_lower"]).get(target)
    if not files:
        raise ValueError(f"Unknown target: {target}")

    for template_name, output_name in files:
        template = env.get_template(template_name)
        rendered = template.render(**data)
        output_path = os.path.join(output_dir, output_name)
        with open(output_path, "w") as f:
            f.write(rendered)
        print(f"Generated: {output_path}")


# ============================================================
# Main
# ============================================================

def main():
    parser = argparse.ArgumentParser(description="ProtoEmb Code Generator")
    parser.add_argument("--schema", required=True, help="Path to protocol YAML schema")
    parser.add_argument("--config", required=False, help="Path to generator config YAML")
    parser.add_argument("--prefix", required=False, default=None,
                        help="Library prefix / identity (default: schema `prefix` key, else 'ProtoEmb')")
    parser.add_argument("--target", required=True, choices=["c", "ts", "rs"], help="Target language")
    parser.add_argument("--output", required=True, help="Output directory")
    parser.add_argument("--templates", default=None, help="Templates directory (default: templates/ next to this script)")
    args = parser.parse_args()

    # Resolve template dir
    script_dir = Path(__file__).parent
    template_dir = args.templates or str(script_dir / "templates")

    # Load schema
    with open(args.schema, "r") as f:
        schema = yaml.safe_load(f)

    generator_config = load_generator_config(args.config)

    # Resolve library prefix (CLI > schema > default)
    prefix = resolve_prefix(schema, args.prefix)

    # Process and validate
    data = process_schema(schema, prefix)
    data["nodes"] = schema.get("nodes", [])
    data["generator_config"] = generator_config
    validate_schema(data)

    # Generate
    generate(data, args.target, args.output, template_dir)


if __name__ == "__main__":
    main()
