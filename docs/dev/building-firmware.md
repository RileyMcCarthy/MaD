# Building the firmware

The firmware is C, compiled with the FlexC compiler via **PlatformIO**. All
commands run from `Firmware/MaDCore/`.

## First-time setup

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
pio run -e propeller2_debug       # hardware build with debug serial
pio run -e propeller2 -t upload   # flash a connected board

pio run -e native_emulator        # build libfirmware.a for SIL (gcc, native)
pio test -e native_test           # run Unity unit tests
pio check                         # MISRA C:2023 + CERT static analysis
```

## Environments

| Environment | Compiler | Purpose |
|---|---|---|
| `propeller2` | FlexC | Production hardware build |
| `propeller2_debug` | FlexC | Hardware build with `ENABLE_DEBUG_SERIAL=1` |
| `native_emulator` | gcc | Compiles firmware as `libfirmware.a` for the [SIL emulator](../how-it-works/sil-emulator.md) |
| `native_test` | gcc | Unity unit tests |

The `native_emulator` build **excludes** the `HAL/` and `HW/` layers (the emulator
provides its own HAL) and `Main/main.c` (the emulator calls `mad_begin()` from
`Main/MaD.c` directly). The output `libfirmware.a` is what the Rust emulator links.

## Code generation runs automatically

The C protocol codec in `src/Generated/` is regenerated on every build by a
PlatformIO pre-hook (`extra_scripts/generate_protocol.py`). You don't need to run
the generator by hand for firmware builds — but see
[Protocol & code generation](protocol-codegen.md) if you change the schema.

!!! warning "Native vs. Propeller 2"
    Always exercise both `native_emulator`/`native_test` **and** a real
    `propeller2` build: pointer sizes and timing differ between the host and the
    P2, and a change that's clean on one can break the other.

## Flashing notes

Flashing uses the native `loadp2` bootloader (via `pio run -t upload`). This is
desktop/CLI tooling and **cannot** run in the browser app — which is why the web
app does not offer firmware updates.
