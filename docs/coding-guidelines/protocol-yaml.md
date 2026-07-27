# Protocol YAML Authoring Guidelines (`MaDProtocol.yaml`)

This document governs how to author and change the single source-of-truth protocol schema at `Protocol/MaDProtocol.yaml`, consumed by the **ProtoEmb** generator (`Protocol/ProtoEmb/core/generate.py`) to emit matching C, TypeScript, and Rust codecs. Edit the YAML — never the generated code — and regenerate all three targets.

> The schema describes both the **wire format** (`Protocol/ProtoEmb/docs/wire-format.md`) and a **routing/timing table**. A mistake here silently breaks firmware ↔ UI ↔ SIL interop, so follow the rules below exactly; the generator validates most of them and will refuse to emit on error.

---

## 1. Top-level structure

A schema is a single YAML mapping with these top-level keys (`MaDProtocol.yaml:1-11`, `:37`, `:102`, `:331`):

```yaml
protocol_version: 1

nodes:
  - ui
  - madcore

defaults:
  encoding: packed
  byte_order: little_endian
  bit_order: lsb_first
  reserved_bits: 0

enums:    { ... }
structs:  { ... }
unions:   { ... }   # optional; MaDProtocol.yaml has none today
messages: { ... }
```

- **`protocol_version`** (int) — emitted as a constant in every target (`PROTOEMB_PROTOCOL_VERSION 1`, verified in `Firmware/.../protoemb.h:18`). It is **not** part of the frame yet (`wire-format.md:84-87`). Bump it when you make a breaking change (see §8).
- **`nodes`** — the list of communicating endpoints. For MaD this is `ui` and `madcore`. Each node index becomes a constant (`PROTOEMB_NODE_UI 0U`, `PROTOEMB_NODE_MADCORE 1U`, verified in `protoemb.h:21-22`). Every message's `tx_node` **must** be in this list or validation fails (`generate.py:703-706`).
- **`defaults`** — global encoding defaults. `encoding: packed` is the project default (`generate.py:303` reads `defaults.encoding`). `byte_order` / `bit_order` / `reserved_bits` are read by the generator (`generate.py:518-519`) but, in practice, **only `encoding` changes generated output today** — `byte_order`/`bit_order` are not emitted as constants in any target, and the wire is hard-coded little-endian / LSB-first by the framing layer and templates. Do not change `byte_order` away from `little_endian` — both frame and payload layers assume LE (`wire-format.md:11`).
- **`prefix` / `library_name`** — optional library identity (default `ProtoEmb`). MaD relies on the default; the thermostat example overrides it with `prefix: Thermostat` (`examples/thermostat.yaml:5`). A prefix must be a valid identifier (`generate.py:72-76`).

**Do** keep the section comments (Priority Model, etc.) — they are load-bearing documentation for maintainers (`MaDProtocol.yaml:13-32`).

---

## 2. Naming conventions

These are enforced by example throughout `MaDProtocol.yaml`, and the generator's case filters (`generate.py:814-824`) derive `UPPER_SNAKE`, `camelCase`/`PascalCase`, and `snake_case` from your names — so case the names as below or the generated symbols will read wrong.

| Element | Casing | Examples (real) |
|---|---|---|
| Enum type | `PascalCase` | `FaultedReason`, `MotionState`, `GCode` (`:38`,`:62`,`:69`) |
| Enum variant | `UPPER_SNAKE` | `ESD_POWER`, `SAMPLE_LENGTH`, `RAPID_MOVE` (`:44`,`:55`,`:73`) |
| Struct type | `PascalCase` | `MachineState`, `Sample`, `StoredSample` (`:105`,`:119`,`:188`) |
| Struct field | `camelCase` | `faultedReason`, `machineForce`, `gcodeId` (`:109`,`:123`,`:311`) |
| Message | `snake_case` | `machine_configuration_write`, `test_run`, `file_download` (`:367`,`:379`,`:416`) |

