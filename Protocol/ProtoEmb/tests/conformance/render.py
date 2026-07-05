"""Render a single set of test vectors into a C, Rust, and TypeScript *driver* —
the single source of truth for the conformance suite. Vectors are plain Python;
this module emits each language's idiomatic constructor + encode + round-trip so
the three drivers cannot silently drift apart.

A vector value is, per field type (looked up from the processed schema):
  scalar int / bool         -> literal
  string field              -> Python str
  enum field                -> variant-name str (e.g. "HEAT")
  union field               -> ("tag", inner_value)
  nested struct field       -> dict {field: value}
  array field               -> list of element values
  optional field, absent    -> None
"""

from __future__ import annotations

import generate as gen


def camel(s):
    return "".join(w.capitalize() for w in s.split("_"))


class Renderer:
    def __init__(self, schema_dict, prefix):
        self.prefix = prefix
        self.up = prefix.upper()
        self.low = prefix.lower()
        self.data = gen.process_schema(dict(schema_dict), prefix)
        self.enums = self.data["enums"]
        self.unions = self.data["unions"]
        self.structs = self.data["structs"]

    # ── enum literals ────────────────────────────────────────────────────────
    # Every language is rendered through its NAMED enum constant, including remap
    # enums (C `PREFIX_ENUM_VARIANT`, TS `Enum.VARIANT`, Rust `Enum::Variant`).
    # This exercises the fix that makes those constants encode correctly even when
    # the semantic value differs from the wire index (e.g. FanCmd.AUTO == 9).
    def c_enum(self, enum_name, variant):
        return f"{self.up}_{enum_name.upper()}_{variant.upper()}"

    def rs_enum(self, enum_name, variant):
        return f"{enum_name}::{camel(variant)}"

    def ts_enum(self, enum_name, variant):
        return f"{enum_name}.{variant.upper()}"

    # ── leaf scalar literals ─────────────────────────────────────────────────
    @staticmethod
    def _scalar(lang, v):
        if isinstance(v, bool):
            return "true" if v else "false"
        return repr(v)

    # ── per-field value, dispatched on schema flags ──────────────────────────
    def field_value(self, lang, field, value):
        et = field["type"]
        if field["_is_enum"]:
            return getattr(self, f"{lang}_enum")(et, value)
        if field["_is_union"]:
            tag, inner = value
            return self.union_value(lang, et, tag, inner)
        if field["_is_struct"]:
            return self.struct_value(lang, et, value)
        if field["_is_string"]:
            if lang == "rs":
                return f'"{value}".to_string()'
            return f'"{value}"'
        return self._scalar(lang, value)

    def array_value(self, lang, field, values):
        et = field["type"]
        # element rendering reuses field_value with array-ness stripped
        elem = dict(field)
        elem["_is_array"] = False
        parts = [self.field_value(lang, elem, v) for v in values]
        if lang == "c":
            return "{" + ", ".join(parts) + "}"
        return "[" + ", ".join(parts) + "]"

    # ── union ────────────────────────────────────────────────────────────────
    def union_value(self, lang, union_name, tag, inner):
        udef = self.unions[union_name]
        variant = next(v for v in udef["variants"] if v["name"] == tag)
        pseudo = dict(variant)  # variant carries the same _is_* flags as a field
        rendered = self.field_value(lang, pseudo, inner)
        if lang == "c":
            tagc = f"{self.up}_{union_name.upper()}_TAG_{tag.upper()}"
            return (f"({self.prefix}_{union_name}_t){{ .tag = {tagc}, "
                    f".u.{tag} = {rendered} }}")
        if lang == "rs":
            return f"{union_name}::{camel(tag)}({rendered})"
        return f"{{ tag: '{tag}', value: {rendered} }}"

    # ── struct ───────────────────────────────────────────────────────────────
    def struct_value(self, lang, struct_name, fields):
        sdef = self.structs[struct_name]
        parts = []
        for f in sdef["fields"]:
            name = f["name"]
            val = fields.get(name)
            optional = f["_is_optional"]
            absent = optional and val is None

            if f["_is_array"]:
                rendered = self.array_value(lang, f, val)
            elif not absent:
                rendered = self.field_value(lang, f, val)
            else:
                rendered = None

            if lang == "c":
                if optional:
                    if not absent:
                        parts.append(f".{name} = {rendered}")
                    parts.append(f".{name}_present = {'true' if not absent else 'false'}")
                else:
                    parts.append(f".{name} = {rendered}")
            elif lang == "rs":
                rname = _snake(name)
                if optional:
                    parts.append(f"{rname}: " + ("None" if absent else f"Some({rendered})"))
                else:
                    parts.append(f"{rname}: {rendered}")
            else:  # ts
                if optional and absent:
                    parts.append(f"{name}: null")
                else:
                    parts.append(f"{name}: {rendered}")

        if lang == "c":
            return f"({self.prefix}_{struct_name}_t){{ " + ", ".join(parts) + " }"
        if lang == "rs":
            return f"{struct_name} {{ " + ", ".join(parts) + " }"
        return "{ " + ", ".join(parts) + " }"

    # ── full driver assembly ─────────────────────────────────────────────────
    def driver(self, lang, vectors):
        """vectors: list of (label, struct_name, value_dict). Returns full source
        that prints one `<label> <hex>` line per vector (or `<label>
        ROUNDTRIP_MISMATCH` if decode(encode(v)) re-encodes to different bytes)."""
        return getattr(self, f"_driver_{lang}")(vectors)

    def _driver_c(self, vectors):
        lines = [
            f'#include "{self.low}.h"',
            "#include <stdio.h>",
            "#include <string.h>",
            "static void emit(const char *l, const uint8_t *b, int n) {",
            '    printf("%s ", l); for (int i = 0; i < n; i++) printf("%02x", b[i]); printf("\\n");',
            "}",
            "int main(void) {",
        ]
        for label, sname, val in vectors:
            t = f"{self.prefix}_{sname}_t"
            sz = f"{self.up}_{sname.upper()}_WIRE_SIZE"
            expr = self.struct_value("c", sname, val)
            lines += [
                "    {",
                f"        {t} v = {expr};",
                f"        uint8_t b[{sz}]; {self.prefix}_{sname}_encode(b, &v);",
                f"        {t} v2; {self.prefix}_{sname}_decode(b, &v2);",
                f"        uint8_t b2[{sz}]; {self.prefix}_{sname}_encode(b2, &v2);",
                f'        if (memcmp(b, b2, {sz}) != 0) printf("{label} ROUNDTRIP_MISMATCH\\n");',
                f'        else emit("{label}", b, {sz});',
                "    }",
            ]
        lines += ["    return 0;", "}", ""]
        return "\n".join(lines)

    def _driver_rs(self, vectors):
        lines = [
            f'#[path = "{self.low}.rs"] mod codec; use codec::*;',
            "fn hex(b: &[u8]) -> String { b.iter().map(|x| format!(\"{:02x}\", x)).collect() }",
            "fn main() {",
        ]
        for label, sname, val in vectors:
            expr = self.struct_value("rs", sname, val)
            lines += [
                "    {",
                f"        let v = {expr};",
                "        let b = v.encode();",
                f"        let v2 = {sname}::decode(&b).expect(\"decode\");",
                "        let b2 = v2.encode();",
                f'        if b != b2 {{ println!("{label} ROUNDTRIP_MISMATCH"); }}',
                f'        else {{ println!("{label} {{}}", hex(&b)); }}',
                "    }",
            ]
        lines += ["}", ""]
        return "\n".join(lines)

    def _driver_ts(self, vectors):
        used = sorted({sname for _l, sname, _v in vectors})
        imports = []
        for s in used:
            imports += [f"encode{s}", f"decode{s}"]
        imports += list(self.enums.keys())
        lines = [
            "import { " + ", ".join(imports) + f" }} from './{self.low}';",
            "const hex = (b: Uint8Array) => Array.from(b).map((x) => x.toString(16).padStart(2, '0')).join('');",
        ]
        for label, sname, val in vectors:
            expr = self.struct_value("ts", sname, val)
            lines += [
                "{",
                f"  const b = encode{sname}({expr});",
                f"  const v2 = decode{sname}(b);",
                f"  const b2 = encode{sname}(v2);",
                f"  if (hex(b) !== hex(b2)) console.log('{label} ROUNDTRIP_MISMATCH');",
                f"  else console.log('{label} ' + hex(b));",
                "}",
            ]
        return "\n".join(lines) + "\n"


# `to_snake_case` lives inside generate.generate(); re-implement the small bit we
# need (Rust field names are snake_case of the schema field name).
def _snake(s):
    import re
    s1 = re.sub(r"([a-z0-9])([A-Z])", r"\1_\2", s)
    s2 = re.sub(r"([A-Z]+)([A-Z][a-z])", r"\1_\2", s1)
    return s2.lower()
