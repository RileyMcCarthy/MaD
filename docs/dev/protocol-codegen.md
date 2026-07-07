# Protocol & code generation

The protocol is defined **once** in
[`Protocol/MaDProtocol.yaml`](https://github.com/RileyMcCarthy/MaD/blob/main/Protocol/MaDProtocol.yaml)
and generated into C, TypeScript, and Rust by `ProtoEmb`. This page is for when
you change the schema.

## Generator dependencies

```bash
pip install -r Protocol/ProtoEmb/core/requirements.txt   # pyyaml, jinja2
```

## Regenerate each target

Run from the repo root:

```bash
# C → firmware
python3 ./Protocol/ProtoEmb/core/generate.py \
  --schema ./Protocol/MaDProtocol.yaml --target c \
  --output ./Firmware/MaDCore/src/Generated \
  --templates ./Protocol/ProtoEmb/core/templates

# TypeScript → web app
python3 ./Protocol/ProtoEmb/core/generate.py \
  --schema ./Protocol/MaDProtocol.yaml --target ts \
  --output ./Software/MaDWasmControl/src/protocol/generated \
  --templates ./Protocol/ProtoEmb/core/templates

# Rust → SIL
python3 ./Protocol/ProtoEmb/core/generate.py \
  --schema ./Protocol/MaDProtocol.yaml --target rs \
  --output ./SIL/mad-protocol/src/generated \
  --templates ./Protocol/ProtoEmb/core/templates
```

In practice you rarely run all three by hand — each consumer regenerates its own:

| Consumer | Command | Output |
|---|---|---|
| Firmware | (automatic) PlatformIO pre-hook on every build | `Firmware/MaDCore/src/Generated/` |
| Web app | `npm run generate:proto` (in `Software/MaDWasmControl`) | `src/protocol/generated/` |
| SIL | `make protocol` (in `SIL`) | `SIL/mad-protocol/src/generated/` |

!!! warning "Generated code is not hand-edited"
    Don't edit anything under a `Generated/` or `generated/` directory. Change the
    YAML (or the Jinja templates in `Protocol/ProtoEmb/core/templates/`) and
    regenerate.

## Editing the schema

The schema supports enums (plain or `remap` for sparse values), packed/aligned
structs with per-field `scale`/`min`/`max`/`bits`, nested structs, fixed arrays,
optional fields, and tagged unions, plus a message routing table with
`command_id`, `tx_node`, `period_ms`, and `priority`. The exact semantics are in
the [wire-format spec](https://github.com/RileyMcCarthy/protoemb/blob/main/docs/wire-format.md);
the MaD message list is in the [protocol reference](../reference/protocol-messages.md).

After editing: regenerate **all** consumers and rebuild, so firmware, app, and SIL
stay in lock-step.

## The host runtime & bridge

The Rust runtime (`Protocol/ProtoEmb/runtime`) is compiled two ways:

- a native **`protoemb-bridge`** binary (`cargo build --bin protoemb-bridge`),
  used by the legacy desktop app over NDJSON stdio, and
- a **WASM** module (`wasm-pack build … --target web`), loaded by the browser app.

## Cross-language conformance

Because three codecs are generated from one schema, ProtoEmb ships a conformance
check that generates an example protocol to C/Rust/TS, round-trips it, and asserts
**byte-identical** wire output across all three:

```bash
cd Protocol/ProtoEmb
./examples/verify.sh
```

Run it after schema or template changes to guarantee the targets still agree.
