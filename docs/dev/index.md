# Developer Guide

Everything you need to build, run, test, and extend MaD.

<div class="grid cards" markdown>

-   [:material-folder-outline: **Repository layout**](repo-layout.md) — what lives where
-   [:material-chip: **Building the firmware**](building-firmware.md) — PlatformIO targets
-   [:material-web: **Running the app**](running-the-app.md) — Vite + WASM dev loop
-   [:material-test-tube: **SIL testing**](sil-testing.md) — the emulator + Playwright
-   [:material-code-braces: **Protocol & codegen**](protocol-codegen.md) — regenerate C/TS/Rust
-   [:material-puzzle: **Reusing embsim**](reusing-embsim.md) — the SIL framework elsewhere
-   [:material-rocket-launch: **CI/CD & releases**](ci-cd-and-releases.md) — pipelines and tags
-   [:material-hand-heart: **Contributing**](contributing.md) — conventions and constraints

</div>

## Prerequisites

| Tool | Version | For |
|---|---|---|
| [Node.js](https://nodejs.org/) | 20+ | The app, the SIL Playwright suite |
| [Rust](https://www.rust-lang.org/) | stable + `wasm32-unknown-unknown` | The protocol core, WASM, the SIL emulator |
| [`wasm-pack`](https://rustwasm.github.io/wasm-pack/) | latest | Building the app's WASM core |
| [Python](https://www.python.org/) | 3.8+ | The protocol generator and the docs site |
| [PlatformIO](https://platformio.org/) | 6.x+ | Building the firmware |
| [KiCad](https://www.kicad.org/) | 8+ | Hardware (optional) |

Rust, `wasm-pack`, and Python are only needed if you're building the app or
running SIL; PlatformIO only if you're building firmware.

## The fast paths

=== "Run the app against real hardware"

    ```bash
    cd Software/MaDWasmControl
    npm install
    npm run build:wasm        # compile the Rust protocol core → src/wasm/
    npm run generate:proto    # generate the TS codec from the YAML schema
    npm run app               # opens your browser; use Web Serial to connect
    ```

=== "Run the full simulation (no hardware)"

    ```bash
    cd SIL
    make setup                # first time: npm deps
    make test                 # build firmware + emulator, run Playwright
    ```

=== "Build firmware for the board"

    ```bash
    cd Firmware/MaDCore
    pio run -e propeller2          # build
    pio run -e propeller2 -t upload  # flash
    ```
