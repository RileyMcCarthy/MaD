# Building the firmware

The firmware is C, compiled with the FlexC compiler via **PlatformIO**. All
commands run from `Firmware/MaDCore/`.

## First-time setup

> Needs the `Protocol/ProtoEmb` submodule (protocol codegen pre-hook):
> `git submodule update --init --recursive` after a plain clone.

1. Install [PlatformIO IDE for VS Code](https://docs.platformio.org/en/latest/integration/ide/vscode.html#installation)
   (or the PlatformIO Core CLI).
2. Install the custom Propeller platform:

    ```bash
    cd Firmware/MaDCore
    pio pkg install --platform https://github.com/RileyMcCarthy/platform-propeller.git
    ```

## Build & flash

```bash
cd Firmware/MaDCore

pio run -e propeller2              # production hardware build
pio run -e propeller2_debug       # debug serial; this image is what the SIL emulator executes
pio run -e propeller2 -t upload   # flash a connected board
pio test -e native_test           # Unity unit tests on the host, against a mock HAL
pio check                         # MISRA C:2023 + CERT static analysis
```

## Environments

| Environment | Compiler | Purpose |
|---|---|---|
| `propeller2` | FlexC | Production hardware build: the protocol on P62/P63 (header J1) at 2,000,000 baud. The machine runs this build. |
| `propeller2_release` | FlexC | The same build as `propeller2`, released as `MaD-Firmware-<version>-release.bin`. MaD Control flashes this image by default. |
| `propeller2_debug` | FlexC | Hardware build with `ENABLE_DEBUG_SERIAL=1`: the protocol on P30/P32, a debug log on P62/P63. P30/P32 are the Edge carrier's Raspberry Pi link (J4, through IC2) from carrier v0.3 on; earlier carriers wire IC2 to P52–P55, which the machine's P2-EC32MB does not bring out, so on those this build is for a bench with its own adapter on P30/P32. Images built before the pin move have the protocol on P53/P55. Released as `MaD-Firmware-<version>-madEdge.bin`. This image is what the [SIL emulator](../how-it-works/sil-emulator.md) executes. |
| `native_test` | gcc | Unity unit tests. `test/mock_propeller2.c` stands in for the HAL; `HAL/P2/` is not compiled. |

## Code generation runs automatically

The C protocol codec in `src/Generated/` is regenerated on every build by a
PlatformIO pre-hook (`extra_scripts/generate_protocol.py`). You don't need to run
the generator by hand for firmware builds — but see
[Protocol & code generation](protocol-codegen.md) if you change the schema.

!!! warning "Native vs. Propeller 2"
    Run `pio test -e native_test` **and** a real `propeller2` build: pointer
    sizes and timing differ between the host and the P2, and a change that's
    clean on one can break the other. The emulator runs the P2 image.

## Flashing notes

Flashing uses the native `loadp2` bootloader (via `pio run -t upload`). This is
desktop/CLI tooling and **cannot** run in the browser app — which is why the web
app does not offer firmware updates.
