# Firmware flashing from the browser

The app can program the Propeller 2 over Web Serial, without `loadp2` or any
native helper. This document covers how it works, what it needs from the
hardware, and how to validate it.

## Status

**Prototype — the protocol is exercised by unit tests, but the RAM and flash
paths have not yet been run against a physical board.** Validate with the CLI
harness (below) before relying on the UI. See "Open validation" at the end.

## How it works

Programming the P2 does not require a bespoke flash protocol. Both modes are a
single download into hub RAM through the boot ROM's serial loader:

| Mode | Image sent | Effect |
| --- | --- | --- |
| RAM | the firmware itself | ROM runs it immediately; lost at next reset |
| Flash | a 496-byte stub, then the firmware | the stub copies the payload into SPI flash and reboots |

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
GND / RESn / P63 / P62
```

That is the standard Parallax Prop Plug pinout, and P62/P63 is also where a
production firmware build puts the protocol UART (`HAL_serial.c`, with
`ENABLE_DEBUG_SERIAL` off). So on production hardware **one connection serves
both control and programming** — the app defaults to reusing the port it is
already connected to.

Two things this does *not* work over:

- The **isolated Raspberry Pi link** on P53/P55 — no reset line.
- Any USB-serial cable that does not drive `RESn` from DTR.

A debug firmware build moves the protocol UART to P53/P55, so on a two-adapter
bench setup the programming port and the control port differ. That is what the
"Choose a different port for programming" option is for. Web Serial exposes
only USB vendor/product IDs — there is no serial number or device path — so two
identical adapters cannot be told apart programmatically. The choice has to be
the user's.

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
renames it to `MaD-Firmware-<version>-{debug,release}.bin` for release assets.
The file picker in the UI accepts both.

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