**Do / Don't**
- **Do** give every enum a sentinel `NONE` first variant where "no value" is meaningful (`FaultedReason`, `RestrictedReason` start with `NONE` at index 0 — `:41`,`:54`).
- **Do** write boolean-ish enum values as `OFF`/`ON` in upper-snake (see the thermostat `Mode: [OFF, HEAT, COOL, AUTO]` at `examples/thermostat.yaml:18` and `FanCmd` `OFF/LOW/HIGH/AUTO` at `:24-27`).
- **Don't** worry that `OFF`/`ON`/`YES`/`NO` will be coerced to booleans — the generator installs a restricted YAML loader so **only** `true/false` (any case) resolve to bool; `OFF`/`ON` stay strings (`generate.py:34-48`). But do not hand-process this YAML with a stock YAML 1.1 parser, which would mangle those names.
- **Don't** duplicate field names within a struct or variant names within an enum/union — the validator rejects field-name duplicates (`generate.py:630-631`) and union-variant duplicates (`generate.py:580-581`). (There is no explicit duplicate-name check for *enum* variants, but duplicate variant names would still produce broken generated code — don't.)

---

## 3. Enums

```yaml
MotionState:
  description: "Motion subsystem state"
  variants:
    - DISABLED
    - WAITING
    - MOVING
```

- **Plain enum** — list of names; wire value = **index** in `ceil(log2(count))` bits (`wire-format.md:54-58`, `generate.py:84-89`). Index = declaration order, so **append new variants at the end** to avoid renumbering.
- **`remap: true`** — use when you need **sparse, semantic values** that differ from the index. The wire still carries the compact index; the generator emits index↔value tables. `GCode` is the canonical case (`MaDProtocol.yaml:69-81`):

```yaml
GCode:
  description: "G-code command identifiers"
  remap: true
  variants:
    - { name: RAPID_MOVE,   value: 0 }
    - { name: LINEAR_MOVE,  value: 1 }
    - { name: DWELL,        value: 4 }
    - { name: HOME,         value: 28 }
    - { name: STOP,         value: 122 }
```

  - For `remap`, every variant **must** be the `{ name:, value: }` form.
  - The generator auto-picks a dense lookup array vs. a sorted-table + binary search based on sparseness: it switches to search when the dense array `(max_value + 1)` would exceed **32 entries** *and* is less than half full — i.e. `dense_size > 32 and (variant_count * 2) < dense_size` (`generate.py:284-286`). `GCode`'s 9 values spread over 0..122 hit exactly this case. Override with `remap_style: array|search` only if you have a measured reason (`generate.py:279-287`). (Note: the code *comment* at `generate.py:275` says "256 entries", but the live logic uses 32 — trust the code.)
- **Bit budget is validated**: if you add variants past the power-of-two boundary the generator errors with `Enum X: N variants need ... bits but only ... allocated` (`generate.py:616-624`). Adding a variant can widen the packed field — re-check any struct that embeds the enum.

---

## 4. Structs and the field type system

A struct has an `encoding`, a `description`, and ordered `fields`. **Field declaration order is the wire order** (`wire-format.md:38-39`) — never reorder fields of a deployed struct without bumping the protocol version.

### 4.1 `packed` vs `aligned`

- **`packed`** — bit-level, no padding; size = `ceil(total_bits / 8)`. Use for **high-frequency / bandwidth-sensitive** wire messages. `MachineState` packs 4+3+1+1 bits into 2 bytes (`MaDProtocol.yaml:105-117`); `Sample`, `Move`, `StoredSample` are packed.
- **`aligned`** — byte-level, fixed C-type sizes. Use for **infrequent config** structs where layout stability/readability matters: `MachineConfiguration`, `SampleProfile`, `FirmwareVersion`, `TestRun`, `Notification` (`:222-326`).
- Pick the encoding deliberately and annotate the bit math in a comment, as the repo does (`# 4+3+1+1 = 9 bits → 2 bytes` at `:117`).
- **Rule:** a nested struct/union **must share its parent's encoding**. Mixing them is a hard error: `nested 'X' uses 'aligned' encoding but parent is 'packed'` (`generate.py:324-333`).

### 4.2 Scalar field keys

```yaml
- name: machineForce
  type: int32
  unit: N
  scale: 1000        # struct stores mN; use set/get accessors for N
  raw_storage: true
  min: -100
  max: 100
```

