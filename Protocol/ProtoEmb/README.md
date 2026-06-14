# ProtoEmb

A small, dependency-light **binary protocol toolchain for embedded systems**.
Describe a protocol once in YAML; generate matching encode/decode code for
**C, TypeScript, and Rust**, plus a host-side serial runtime. The same wire
format is produced byte-for-byte by every target (enforced — see
[`examples/verify.sh`](examples/verify.sh)).

```text
schema.yaml ──► core/generate.py ──► C  (device firmware codec + runtime)
                (Jinja templates)     TypeScript (browser / Node)
                                      Rust (host / SIL)
            framing  ──► runtime ──► NDJSON bridge + WebAssembly client
            (wire format)  (Client / queue / transport)
```

## Layout

| Path | What |
|---|---|
| [`core/`](core/) | The code generator (`generate.py`) + Jinja `templates/` |
| [`framing/`](framing/) | `protoemb-framing` crate — wire frame parser/builder + CRC |
| [`runtime/`](runtime/) | `protoemb-runtime` crate — serial `Client`, priority queue, NDJSON `StdioBridge`, WASM `WasmClient` |
| [`examples/`](examples/) | A non-MaD `thermostat` protocol + `verify.sh` (generates & round-trips C/Rust/TS) |
| [`docs/`](docs/) | [`wire-format.md`](docs/wire-format.md) — the frame + payload contract |

## Schema features

- **Enums** — plain, or `remap: true` for sparse semantic values (dense table or
  binary search, chosen automatically).
- **Structs** — `packed` (bit-level) or `aligned` (byte-level); per-field
  `scale`, `min`/`max` (offset-binary), explicit `bits:`, `raw_storage`.
- **Nested structs**, **fixed-count arrays** (`count: N`), **optional fields**
  (`optional: true`), and **tagged unions** (top-level `unions:`).
- **Messages** — `tx_node`, `command_id`, `period_ms`, `priority`,
  `request`/`response`; a generated typed facade (`decodeData` / `Inbound`).
- **Multi-node** — node-ID constants + opt-in source-addressed framing.

See [`docs/wire-format.md`](docs/wire-format.md) for the exact wire layout.

## Generate

```bash
python3 core/generate.py --schema my.yaml --target c  --output gen/c  --templates core/templates
python3 core/generate.py --schema my.yaml --target ts --output gen/ts --templates core/templates
python3 core/generate.py --schema my.yaml --target rs --output gen/rs --templates core/templates
# --prefix Name  overrides the library prefix (default: schema `prefix`, else ProtoEmb)
```

Generator deps: `pip install -r core/requirements.txt` (pyyaml, jinja2), or
`pip install ./core` (see [`core/pyproject.toml`](core/pyproject.toml)) for a
`protoemb-gen` CLI.

The two Rust crates are workspace-free path crates today (`publish = false`);
their `Cargo.toml`s carry crates.io-ready metadata so the library can be split
out (e.g. `git subtree`) and published with a one-line change.

## Verify

```bash
./examples/verify.sh   # generate the example to C/Rust/TS, compile/typecheck,
                       # round-trip, and assert byte-identical wire across all three
```

## License

MIT.
