# MaD — Low-Cost Open-Source Tensile Testing Machine

A relatively low-cost (**< $4,000**), portable, spray-resistant, user-modifiable,
open-source **uniaxial tensile testing machine** designed for low-modulus
elastomeric and biologic materials.

**📖 Documentation: <https://rileymccarthy.github.io/MaD/>** ·
**🚀 Run the control app: <https://rileymccarthy.github.io/MaD/app/>** (Chrome/Edge)

> The full guides — first-time setup, every UI screen with screenshots, the
> architecture, and developer/reference material — live on the
> [documentation site](https://rileymccarthy.github.io/MaD/). This README is the
> quick map.

## Specifications

| Parameter | Range |
|---|---|
| Strain Rate | 0 – 2 m/s |
| Force Measurement | 1 – 10 N |
| Gauge Length | 10 – 150 mm |
| Strain Length | 0 – 500 mm |
| Data Rate | 1000 samples/sec |

## The control app runs in your browser

The control app — **MaDWasmControl** — is a frontend-only Progressive Web App.
There is **nothing to install**: the browser talks straight to the Propeller 2
over the **Web Serial API**, and the protocol logic runs as **WebAssembly**
compiled from the same Rust core used by the firmware tooling and the test rig.

Open **<https://rileymccarthy.github.io/MaD/app/>** in Chrome or Edge, connect
over USB, and run a test. See the
[operator quick-start](https://rileymccarthy.github.io/MaD/getting-started/operators/).

> **Chromium-only:** Web Serial and the File System Access API are available only
> in Chrome/Edge on desktop.

## Repository structure

```
MaD/
├── Firmware/MaDCore/        Embedded C for the Propeller 2 (APP/DEV/IO/Library/HAL/HW)
├── Software/
│   └── MaDWasmControl/      Browser control app (Web Serial + WASM) — the app you ship
├── Protocol/
│   ├── MaDProtocol.yaml     Single source-of-truth schema
│   └── ProtoEmb/            ⎘ submodule → github.com/RileyMcCarthy/protoemb (YAML→C/TS/Rust codegen + runtime)
├── SIL/                     Software-in-the-loop test rig (Rust workspace)
│   ├── embsim/              ⎘ submodule → github.com/RileyMcCarthy/embsim (reusable SIL framework)
│   ├── models/              MaD physics models (gantry, sample, strain gauge)
│   ├── mad-protocol/        Generated Rust protocol types for SIL
│   ├── MaDSim/              The mad-emulator binary (entry + machine wiring)
│   └── tests/               Playwright E2E specs
├── Hardware/                KiCad PCB designs (EdgeBoard, DS2Addon)
└── docs/  +  mkdocs.yml     The documentation site
```

> A legacy Electron desktop app exists at `Software/MaDControl/`. The browser app
> has reached full parity and is the documented, deployed application.

> Two components are **git submodules** (they are standalone open-source
> libraries): [`Protocol/ProtoEmb`](https://github.com/RileyMcCarthy/protoemb)
> and [`SIL/embsim`](https://github.com/RileyMcCarthy/embsim). Clone with
> `git clone --recurse-submodules`, or run
> `git submodule update --init --recursive` in an existing checkout.

## How it fits together

A single YAML schema (`Protocol/MaDProtocol.yaml`) generates the encode/decode
code for the firmware (C), the app (TypeScript + WASM), and the test rig (Rust),
so every layer agrees on the wire format byte-for-byte. The app and firmware speak
this **ProtoEmb** binary protocol over serial; motion profiles compile to G-code
that the firmware plays back from its SD card.

See [How it works](https://rileymccarthy.github.io/MaD/how-it-works/) for the
architecture with diagrams.

## Quick start

### Use the app
Open <https://rileymccarthy.github.io/MaD/app/> in Chrome/Edge — no install.

### Run the app from source
```bash
cd Software/MaDWasmControl
npm install
npm run build:wasm        # compile the Rust protocol core → src/wasm/
npm run generate:proto    # generate the TS codec from the YAML schema
npm run app               # opens your browser; connect via Web Serial
```

### Build the firmware
```bash
cd Firmware/MaDCore
pio run -e propeller2              # build for hardware
pio run -e propeller2 -t upload   # flash a connected board
pio run -e native_emulator        # build libfirmware.a for SIL
pio test -e native_test           # unit tests
pio check                         # MISRA C:2023 + CERT
```

### Run the full simulation (no hardware)
```bash
cd SIL
make setup        # first time: npm deps
make test         # build firmware + emulator, run Playwright
make playground   # run the emulator + trace viewer for manual testing
```

### Regenerate the protocol
After editing `Protocol/MaDProtocol.yaml`, regenerate all three targets so they
stay in lock-step (the firmware also regenerates its C target on every build):
```bash
# from repo root
python3 ./Protocol/ProtoEmb/core/generate.py --schema ./Protocol/MaDProtocol.yaml --target c  --output ./Firmware/MaDCore/src/Generated         --templates ./Protocol/ProtoEmb/core/templates
python3 ./Protocol/ProtoEmb/core/generate.py --schema ./Protocol/MaDProtocol.yaml --target ts --output ./Software/MaDWasmControl/src/protocol/generated --templates ./Protocol/ProtoEmb/core/templates
python3 ./Protocol/ProtoEmb/core/generate.py --schema ./Protocol/MaDProtocol.yaml --target rs --output ./SIL/mad-protocol/src/generated          --templates ./Protocol/ProtoEmb/core/templates
```

## Documentation

| If you want to… | Go to |
|---|---|
| Run your first test | [Getting started](https://rileymccarthy.github.io/MaD/getting-started/operators/) |
| Learn every screen | [User guide](https://rileymccarthy.github.io/MaD/user-guide/) |
| Understand the design | [How it works](https://rileymccarthy.github.io/MaD/how-it-works/) |
| Build & contribute | [Developer guide](https://rileymccarthy.github.io/MaD/dev/) |
| Look up the protocol / G-code / formats | [Reference](https://rileymccarthy.github.io/MaD/reference/) |

To work on the docs locally:
```bash
pip install -r docs/requirements.txt
mkdocs serve     # http://127.0.0.1:8000
```

## CI/CD & releases

GitHub Actions builds and tests on every push/PR (`.github/workflows/ci.yml`) and
deploys the docs + app to GitHub Pages (`.github/workflows/pages.yml`). Releases
are cut with version tags:

```bash
git tag software-v1.0.0 && git push --tags   # desktop app
git tag firmware-v1.0.0 && git push --tags   # firmware binaries
git tag hardware-v1.0.0 && git push --tags   # hardware manufacturing files
git tag webapp-v1.0.0   && git push --tags   # deploy docs + app to Pages
```

## License

MIT