| Key | Meaning |
|---|---|
| `type` | `bool`, `float`, `int8/16/32/64`, `uint8/16/32/64`, `string`, an enum name, a struct name, or a union name. |
| `unit` | Documentation only (`N`, `mm`, `mm/s`, `ms`, `us`, `steps/mm`). Always set it. |
| `scale` | Integer steps per unit. In **TS** the codec multiplies/divides by `scale`; in **C/Rust** the in-memory struct already holds the scaled integer (`wire-format.md:45-48`). |
| `raw_storage: true` | Makes the "struct stores scaled int" explicit and generates `set*/get*` accessors. Use it whenever `scale != 1` on an integer field so firmware/UI agree on units. |
| `min` / `max` | In **packed** structs, the `(max-min)*scale+1` value-range derives the bit count; `min` enables offset-binary so signed/non-zero ranges use the full range (`generate.py:118-124`, `wire-format.md:50-51`). |
| `bits` | Explicit packed bit-width override (`generate.py:108-111`); use only when min/max can't express the intent. |
| `max_length` | For `string` only; the field is a fixed `max_length`-byte NUL-padded region (default 16 — `generate.py:106,368`; `wire-format.md:79-81`). E.g. `name` is `max_length: 20`, `gcodeId` is 7 (`:228`,`:313`). |

### 4.3 Validation rules you must satisfy (`generate.py:596-781`)

