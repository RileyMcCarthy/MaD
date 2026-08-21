# Developer Guide

Everything you need to build, run, test, and extend MaD.

<div class="grid cards" markdown>

-   [:material-folder-outline: **Repository layout**](repo-layout.md) — what lives where
-   [:material-chip: **Building the firmware**](building-firmware.md) — PlatformIO targets
-   [:material-web: **Running the app**](running-the-app.md) — Vite + WASM dev loop
-   [:material-test-tube: **SIL testing**](sil-testing.md) — the firmware emulator
-   [:material-code-braces: **Protocol & codegen**](protocol-codegen.md) — regenerate C/TS/Rust
-   [:material-puzzle: **Reusing embsim**](reusing-embsim.md) — the SIL framework elsewhere
-   [:material-rocket-launch: **CI/CD & releases**](ci-cd-and-releases.md) — pipelines and tags
-   [:material-hand-heart: **Contributing**](contributing.md) — conventions and constraints
-   [:material-bug-check: **Bug-class coverage**](bug-class-coverage.md) — regression checklist for recurring failure modes
-   [:material-shield-check: **Bulletproof test plan**](bulletproof-test-plan.md) — matrix roadmap (M1–M12) + sprint status
-   [:material-chip: **Backend certification**](backend-certification.md) — stepper CI-certified vs servo
-   [:material-table: **Protocol messages**](protocol-messages.md) — the wire message map
-   [:material-code-tags: **G-code**](gcode.md) — the dialect the firmware plays back

</div>

## Prerequisites

| Tool | Version | For |
|---|---|---|
| [Node.js](https://nodejs.org/) | 20+ | The app and its E2E suite |
| [Rust](https://www.rust-lang.org/) | stable + `wasm32-unknown-unknown` | The protocol core, WASM, the SIL emulator |
| [`wasm-pack`](https://rustwasm.github.io/wasm-pack/) | latest | Building the app's WASM core |
| [Python](https://www.python.org/) | 3.8+ | The protocol generator and the docs site |
| [PlatformIO](https://platformio.org/) | 6.x+ | Building the firmware |
| [KiCad](https://www.kicad.org/) | 8+ | Hardware (optional) |

Rust, `wasm-pack`, and Python are only needed if you're building the app or
running SIL; PlatformIO only if you're building firmware.

!!! note "Initialize the submodules first"
    Two components are git submodules: [`Protocol/ProtoEmb`](https://github.com/RileyMcCarthy/protoemb)
    (protocol codegen + runtime) and [`SIL/embsim`](https://github.com/RileyMcCarthy/embsim)
    (the emulator framework). Every fast path below needs them:

    ```bash
    git clone --recurse-submodules https://github.com/RileyMcCarthy/MaD.git
    # or, in an existing checkout:
    git submodule update --init --recursive
    ```

## The fast paths

=== "Run the app against real hardware"

    ```bash
    cd Software/Control
    npm install
    npm run build:wasm        # compile the Rust protocol core → src/wasm/
    npm run generate:proto    # generate the TS codec from the YAML schema
    npm run app               # opens your browser; use Web Serial to connect
    ```

=== "Run the full simulation (no hardware)"

    ```bash
    cd SIL
    make test                 # build firmware + emulator, run cargo test
    ```

=== "Build firmware for the board"

    ```bash
    cd Firmware/MaDCore
    pio run -e propeller2          # build
    pio run -e propeller2 -t upload  # flash
    ```

## Deep dives

Design records kept alongside the code rather than duplicated here.

**Control app** —
[TEST_PLAN.md](https://github.com/RileyMcCarthy/MaD/blob/main/Software/Control/docs/TEST_PLAN.md)
(Rust unit, vitest, and live-SIL E2E layers) and
[HARDENING.md](https://github.com/RileyMcCarthy/MaD/blob/main/Software/Control/docs/HARDENING.md)
(safety model, failure recovery, data integrity, performance).

**Protocol** —
[ProtoEmb README](https://github.com/RileyMcCarthy/protoemb/blob/main/README.md)
(generator, framing, runtime) and
[wire-format.md](https://github.com/RileyMcCarthy/protoemb/blob/main/docs/wire-format.md)
(the canonical frame + payload contract).

**SIL framework** —
[embsim README](https://github.com/RileyMcCarthy/embsim/blob/main/README.md)
(the reusable framework and the ~10-line emulator) and
[CONTRACT.md](https://github.com/RileyMcCarthy/embsim/blob/main/CONTRACT.md)
(the symbols and ABI a platform crate must export).
