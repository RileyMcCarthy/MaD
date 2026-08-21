# Repository layout

MaD is a monorepo. Each top-level area is largely self-contained.

```text
MaD/
├── Firmware/MaDCore/        Embedded C for the Propeller 2
│   └── src/  APP · DEV · IO · Library · HAL · HW · Generated · Main
├── Software/
│   └── Control/      Browser control app (Web Serial + WASM) — the app you ship
├── Protocol/
│   ├── MaDProtocol.yaml     The single source-of-truth schema
│   ├── rust/                The `protocol` crate — generated Rust codec
│   └── ProtoEmb/            ⎘ submodule → github.com/RileyMcCarthy/protoemb
│       ├── core/            generate.py + Jinja templates
│       ├── framing/         protoemb-framing crate (wire frames + CRC)
│       ├── runtime/         protoemb-runtime crate + WASM client
│       └── docs/            wire-format.md
├── SIL/                     Software-in-the-loop test rig (Rust workspace)
│   ├── embsim/              ⎘ submodule → github.com/RileyMcCarthy/embsim
│   │                        (core, peripherals, models, runtime, p2, tools)
│   ├── models/              MaD-specific physics (gantry, sample, strain gauge)
│   ├── MaDSim/              The mad-emulator binary (entry + machine wiring)
│   └── test-fixtures/       Sample/motion profiles
├── Hardware/                KiCad PCBs (EdgeBoard, DS2Addon)
├── docs/  +  mkdocs.yml     This documentation site
└── .github/workflows/       CI (ci.yml) and Pages deploy (pages.yml)
```

## The protocol code generator and its outputs

The schema generates code into three places. **Never hand-edit generated files** —
change the YAML (or templates) and regenerate:

| Target | Generated into | Used by |
|---|---|---|
| C | `Firmware/MaDCore/src/Generated/` | Firmware (built via a PlatformIO pre-hook) |
| TypeScript | `Software/Control/src/protocol/generated/` | The app |
| Rust | `Protocol/rust/src/generated/` | The SIL emulator |

The Rust runtime (`Protocol/ProtoEmb/runtime`) is compiled to **WASM** for the
browser app. See [Protocol & code generation](protocol-codegen.md).

## The two protocol crates, demystified

- **`Protocol/ProtoEmb/runtime`** — the *generic* host runtime: the serial
  `Client`, priority queue, and the WASM client the app loads. Reusable, not
  MaD-specific.
- **`Protocol (the `protocol` crate)`** — *generated* MaD message types (structs/enums/codecs) for
  the Rust/SIL side. It's the Rust equivalent of the generated C and TypeScript
  codecs.

## Firmware layer rules

The firmware enforces a strict downward dependency (`APP → DEV → IO → Library →
HAL → HW`). Files are prefixed by layer (`app_`, `dev_`, `IO_`, `lib_`). Don't
include low-level MCU headers above the HAL. See [Firmware](../how-it-works/firmware.md).

