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

pio run -e MaD                 # the firmware; hardware and the SIL emulator run this image
pio run -e MaD -t upload       # flash a connected board through J1
pio test -e native_test        # Unity unit tests on the host, against a mock HAL
pio check -e MaD               # MISRA C:2023 + CERT static analysis
```

The image is `.pio/build/MaD/program`.

## Environments

| Environment | Compiler | Purpose |
|---|---|---|
| `MaD` | FlexC | The firmware, one build for every board. The protocol (MAIN channel) is on the secondary serial, P30 (P2 RX) / P32 (P2 TX), at 2,000,000 baud: the Edge carrier v0.3's isolated link (J4, through IC2), or on a P2-EVAL bench an FTDI adapter with its TX on P30 and its RX on P32. P62/P63 (header J1, or the P2-EVAL's own USB) is for programming only (the ROM's serial loader, reset by the adapter's DTR) and carries the debug log. Released as `MaD-Firmware-<version>.bin`, the image MaD Control flashes. This image is also what the [SIL emulator](../how-it-works/sil-emulator.md) executes. |
| `native_test` | gcc | Unity unit tests. `test/mock_propeller2.c` stands in for the HAL; `HAL/P2/` is not compiled. |
| `native_test_noasan` | gcc | The same suite without ASan, for hosts where ASan is broken. |

The protocol left J1 because opening J1 toggles DTR, which reboots the chip:
with the protocol there, every connect, page refresh and auto-reconnect aborted
tests and briefly floated the pins. The `P2Eval` (protocol on J1) and `MaDEdge`
(`ENABLE_DEBUG_SERIAL=1`, protocol on P30/P32) envs, and `propeller2` /
`propeller2_debug` before them, no longer exist; releases up to 0.14 were built
from them. The machine stays on 0.14 until its Edge carrier v0.3 is built.

## Code generation runs automatically

The C protocol codec in `src/Generated/` is regenerated on every build by a
PlatformIO pre-hook (`extra_scripts/generate_protocol.py`). You don't need to run
the generator by hand for firmware builds — but see
[Protocol & code generation](protocol-codegen.md) if you change the schema.

!!! warning "Native vs. Propeller 2"
    Run `pio test -e native_test` **and** a real `MaD` build: pointer
    sizes and timing differ between the host and the P2, and a change that's
    clean on one can break the other. The emulator runs the P2 image.

## Flashing notes

`pio run -t upload` flashes with the native `loadp2` bootloader through the
programming port (J1). MaD Control's Firmware page does the same from the
browser over Web Serial, also on J1, never on the control port; see
[Firmware & diagnostics](../user-guide/firmware-and-diagnostics.md) and
`Software/Control/docs/FLASHING.md`.