- `min`/`max` must fit the declared integer type (e.g. `int8` can't have `min: -1000`) — error tells you to widen the type (`generate.py:637-652`).
- A **fractional `scale` is only legal on a `float` field**; an integer field with a fractional scale is rejected (it would silently truncate) (`generate.py:677-683`).
- In a **packed** numeric field, the declared `min`/`max`/`scale` must actually fit the allocated bits, or you get `range [...] * scale ... needs N bits but only M allocated` (`generate.py:685-696`).

### 4.4 Composite fields (supported by generator; not yet used in `MaDProtocol.yaml`)

These exist in ProtoEmb and are exercised by `examples/thermostat.yaml`. Use them in MaD when needed:

- **Nested struct** — `type: OtherStruct`; child layout is inlined (`ZoneState.current: Reading`, `thermostat.yaml:61`).
- **Fixed array** — `count: N` → N consecutive elements (`Schedule.slots: int16, count: 8`, `thermostat.yaml:68`). **Cannot** be a `string` and **cannot** be `optional` (`generate.py:654-668`).
- **Optional** — `optional: true` prepends a 1-bit (packed) / 1-byte (aligned) presence flag (`SensorPacket.fault`, `SensorPacket.zone`, `thermostat.yaml:77-78`). **Cannot** combine with `count` or `string` (`generate.py:665-673`).
- **Tagged union** — declare under top-level `unions:` and reference it as a field type (`Datum.value: Sample`, `thermostat.yaml:51`). Variants may be scalars/enums/bools only — **string, struct, and nested-union variants are rejected** by the validator (`generate.py:584-593`). The wire carries a tag + a payload sized to the largest variant, keeping a fixed wire size (`wire-format.md:73-77`).

---

## 5. Messages — the routing/timing table

Each message is a `snake_case` key under `messages:` describing one logical exchange (`MaDProtocol.yaml:331-428`).

```yaml
sample:                 # periodic telemetry (madcore transmits)
  tx_node: madcore
  period_ms: 10
  command_id: 0
  priority: low
  response: Sample

machine_configuration_write:   # command (UI transmits)
  tx_node: ui
  command_id: 0
  priority: high
  request: MachineConfiguration
```

| Key | Rules |
|---|---|
| `tx_node` | **Required** non-empty string, and must be a node from `nodes:` (`generate.py:700-706`). |
| `command_id` | Selects the message on the wire. **READ and WRITE command-id spaces are independent** — `sample` (READ, `command_id: 0`) and `machine_configuration_write` (WRITE, `command_id: 0`) legitimately coexist (`:336`,`:369`; `wire-format.md:31-33`). Within each space, ids must be unique (`generate.py:746-763`). |
| `request` | A struct name, or one of the scalars `bool`, `none`, `raw`, `bytes` (`generate.py:726-729`). A struct named here must exist. |
| `response` | A **struct name only** — scalar shortcuts are *not* accepted here (`generate.py:731-732`); the named struct must exist. |
| `period_ms` | Present → periodic telemetry (READ frame). Must be a positive int **and** requires a `command_id` (`generate.py:716-723`). |
| `priority` | `high` or `low` only (`generate.py:740-744`). Informational metadata enforced by the **host queue, not the wire** (see Priority Model comment, `:13-32`). Default if omitted: `low` if periodic, else `high` (`generate.py:473-476`). |
| `command_frame` | Optional `read`/`write` override; normally inferred — periodic and payload-less queries → READ; state-changing commands and payload queries → WRITE (`generate.py:455-468`). |
| `note` | Free-text documentation for non-obvious payloads (`file_download`, `test_move` — `:421`,`:396`). |

**Hard constraints:**
- A message with **no `command_id` requires a `response`** (the async/unsolicited case, e.g. `notification` — `:425-428`, `generate.py:713-714`).
- **DATA-producing ids must be unique across all messages that return a payload**: any two messages that both set `response` and share a `command_id` are rejected, because the typed facade can't tell their DATA frames apart (`generate.py:768-776`).

**Do** group messages with the section comments the file already uses: periodic telemetry, read/query, commands, async (`:332`,`:347`,`:366`,`:424`).

---

## 6. Wire format contract (what a schema author must respect)

From `Protocol/ProtoEmb/docs/wire-format.md`. You author the **payload**; the generated runtimes own the **frame**, but your schema choices must stay frame-compatible.

- **Frame**: every frame starts with sync `0x55`; type byte is direction-overloaded (`0x00` READ/NACK, `0x01` WRITE/ACK, `0x02` DATA, `0x03` NOTIFICATION); 16-bit LEN; `CRC8` is CRC-8/MAXIM over `DATA` only (`wire-format.md:14-29`). Payloads are capped at `MAX_PAYLOAD` (default 4096 — emitted as `PROTOEMB_RUNTIME_MAX_PAYLOAD` in the C runtime, `protoemb_runtime.h:13`) — keep `string`/array/union sizes well under that.
- **Payload**: every struct/union has a **fixed wire size** known at generation (`*_WIRE_SIZE`); fields are laid out in declaration order. This is why field/variant **order and bit budgets are part of the contract**.
- There is no byte-stuffing; integrity rests on CRC + a clean stream (`wire-format.md:28-29`). Don't design payloads that assume in-band escaping.

### Cross-language conformance (C == Rust == TS)

The same schema must produce **byte-identical** wire output from all three backends — this is the project's central invariant (`README.md:6-7`) and is checked by `examples/verify.sh`. The script generates the thermostat example to C/Rust/TS, compiles/typechecks each, and `diff`s hex dumps of identical encodings; a mismatch exits non-zero (`verify.sh:39-60`). **Any schema feature you use must round-trip identically in all three targets** — that's the whole point of authoring once in YAML.

---

## 7. Multi-node source addressing (opt-in)

Addressing is **off** for MaD (point-to-point UI↔madcore) and the frame is unchanged (`framing/src/lib.rs:127-136`). The schema's `nodes:` list always emits node-ID constants, but a 1-byte source address is only added when a transport opts in:

```rust
// framing/src/lib.rs:138-145
pub fn build_read_frame_from(source: u8, command: u8) -> Vec<u8> { ... }   // [SYNC][SRC][0x00][CMD]
pub fn build_write_frame_from(source: u8, command: u8, data: &[u8]) -> Vec<u8> { ... }
// FrameParser::with_addressing() expects [SRC] after SYNC (framing/src/lib.rs:214).
```

**Do** keep `nodes:` accurate even though MaD is point-to-point — the constants are how addressed framing (RS-485/multi-drop) would identify senders later. **Don't** enable addressing for MaD; the CRC still covers payload only either way (`framing/src/lib.rs:136`).

---

## 8. Versioning, ordering, and packing implications

- **Append, don't reorder/insert.** Enum variant indices, struct field order, and union variant order are all wire-significant. Adding a field/variant at the end is the only change that doesn't shift existing offsets.
- **Widening a packed field changes its byte size.** Raising an enum's variant count past a power-of-two boundary, or widening a numeric `min`/`max`/`scale` range, can grow the packed struct — a breaking wire change.
- **Bump `protocol_version`** on any breaking change. Note there is currently **no on-wire version handshake** (`wire-format.md:84-87`), so a version bump is a human/coordination signal: firmware, desktop app, and SIL must be regenerated and shipped together.
- `runtime:` block (`max_payload`, `frame_timeout_ms`) is supported by the generator (`generate.py:511`, `:520-521`; defaults 4096 / 100 ms) and is what sizes `PROTOEMB_RUNTIME_MAX_PAYLOAD` / `PROTOEMB_RUNTIME_TIMEOUT_MS` in the C runtime. It is **unused by `MaDProtocol.yaml`** today (no `runtime:` block), so the defaults apply; leave it out unless you have a measured need.

---

## 9. The end-to-end workflow to add or change a message

1. **Edit** `Protocol/MaDProtocol.yaml` (add/modify enum, struct, or message). Follow §2–§5.
2. **Regenerate all three targets** from the repo root (the C/TS commands match `CLAUDE.md`; the **Rust output path is corrected below**):

```bash
python3 ./Protocol/ProtoEmb/core/generate.py --schema ./Protocol/MaDProtocol.yaml --target c  --output ./Firmware/MaDCore/src/Generated        --templates ./Protocol/ProtoEmb/core/templates
python3 ./Protocol/ProtoEmb/core/generate.py --schema ./Protocol/MaDProtocol.yaml --target ts --output ./Software/Control/src/protocol/generated --templates ./Protocol/ProtoEmb/core/templates
python3 ./Protocol/ProtoEmb/core/generate.py --schema ./Protocol/MaDProtocol.yaml --target rs --output ./Protocol/rust/src/generated      --templates ./Protocol/ProtoEmb/core/templates
```

   - **Rust output path:** the live `SIL/makefile:33` generates into `./Protocol/rust/src/generated`, and `Protocol/rust/src/generated/protoemb.rs` is the file that exists on disk. There is **no** `SIL/embsim/peripherals/src/generated/` directory. From `SIL/`, just run `make protocol` (which also runs as part of `make emulator` / `make test`, `SIL/makefile:40,44`).
   - **Firmware C is also generated automatically** by the PlatformIO **pre-build hook** `extra_scripts/generate_protocol.py`, wired in via `platformio.ini:2` (`extra_scripts = pre:extra_scripts/generate_protocol.py`). So `pio run`/`pio test` regenerate `src/Generated/` from the YAML on every build (`generate_protocol.py:35-48`). The explicit C command above is still useful for a quick check without a full build.

3. **Generator deps** (one-time): `pip install -r Protocol/ProtoEmb/core/requirements.txt` (pyyaml ≥ 6.0, jinja2 ≥ 3.1 — verified contents). The firmware pre-hook installs these into PlatformIO's Python automatically (`generate_protocol.py:28-33`).
4. **Update consumers** of the regenerated types: firmware (`Firmware/MaDCore/src/Generated/`), the shipped app (`Software/Control/src/protocol/generated/protoemb.ts`; regenerate via `npm run generate:proto`), and SIL (`Protocol/rust/src/generated/protoemb.rs`). (The legacy Electron app's target was `Software/MaDControl/src/main/generated/protoemb.ts`, used by `BridgeHandler`.)
5. **Commit the regenerated files together with the YAML change.** Do not let them drift. (Note: CI does **not** assert generated files are in sync with the YAML — see §11 — so this is on you.)

---

## 10. Generated code is off-limits

Every target carries a **DO NOT EDIT** banner (verified: `Firmware/.../protoemb.h:3`, `protoemb.ts:3`, `protoemb.rs:1`). Per `CLAUDE.md`, never hand-edit:

- `Firmware/MaDCore/src/Generated/` (`protoemb.{h,c}`, `protoemb_runtime.{h,c}`)
- `Software/Control/src/protocol/generated/protoemb.ts` (shipped app; legacy: `Software/MaDControl/src/main/generated/protoemb.ts`)
- `Protocol/rust/src/generated/protoemb.rs`

To change behavior, edit the **YAML** or, for structural output changes, the **Jinja templates** in `Protocol/ProtoEmb/core/templates/*.j2` — then regenerate.

---

## 11. Linting / passing checks

There is **no dedicated linter for the YAML file itself**; correctness is enforced by the generator's built-in validator plus downstream compilers.

### a. Schema validation (the primary gate)

Running `generate.py` validates the schema and **fails with a non-zero exit** on any error, printing `ERROR: ...` lines and `Schema validation failed with N error(s)` (`generate.py:778-781`). On success it prints `Schema validation passed: N enums, M structs, K messages` (`generate.py:783`). The firmware pre-hook treats a non-zero exit as a build failure (`generate_protocol.py:45-48`). So:

- **Run all three `generate.py` commands (§9) and confirm each prints "Schema validation passed"** before committing. The validator catches duplicate field names and duplicate union-variant names, unknown enum/struct references, min/max not fitting the type, fractional scale on non-float, packed bit-budget overflows, nested-encoding mismatches, missing/unknown `tx_node`, duplicate READ/WRITE/DATA command ids, and bad `priority`/`command_frame`/`period_ms` (`generate.py:596-781`).

### b. Cross-language wire conformance

```bash
./Protocol/ProtoEmb/examples/verify.sh
```

Generates the thermostat example to C/Rust/TS, compiles (`cc -std=c11 -Wall -Wextra`), runs the Rust `--test` round-trip, `tsc --noEmit --strict` typechecks, and asserts **byte-identical** hex across all three (`verify.sh:18-60`). This script is **not wired into CI** (see §11e); run it manually whenever you touch a schema feature or a template — it's the regression guard for the C==Rust==TS contract.

### c. Downstream compilation must still pass

- **Firmware (C / MISRA + CERT):** generated C is **deliberately excluded from `pio check`** — `check_src_filters` lists `src/APP`, `DEV`, `IO`, `Library`, `Main` and **not** `src/Generated/` (`platformio.ini:4-9`). So MISRA C:2023 / CERT (via cppcheck) do **not** apply to generated protocol code, and you do **not** add suppressions there. Your obligation is that `pio run -e native_emulator` / `pio test -e native_test` **compile** the generated code (it's in `build_src_filter` via `+<Generated/>`, `platformio.ini:22`).
- **Rust (SIL):** the generated `protoemb.rs` carries `#![allow(dead_code, clippy::identity_op, clippy::excessive_precision)]` (verified at `protoemb.rs:6`), so it passes `clippy` without hand-tuning. Ensure `cargo build` in `SIL/` succeeds after regeneration (`make protocol && cargo build`).
- **TypeScript (shipped app):** the generated `protoemb.ts` must typecheck under the app's `tsc`/ESLint. After `npm run generate:proto`, run `npm run verify` in `Software/Control/` (tsc + eslint + Vitest + build). (Legacy Electron app: `npm run lint:fix` + `npm test` in `Software/MaDControl/`.)

### d. Python generator/templates (if you edit them)

The generator targets Python ≥ 3.9 (`core/pyproject.toml`) with only `pyyaml` + `jinja2`. There is no enforced formatter checked in; keep edits consistent with the existing PEP-8 style and re-run `verify.sh` to confirm you didn't change generated output unintentionally.

### e. What CI actually does for `Protocol/**` changes

CI is `.github/workflows/ci.yml`. A **Protocol-only** change triggers exactly one job — `wasm-control-ci` (gated on the `Protocol/**` path filter, `ci.yml:48-50`). That job:
- runs `cargo test` in `Protocol/ProtoEmb/runtime` (`ci.yml:79-81`),
- **regenerates** the protocol bindings for the WASM control app (`npm run generate:proto`, `ci.yml:84-87`), then
- runs `npm run verify` (typecheck + lint + tests + build, `ci.yml:88-89`).

It does **not** run `verify.sh`, and it does **not** diff the regenerated output against the committed generated files (no in-sync assertion). Note also that the `build-firmware` / `build-software` / `sil-tests` jobs are gated on `Software/**` / `Firmware/**` only (`ci.yml:5-17`, `:94-96`), so a Protocol-only commit does **not** exercise the firmware C codegen or the SIL Playwright suite in CI — run those locally.

---

## 12. Quick checklist before you commit

- [ ] New enum variants / struct fields / union variants **appended at the end** (no reordering).
- [ ] Every numeric field has `unit`; every scaled integer has `raw_storage: true`.
- [ ] `min`/`max` fit the declared type; packed ranges fit allocated bits; fractional `scale` only on `float`.
- [ ] Nested struct/union shares parent `encoding`.
- [ ] Message `tx_node` is in `nodes:`; READ/WRITE/DATA `command_id`s don't collide; `response` names a struct; `priority` is `high`/`low`.
- [ ] Breaking change → `protocol_version` bumped.
- [ ] Ran all three `generate.py` commands — each printed "Schema validation passed".
- [ ] Ran `verify.sh`; firmware builds (`native_emulator`/`native_test`), `cargo build` (SIL), `tsc`/lint (desktop) pass.
- [ ] Regenerated files committed alongside the YAML (CI won't catch drift); no hand-edits to generated code.
