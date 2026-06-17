# ProtoEmb test suite

A self-contained test framework for the ProtoEmb toolchain. It runs without the
surrounding MaD monorepo, so the library can be split out (`git subtree`) and
keep testing itself. Three layers:

| Layer | What it tests | How |
|---|---|---|
| [`generator/`](generator/) | `core/generate.py` — schema math, layout, validation | `pytest` (pure Python) |
| [`conformance/`](conformance/) | Generated **wire** is byte-identical across C / Rust / TS | `pytest` drives codegen + compile + run + diff |
| (crates) | `framing/` + `runtime/` Rust crates | `cargo test` |

## Run it

```bash
make setup     # one-time: pip install pyyaml, jinja2, pytest
make test      # generator + conformance + rust  (the whole suite)

make test-generator     # just the generator unit tests
make test-conformance   # just the cross-language wire conformance
make test-rust          # just the framing + runtime crate tests
make verify             # the example round-trip script (examples/verify.sh)
```

`make test` is also run in CI on any change under `Protocol/**`
(see `.github/workflows/ci.yml`, job `protoemb-ci`).

### Toolchains

- **generator**: `python3` + `pyyaml` + `jinja2` + `pytest`.
- **conformance**: a C compiler (`cc`), `rustc`, and for the TypeScript leg
  `tsc` (or `npx`) + `node`. A missing C/Rust/TS toolchain **skips** that
  language rather than failing; conformance asserts only over the toolchains
  that ran, and requires at least two.

> If you run tests from a VSCode/Electron integrated terminal and the TS leg
> misbehaves, `ELECTRON_RUN_AS_NODE` has likely leaked into the environment. The
> Makefile already strips it; to run pytest directly use
> `env -u ELECTRON_RUN_AS_NODE python3 -m pytest …`.

## How the generator tests work

`tests/conftest.py` puts `core/` and the testkit on `sys.path`.
`tests/protoemb_testkit.py` provides schema builders (`enum`, `field`, `struct`,
`union`, `message`, `schema`) and pipeline wrappers (`process`, `validate`,
`generate`) that drive `generate.py` exactly as `main()` does. A typical test
builds a minimal schema and asserts on the enriched template data or on a
validation error reaching stderr:

```python
def test_packed_offsets(...):
    s = struct(field("temp", "int16", min=-40, max=85, scale=10),
               field("humidity", "uint8", min=0, max=100))
    sd = process(schema(structs={"Reading": s}))["structs"]["Reading"]
    assert sd["_wire_size"] == 3
```

Files: prefix resolution, enum sizing + remap strategy, field bit-width,
struct/union layout, topological ordering, message inference, **every**
`validate_schema` error path, the YAML `OFF`/`ON` bool guard, and end-to-end CLI
generation (determinism, `--prefix`, invalid-schema exit codes).

## How the conformance tests work

`conformance/render.py` is the **single source of truth**: a set of Python
vectors is rendered into a C, a Rust, and a TypeScript *driver*. Each driver
encodes every vector, prints `<label> <hex>`, and self-checks that
`decode(encode(v))` re-encodes to the same bytes. `conformance/_harness.py`
generates the codec, compiles each driver against it, runs it, and the test
asserts the three languages emit identical wire for every vector.

To add coverage, add a tuple to the `VECTORS` list in
[`test_thermostat_wire.py`](conformance/test_thermostat_wire.py) — no driver
edits, all three languages update automatically:

```python
("reading_mid", "Reading", {"temp": 23, "humidity": 44}),
#  label         struct      field values (see render.py for value shapes)
```

[`test_search_remap_wire.py`](conformance/test_search_remap_wire.py) covers the
sparse **binary-search** remap path (the shape of MaD's real G-code enum) that
the thermostat's small/dense `FanCmd` does not.

### Known generator divergence (quarantined, not hidden)

The conformance suite surfaced a real generator inconsistency: in the **aligned**
layout, the C and Rust codecs encode a numeric field with a raw byte copy that
**ignores `scale`/`min`**, while the TS codec applies them. So an aligned field
with a non-unit scale and a non-zero value produces different wire bytes in TS
vs C/Rust. The thermostat's only such field is `Schedule.slots` (scale 10).

These vectors are listed in `KNOWN_DIVERGENCES` in `test_thermostat_wire.py` and
excluded from the strict cross-language assertion, while
`test_known_aligned_scale_divergence_is_still_present` asserts they *do* still
diverge — so if the generator's aligned path is fixed to apply scale/min like the
packed path, that guard fails and tells you to drop the quarantine.

(Separately: remap enums have a per-language *API* difference — Rust stores the
wire-index variant, C/TS store the semantic value — but the **wire is
conformant**. The drivers render each language's convention; see
`render.py::ts_enum` / `c_enum`.)
