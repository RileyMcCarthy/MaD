# Firmware flashing from the browser

The app can program the Propeller 2 over Web Serial, without `loadp2` or any
native helper. This document covers how it works, what it needs from the
hardware, and how to validate it.

## How it works

Programming the P2 does not require a bespoke flash protocol. Both modes are a
single download into hub RAM through the boot ROM's serial loader:

| Mode | Image sent | Effect | Exposed where |
| --- | --- | --- | --- |
| Flash | a 496-byte stub, then the firmware | the stub copies the payload into SPI flash and reboots | the app, and `hw:flash --flash` |
| RAM | the firmware itself | ROM runs it immediately; lost at next reset | `hw:flash --ram` only |

**The app only ever flashes.** The P2 Edge boots from SPI flash, so a RAM load
would present as a successful update and then revert on the next power cycle —
a bad thing to offer an operator. RAM loading stays in the CLI, where running a
build without committing it is exactly what you want during bring-up.

The sequence, ported from `loadp2`'s single-stage path (`-SINGLE`):

1. **Reset** — pulse DTR assert / release / assert with 2 ms settle
   (`hwreset()` in loadp2's `osint_linux.c`). On MaD hardware DTR reaches the
   P2's `RESn` through header J1.
2. **Autobaud + probe** — send `> Prop_Chk 0 0 0 0  `. The leading `> ` is the
   ROM's autobaud pattern, so the ROM locks onto whatever rate the port was
   opened at (2 Mbaud here). The ROM answers `\r\nProp_Ver G`.
3. **Download** — send `> Prop_Hex 0 0 0 0`, then the image as ASCII hex in
   128-byte lines, each followed by a ` > ` continuation marker.
4. **Finish** — for a RAM load, send the complement of the running long-sum so
   the ROM's total lands on `0x706f7250`, then `?`; the ROM replies `.` on a
   match. For a flash load the checksum handshake is skipped (it collides with
   the stub's own header checksum, exactly as loadp2 does) and the download
   ends with `~`.

Single-stage costs three wire bytes per image byte, so a 300 KB image is about
5 s at 2 Mbaud. `loadp2`'s default two-stage mode avoids that by first
uploading its `MainLoader` blob and switching to a binary protocol with its own
flow control — considerably more code for a few seconds per update, so it is
deliberately not ported.

## Hardware requirements

From `Hardware/EdgeBoard/KiCad/MaD_Edge.kicad_sch`, connector **J1**
("Debug/Programming", `Conn_01x04`) carries, in order:

```
pin 1: P62    pin 2: P63    pin 3: RESn    pin 4: GND
```

(Confirmed against the pad-to-net assignments in `MaD_Edge.kicad_pcb`; an earlier
revision of this document listed the four nets in reverse pin order.)

P62/P63 is also where a
production firmware build puts the protocol UART, at 2,000,000 baud
(`HAL/Config/HAL_serial_config.c`, with `ENABLE_DEBUG_SERIAL` off). So on
production hardware **one connection serves both control and programming** —
the app defaults to reusing the port it is already connected to, and after a
flash it reconnects to that port at that rate. That is why the Firmware screen's
default image is the latest release's production build
(`MaD-Firmware-<version>-release.bin`; `pickFirmwareAsset` in
`src/firmware/release.ts`). A release without one offers nothing, and the
screen offers the newest release that has one.

Two things this does *not* work over:

- The **isolated Raspberry Pi link** on P53/P55 — no reset line.
- Any USB-serial cable that does not drive `RESn` from DTR.

A debug firmware build (`propeller2_debug`, released as `-madEdge.bin`) moves
the protocol UART to P53/P55 and puts a debug log on P62/P63, so on a
two-adapter bench setup the programming port and the control port differ. That
is what the **Port** control on the Firmware screen is for. The machine itself
cannot run that build: its P2-EC32MB module uses P40–P57 for its PSRAM and does
not bring them out, so the EdgeBoard's J4/IC2 link on P52–P55 never reaches the
chip. Flash it as a local file, on a bench only.

Web Serial exposes only USB vendor/product IDs — no serial number, no device
path — so two identical adapters cannot be told apart programmatically. The app
therefore resolves a target only when the choice is unambiguous (one granted
port, or a remembered one matching exactly one device) and otherwise asks. It
never falls back to "the first port", which is how you flash the wrong board.

## Validating against hardware

Run the CLI harness first. It drives the same `src/firmware/` code over Node's
`serialport`, so a failure there is a wiring or protocol problem rather than a
Web Serial one:

```bash
MAD_SERIAL=/dev/cu.usbserial-XXXX npm run hw:flash -- --detect
```

`--detect` only resets the board and reads the ROM version — it writes nothing.
Seeing `Prop_Ver G` proves the DTR reset and the autobaud window both work.
Then:

```bash
MAD_SERIAL=/dev/cu.usbserial-XXXX npm run hw:flash -- --ram   ../../Firmware/MaDCore/.pio/build/propeller2/program
MAD_SERIAL=/dev/cu.usbserial-XXXX npm run hw:flash -- --flash ../../Firmware/MaDCore/.pio/build/propeller2/program
```

Note the firmware build artifact is named `program` with no extension; CI
renames it to `MaD-Firmware-<version>-release.bin` (`propeller2_release`, the
same build as `propeller2`) and `MaD-Firmware-<version>-madEdge.bin`
(`propeller2_debug`) for release assets. Releases before 0.13 named the debug
build `-debug.bin`. The file picker in the UI accepts all of them.

## Open validation

Unit tests cover the framing, the checksum arithmetic and the image assembly
against an independent re-implementation of the ROM side, but the following can
only be confirmed on a board:

- **DTR→RESn actually resets.** The schematic shows the net; the pulse shape a
  given adapter produces is not verified.
- **The reset→autobaud window is reachable from JavaScript.** The ROM listens
  for `> ` only briefly before falling through to flash boot, and Web Serial
  write latency is less predictable than a native `write()`. `detectP2` retries
  five times, which may need tuning.
- **The flash stub programs this board's SPI part.** The stub is loadp2's, so
  it is the same code the desktop path used, but it has not been run here.
