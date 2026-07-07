# Python Coding Guidelines — Build Hooks (and the ProtoEmb generator)

This document governs the **Python** in `Firmware/MaDCore/extra_scripts/` (the PlatformIO SCons helper scripts). The ProtoEmb code generator (`Protocol/ProtoEmb/core/`) now lives in [its own repo](https://github.com/RileyMcCarthy/protoemb) as a git submodule — the same conventions apply there, and its lint/tests run in that repo's CI. This guide is derived from the actual code — follow it to write changes that match the existing style and that the build hooks (PlatformIO pre-build, SIL `Makefile`, Cargo `build.rs`) keep working.

The Python here is small and dependency-light by design: it parses a YAML protocol schema, enriches it, validates it, and renders Jinja2 templates. Keep it that way.

---

## TL;DR for contributors

- **Linting/typing:** `ruff.toml` at the repo root is the lint config, and the CI `python-lint` job gates `ruff check Firmware/MaDCore/extra_scripts` (the protoemb repo lints the generator with its own `ruff.toml`). `black` locally is recommended but not gated.
- **CI does run the generator** (via PlatformIO's pre-build hook, under **Python 3.9** — see below), so keep the generator working and 3.9-compatible.
- **Dependencies:** only `pyyaml>=6.0` and `jinja2>=3.1` (`Protocol/ProtoEmb/core/requirements.txt:1`). Do not add new runtime deps.
- **Entry points:** argparse CLI, `def main():`, and an `if __name__ == "__main__": main()` guard.
- **User/schema errors:** `raise SystemExit("message")` (or print to `stderr` then raise). Never use bare `exit()` or `assert` for validation.
- **Generated output is do-not-edit** — change the schema or the `.j2` templates and regenerate.

---

## Tooling, linting & passing checks

### What is configured

**No lint/format/type config.** There is no `ruff.toml`, `.flake8`, `setup.cfg`, `tox.ini`, `mypy.ini`, `.pre-commit-config.yaml`, or `[tool.ruff]`/`[tool.black]`/`[tool.mypy]` section anywhere in the repo for first-party Python (verified by searching the tree, excluding `node_modules/`). The only `.flake8`/`pyproject.toml` matches that contain lint config live under `node_modules/` (third-party) and do not apply here.

The single first-party `pyproject.toml` (`Protocol/ProtoEmb/core/pyproject.toml:1`) exists **only to make the generator pip-installable** as the `protoemb-gen` CLI — it configures packaging, not linting:

```toml
[project]
name = "protoemb-gen"
requires-python = ">=3.9"
dependencies = ["pyyaml>=6.0", "jinja2>=3.1"]

[project.scripts]
protoemb-gen = "generate:main"

[tool.setuptools.package-data]
"*" = ["templates/*.j2"]
```

(`requires-python` at `pyproject.toml:19`; the `protoemb-gen = "generate:main"` console script at `:24`; `py-modules = ["generate"]` at `:27`.)

### How "checks" actually pass

CI lints with `ruff` (`python-lint` job; config in `ruff.toml`); there is no type-check/unit-test step for the SCons hooks. The generator itself **is** exercised in CI, indirectly:

- **PlatformIO pre-build** runs `generate.py` to emit `src/Generated/` before the firmware compiles (`Firmware/MaDCore/extra_scripts/generate_protocol.py:36`). The hook is registered globally in `platformio.ini` (`extra_scripts = pre:extra_scripts/generate_protocol.py` at `platformio.ini:2`), so it runs for **every** environment. A non-zero generator exit fails the firmware build (`env.Exit(1)`, `generate_protocol.py:48`).
- **In CI, the `build-firmware` job runs `pio run` under Python 3.9** (`.github/workflows/ci.yml:183`–`:185` pin `python-version: '3.9'`), so the generator is genuinely exercised on 3.9 in CI. Treat 3.9 syntax compatibility as a real (if implicit) gate, not just an aspiration.
- **`wasm-control-ci`** and **`pages.yml`** install the generator's `requirements.txt` and regenerate the protocol as part of their builds (`ci.yml:77`–`:78`, `pages.yml:43`–`:48`); the wasm job additionally runs `cargo test` for `protoemb-runtime` (`ci.yml:79`–`:81`).
- **SIL `make protocol`** runs `generate.py --target rs` (`SIL/Makefile:33`).
- **`examples/verify.sh`** is the closest thing to a generator self-test: it regenerates the non-MaD `thermostat` protocol in all three targets and asserts C == Rust == TS wire bytes (`Protocol/ProtoEmb/examples/verify.sh:18`–`:60`). It is **not wired into CI** — run it manually.

**Do / Don't:**

- **Do** run `bash Protocol/ProtoEmb/examples/verify.sh` (or `./Protocol/ProtoEmb/examples/verify.sh`) after touching `generate.py` or any template — it is the real regression gate. (It is a `bash` script, `verify.sh:1`; do **not** run it with `python3`.)
- **Do** keep `requires-python = ">=3.9"` honest: avoid 3.10+-only syntax (no `match`/`case`, no `X | Y` type unions in annotations). The existing code uses only constructs valid on 3.9 (f-strings, `dict`/`set` comprehensions, `pathlib`). This is backed by the 3.9-pinned firmware build in CI.
- **Don't** introduce a new Python dependency — the project advertises itself as "dependency-light" (`Protocol/ProtoEmb/README.md:3`).

### Recommended (not yet applied) local checks

If you want to lint before pushing, these match the current code with near-zero diff:

```bash
ruff check Protocol/ProtoEmb/core/        # finds unused imports, etc.
black --check Protocol/ProtoEmb/core/     # formatting
```

Note: `ruff`/`black` would flag the function-local `import re` inside `generate()` (`generate.py:818`) as a redundant/out-of-place import (`re` is already imported at module top, `generate.py:22`). Prefer module-level imports for new code; do not introduce more function-local imports.

---

## Module & package layout

ProtoEmb's Python lives in `core/`; everything else in `Protocol/ProtoEmb/` is Rust (`framing/`, `runtime/`) or assets (`templates/`, `examples/`, `docs/`).

```
Protocol/ProtoEmb/
  core/
    generate.py        # the generator (CLI + schema processing + validation + render)
    cargo_build.py     # thin wrapper called from a crate's build.rs (rs target only)
    pyproject.toml     # packaging only → `protoemb-gen` console script
    requirements.txt   # pyyaml, jinja2
    templates/         # protocol.{c,h,ts,rs}.j2 + protocol_runtime.{c,h}.j2
  framing/  runtime/   # Rust crates (not Python)
  examples/  docs/
Firmware/MaDCore/extra_scripts/
    generate_protocol.py   # PlatformIO pre-build SCons hook → C codegen
    archive_lib.py         # PlatformIO link-step replacement (native_emulator → libfirmware.a)
```

(The six template files actually present: `protocol.c.j2`, `protocol.h.j2`, `protocol.ts.j2`, `protocol.rs.j2`, `protocol_runtime.c.j2`, `protocol_runtime.h.j2`.)

- **`generate.py` is a single flat module** (`[tool.setuptools] py-modules = ["generate"]`, `pyproject.toml:27`) organized into banner-commented sections: *Schema Processing → Validation → Code Generation → Main*. Each section is delimited by a `# ====…` rule (`generate.py:80`/`:82`, `:544`/`:546`, `:786`/`:788`, `:856`/`:858`) with the title between the rules (`# Schema Processing` at `:81`, `# Validation` at `:545`, `# Code Generation` at `:787`, `# Main` at `:857`). Keep that ordering and banner style when adding code.
- **Do** keep new generator logic in `generate.py`; only add a new module if it is genuinely reusable. The SCons scripts in Firmware must stay tiny — they shell out to `generate.py`, they do not reimplement it.

---

## CLI conventions

Both `generate.py` and `cargo_build.py` use **`argparse`** with the same shape (`generate.py:860`–`:869`):

```python
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
```

**Rules:**

- **Long `--flags` only**, lowercase, double-dashed, single-word. No short aliases (`--schema`, `--target`, `--output`, `--templates`, `--prefix`, `--config`).
- **Constrain values with `choices=`** where the set is closed (`--target` `choices=["c", "ts", "rs"]`, `generate.py:866`). This is the canonical list of targets — adding a target means adding it here *and* in `target_files()` (`generate.py:790`).
- **`required=True`** for mandatory inputs; `required=False, default=None` for optional ones. State the default in the `help=` string.
- **Resolve paths relative to the script**, not the CWD, using `Path(__file__).parent` so the tool works from any directory (`generate.py:872`–`:873`):

  ```python
  script_dir = Path(__file__).parent
  template_dir = args.templates or str(script_dir / "templates")
  ```

- **Always end an executable module with the guard** (`generate.py:893`, `cargo_build.py:65`):

  ```python
  if __name__ == "__main__":
      main()
  ```

- **`main()` is the console entry point** wired in packaging as `protoemb-gen = "generate:main"` (`pyproject.toml:24`). Keep `main()` thin: parse args → resolve template dir → `load_yaml` → `load_generator_config` → `resolve_prefix` → `process_schema` → `validate_schema` → `generate` (`generate.py:870`–`:890`).

### Subprocess wrapper pattern

When one Python script shells out to another (e.g. `cargo_build.py` → `generate.py`, or the PlatformIO hook → `generate.py`), use `sys.executable`, capture output, and **propagate the child's return code** (`cargo_build.py:51`–`:62`):

```python
result = subprocess.run(command, capture_output=True, text=True)
if result.stdout:
    print(result.stdout, end="")
if result.stderr:
    print(result.stderr, end="", file=sys.stderr)
sys.exit(result.returncode)
```

- **Do** build the argv as a list passed to `subprocess.run` (never `shell=True`).
- **Do** invoke the generator as `[sys.executable, str(generate_script), "--schema", ...]` so it runs under the same interpreter (`cargo_build.py:39`–`:46`, `generate_protocol.py:37`).
- Note the two callers differ slightly: `cargo_build.py` mirrors the child's exit code with `sys.exit(result.returncode)` (`:62`), while the SCons hook checks `result.returncode != 0` and calls `env.Exit(1)` (`generate_protocol.py:45`–`:48`) — match the surrounding convention of the file you edit.

---

## Naming

| Kind | Convention | Example (file:line) |
|---|---|---|
| Functions | `snake_case` | `compute_enum_bits`, `process_schema`, `validate_unions` (`generate.py:84`, `:237`, `:568`) |
| Classes | `PascalCase` | `class _SchemaLoader(yaml.SafeLoader)` (`generate.py:34`) |
| Module-level constants | `UPPER_SNAKE` | `DEFAULT_PREFIX`, `TYPE_RANGES`, `_PRIMITIVE_TYPES` (`generate.py:61`, `:550`, `:562`) |
| Internal / module-private | leading underscore | `_SchemaLoader`, `_PRIMITIVE_TYPES`, `_RUST_KEYWORDS`, `_ch` (`generate.py:34`, `:562`, `:827`, `:38`) |
| Local vars | `snake_case`, terse | `enum_def`, `struct_def`, `msg_def`, `ftype`, `fmin`, `fmax` |

**Schema-enrichment key convention (important and project-specific):** every computed/derived field added to a schema dict uses a **leading-underscore string key** so templates can distinguish raw-schema values from generator-computed ones (`generate.py:248`–`:406`):

```python
enum_def["_name"]    = name
enum_def["_bits"]    = compute_enum_bits(enum_def)
field["_is_struct"]  = ftype in structs
field["_elem_bits"]  = elem_bits
struct_def["_wire_size"] = math.ceil(total_bits / 8)
```

- **Do** prefix any new computed dict key with `_` (e.g. `field["_my_new_thing"]`). Templates read these directly.
- **Don't** mutate or overwrite a raw schema key (like `field["type"]`) — add a derived `_`-key instead.

---

## Types & data shapes

- **Type hints are largely absent.** The codebase passes plain `dict`s (the parsed schema) around and annotates almost nothing. Match this: do not retrofit annotations onto existing untyped functions just for style.
- **Recommended (not yet applied):** *new* standalone helpers may carry simple hints if they improve clarity, but keep them 3.9-compatible (prefer `Optional`/`List` from `typing`, or `from __future__ import annotations` if you want `X | Y`/`list[...]` syntax — neither is currently used). Given the current zero-hint baseline, **no hints is the conforming choice.**
- **Numeric/type metadata lives in module-level lookup dicts**, not scattered literals. Reuse and extend these rather than inlining sizes:
  - `TYPE_RANGES` — native int min/max for validation (`generate.py:550`).
  - `_PRIMITIVE_TYPES` — the set of scalar type names (`generate.py:562`).
  - inline `type_bits` / `type_sizes` maps inside the bit/byte computations (`generate.py:127`, `:374`).
- **`process_schema` returns a single flat `dict`** that is spread into the Jinja render context (`generate.py:513`, consumed at `:849` via `template.render(**data)`). Any new value a template needs must be added to that returned dict.

---

## Docstrings & comments

- **Module docstring** at the top of every script: a one-line title, a paragraph of what it does, and a `Usage:` block (`generate.py:1`, `cargo_build.py:1`, `generate_protocol.py:1`, `archive_lib.py:1`).
- **One-line imperative docstring on essentially every function** (PEP 257 style), e.g. `"""Compute bits needed to represent an enum."""` (`generate.py:85`), `"""Resolve the library prefix from CLI flag, schema, or default."""` (`generate.py:65`).
- **Comments explain *why*, with `# ── … ──` rule-style headers** for conceptual blocks (`generate.py:30`, `:56`). The "OFF/ON" YAML-bool comment (`generate.py:31`–`:33`) is a model: capture the non-obvious rationale, not the obvious mechanics.
- **Do** keep the leading `#!/usr/bin/env python3` shebang on executable scripts (`generate.py:1`, `cargo_build.py:1`). Note the PlatformIO SCons scripts have **no** shebang — they are imported by SCons, not run directly.

---

## Strings & formatting

- **f-strings everywhere** for messages and identifiers (`generate.py:74`, `:156`, `:783`). Do not use `%`-formatting in `generate.py`/`cargo_build.py`.
  - Exception: the **SCons helper `archive_lib.py` uses `%` formatting** (`archive_lib.py:27`–`:31`) to match SCons-script idiom. New SCons code may follow either, but prefer f-strings unless mirroring surrounding code.
- **Use `!r` in error messages** to quote/repr user-supplied values so bad input is unambiguous (`generate.py:74`, `:659`, `:737`, `:743`):

  ```python
  raise SystemExit(
      f"Invalid prefix {prefix!r}: must be a valid identifier ...")
  ```

- **Validate identifiers with `str.isidentifier()`** rather than regex where applicable (`generate.py:72`).

---

## Error handling & exit codes

This is the most important behavioral convention — get it right so build hooks fail loudly.

- **User-facing / schema errors → `raise SystemExit(...)`** with a human-readable message (`generate.py:73`, `:156`, `:330`, `:539`, `:781`). `SystemExit` produces a non-zero exit and a clean message (no traceback), which the PlatformIO and Cargo hooks treat as a build failure.
- **Accumulate-then-report for validation.** `validate_schema` collects every problem into an `errors` list, prints each to `stderr`, and raises once with a count (`generate.py:778`–`:781`):

  ```python
  if errors:
      for e in errors:
          print(f"ERROR: {e}", file=sys.stderr)
      raise SystemExit(f"Schema validation failed with {len(errors)} error(s)")
  ```

  **Do** add new validations by appending to `errors` (pass the list down, as `validate_unions(data, errors)` does at `generate.py:599`) — don't short-circuit on the first problem.
- **Diagnostics → `stderr`; progress → `stdout`.** Success notes like `Generated: <path>` and `Schema validation passed: …` go to `stdout` (`generate.py:853`, `:783`); errors go to `stderr` with an `ERROR:`/`WARNING:` prefix (`generate.py:780`).
- **`ValueError` for programmer errors** (an internal contract violation, e.g. an unknown target reaching `generate()`), reserved for genuinely-shouldn't-happen cases (`generate.py:845`).
- **Don't** use bare `exit()`, `assert` for validation, or `sys.exit(string)` in the generator. The only `sys.exit(...)` is the subprocess return-code passthrough in `cargo_build.py:62`.

---

## File I/O & paths

- **Open files with a `with` block and an explicit mode** (`generate.py:53`, `:851`):

  ```python
  with open(path, "r") as f:
      return yaml.load(f, Loader=_SchemaLoader)
  ...
  with open(output_path, "w") as f:
      f.write(rendered)
  ```

- **Create output dirs idempotently** with `os.makedirs(output_dir, exist_ok=True)` before writing (`generate.py:841`, `cargo_build.py:36`).
- **`pathlib` vs `os.path` — follow the file you are editing:**
  - **`generate.py` mixes both:** `pathlib.Path` for resolving the script-relative templates dir (`generate.py:872`), but `os.path.join` / `os.makedirs` for output paths (`generate.py:841`, `:850`). Both are acceptable here; prefer `pathlib` for new path *construction*.
  - **The PlatformIO SCons scripts use `os.path` exclusively** (`generate_protocol.py:16`, `archive_lib.py:17`) — stay with `os.path` there to match SCons conventions and `env.subst("$PROJECT_DIR")` usage.

---

## YAML parsing conventions

The generator uses a **hardened SafeLoader subclass**, never `yaml.load` with the default loader (`generate.py:34`–`:54`):

```python
class _SchemaLoader(yaml.SafeLoader):
    pass
# ...strip YAML-1.1 implicit bool resolution so OFF/ON/YES/NO stay strings...
def load_yaml(path):
    """Load a YAML file with the schema-safe loader."""
    with open(path, "r") as f:
        return yaml.load(f, Loader=_SchemaLoader)
```

- **Always parse schema/config YAML through `load_yaml()`** — never call `yaml.safe_load`/`yaml.load` directly. The custom loader is what keeps enum variant names like `OFF` from being coerced to booleans (the rationale comment at `generate.py:31`–`:33` is load-bearing).
- **Treat a parsed config defensively:** `load_generator_config` returns `{}` for a missing path and `raise SystemExit(...)` if the YAML isn't a mapping (`generate.py:531`–`:541`). Mirror this `or {}` + type-check pattern for new optional inputs.
- **Read optional schema keys with `.get(key, default)`** and normalize immediately (e.g. `schema.get("prefix") or schema.get("library_name") or DEFAULT_PREFIX`, `generate.py:66`–`:71`).

---

## Templating (Jinja2)

The generator is fundamentally a Jinja2 renderer. Conventions are concentrated in `generate()` (`generate.py:804`) and the `.j2` files.

### Engine configuration

The `Environment` is created once per `generate()` call with fixed whitespace settings — **do not change these**, they affect every template's output formatting (`generate.py:806`–`:811`):

```python
env = Environment(
    loader=FileSystemLoader(template_dir),
    keep_trailing_newline=True,
    trim_blocks=True,
    lstrip_blocks=True,
)
```

### Custom filters & globals (the template vocabulary)

Templates rely on a fixed set of registered filters/globals (`generate.py:814`–`:839`). Use these in templates; add new ones here (not inline in templates):

```python
env.filters["upper_snake"]  = lambda s: s.upper()
env.filters["camel_case"]   = lambda s: "".join(w.capitalize() for w in s.split("_"))
env.filters["lower_camel"]  = ...
env.filters["snake_case"]   = to_snake_case      # camelCase/PascalCase → snake_case
env.filters["rust_safe"]    = lambda s: f"r#{s}" if s in _RUST_KEYWORDS else s
env.globals["ceil"] = math.ceil
env.globals["log2"] = math.log2
env.globals["int"]  = int
```

- **Do** put any reusable identifier transform (casing, keyword escaping) in a named `env.filters[...]` entry, and keep templates calling `{{ name | camel_case }}` / `{{ kw | rust_safe }}`.
- **Don't** push complex logic into templates — compute it in `process_schema` and expose a `_`-key. Templates should read derived state, not derive it. (Templates do use small inline `{% if %}` over the `_is_*`/`_min`/`_scale` flags, e.g. the leaf macros in `protocol.rs.j2:23`–`:25`.)

### Template naming & target mapping

`target_files()` is the single source of truth mapping a `--target` to its `(template, output)` pairs, named by the resolved library prefix (`generate.py:790`–`:801`):

```python
"c":  [("protocol.h.j2",  f"{prefix_lower}.h"),
       ("protocol.c.j2",  f"{prefix_lower}.c"),
       ("protocol_runtime.h.j2", f"{prefix_lower}_runtime.h"),
       ("protocol_runtime.c.j2", f"{prefix_lower}_runtime.c")],
"ts": [("protocol.ts.j2", f"{prefix_lower}.ts")],
"rs": [("protocol.rs.j2", f"{prefix_lower}.rs")],
```

Template filename convention: **`protocol[_runtime].<lang>.j2`**, where `<lang>` ∈ {`c`, `h`, `ts`, `rs`}. To add a template or target, edit `target_files()` (and `--target choices=` if it's a new language).

### Mandatory "do-not-edit" banner

Every template emits a header marking the output as generated, in that language's comment syntax (`protocol.h.j2:1`–`:7` uses `/** … DO NOT EDIT */`; `protocol.rs.j2:1`–`:4` uses `//! … DO NOT EDIT`). **Any new template must emit the same banner**, including `Protocol version: {{ protocol_version }}`.

### Prefix / identity in templates

Templates receive `prefix`, `prefix_upper`, `prefix_lower` (`generate.py:515`–`:517`) and must use them — never hardcode `ProtoEmb`. C symbols are `{{ prefix_upper }}_…` / `{{ prefix }}_…_E` (e.g. the node define at `protocol.h.j2:23` and the enum typedef `} {{ prefix }}_{{ name }}_E;` at `protocol.h.j2:39`); TS/Rust use schema names directly (`generate.py:8`–`:11`). For Rust enums, case identifiers with `| camel_case` (`protocol.rs.j2:64`) and escape reserved words with `| rust_safe` on field names (`protocol.rs.j2:240`, `:249`).

### Type mapping

Wire-size and bit-width type maps live in Python (`compute_field_bits`, the inline `type_bits`/`type_sizes` dicts at `generate.py:127`/`:374`, and `TYPE_RANGES` at `:550`), **not** in templates. When adding a primitive type: register it in `_PRIMITIVE_TYPES`, give it sizes in those maps and ranges in `TYPE_RANGES`, then expose a `_is_*` flag and emit it in each `.j2`.

---

## Generated code (do not hand-edit)

The Python's *output* — `Firmware/MaDCore/src/Generated/`, `Software/MaDWasmControl/src/protocol/generated/` (the shipped app; legacy Electron target was `Software/MaDControl/src/main/generated/`), and `SIL/mad-protocol/src/generated/` — is regenerated and **must not be hand-edited** (root `CLAUDE.md`; banner at `protocol.h.j2:2`). (Note: the SIL Rust output goes to `SIL/mad-protocol/src/generated/` per `SIL/Makefile:33`; the `SIL/embsim/peripherals/src/generated/` path some older docs reference does not exist.) To change generated code:

1. Edit `Protocol/MaDProtocol.yaml` (schema) and/or a `.j2` template.
2. Regenerate (see the commands in root `CLAUDE.md`, or `python3 core/generate.py --schema … --target … --output … --templates core/templates`).
3. Run `examples/verify.sh` to confirm C/Rust/TS still produce identical wire bytes.

The firmware build regenerates C automatically via the pre-build hook (`generate_protocol.py`), so committing stale generated C is unnecessary but harmless; never patch it by hand.

---

## Quick checklist for a generator change

- [ ] New CLI option added to **both** the argparse parser and its `help=` default note; `choices=` used if the value set is closed.
- [ ] New derived data exposed as a `_`-prefixed key in the schema dict and threaded into the dict returned by `process_schema`.
- [ ] New validations append to the shared `errors` list and use `{value!r}` in messages.
- [ ] User errors `raise SystemExit(...)`; diagnostics to `stderr`, progress to `stdout`.
- [ ] No new runtime dependency beyond `pyyaml` / `jinja2`.
- [ ] Syntax stays 3.9-compatible (no `match`, no `X | Y` annotations) — CI builds firmware on 3.9.
- [ ] YAML read via `load_yaml()`; files via `with open(...)`; dirs via `os.makedirs(..., exist_ok=True)`.
- [ ] Templates updated for all affected targets; each keeps its DO-NOT-EDIT banner and uses `prefix*` not a hardcoded name.
- [ ] `bash Protocol/ProtoEmb/examples/verify.sh` passes (C == Rust == TS).
