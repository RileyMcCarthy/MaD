# DS2 Addon

The **DS2 Addon** is a piggyback board for the **DS2 force gauge**. It conditions
the strain-gauge signal and presents an analog voltage that the firmware reads
through the **ADS122U04** ADC, giving the machine its force measurement.

![DS2 Addon](KICAD/DS2_Addon.png)

## Role in the machine

- Interfaces the DS2 force gauge's strain-gauge bridge to the
  [EdgeBoard](../EdgeBoard/readme.md).
- Feeds the analog force signal to the ADS122U04 ADC (driven by `IO_ADS122U04`
  in the [firmware](../../Firmware/MaDCore)).
- Provides the force-path measurement used for live readouts, limit enforcement,
  and stress calculation.

## Bench testing

Notes for exercising the board on the bench (no gauge, talking straight to a
P2-EVAL), learned during hardware bring-up:

- **Power the analog domain.** The analog supply is fully isolated from the
  digital 3V3: **AVDD/AGND normally come from the DS2 gauge via J2**, so a bare
  board has the ADC's analog side unpowered. For bench tests strap
  **J2.1 (AVDD) → 3.3 V** and **J2.2 (AGND) → GND**. **Remove the straps before
  connecting the real gauge** — its supply must not fight the bench rail.
- **Close the input jumpers.** The A0/A1 signal path is open by default:
  **R6/R7 are DNP**, so close solder jumpers **JP1/JP2** to route the analog
  inputs through to the ADC.
- **Serial wiring.** The firmware (`IO_ADS122U04`) expects the piggy silk
  **"RX" wired to EVAL P2** and silk **"TX" to EVAL P0**, running at
  **115200 baud**.
- **~RESET pull-up (pre-R10 boards).** Boards fabricated before the **R10**
  10 kΩ pull-up was added float the ADS122U04's ~RESET pin, and the chip will
  not respond to any UART command. On those boards tie ~RESET to 3.3 V manually
  (e.g. bridge U1 pins 1-2-3 and feed 3.3 V via the J3 GPIO0 hole).

## Working with the design

This is a [KiCad](https://www.kicad.org/) project (under `KICAD/`). Open the
`.kicad_pro` to view or edit it. Manufacturing files are produced by the hardware
CI job and published on `hardware-v*` tags — see the
[CI/CD docs](https://rileymccarthy.github.io/MaD/dev/ci-cd-and-releases/).

## Documentation

See the
[Hardware overview](https://rileymccarthy.github.io/MaD/how-it-works/hardware/)
for how the force path works end-to-end.

> **Status:** schematic notes and a bill of materials are still being written.
