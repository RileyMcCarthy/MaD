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

J1 is the **programming port** only. The firmware's protocol (its MAIN
channel) is on the secondary serial, P30 (P2 RX) / P32 (P2 TX) at 2,000,000
baud (`HAL/Include/HW_pins.h`, `HAL/Config/HAL_serial_config.c`): on the Edge
carrier v0.3 that is the isolated link J4 through IC2; on a P2-EVAL bench, an
FTDI adapter with its TX on P30 and its RX on P32. P62/P63 carry the debug log.
The split exists because the programming adapter's DTR is wired to `RESn`:
when the protocol shared J1, every connect, page refresh and auto-reconnect
rebooted the machine, aborting tests and briefly floating the pins (the bench
drive treats a floating ENA as enabled). The control port has no reset line,
so opening it restarts nothing. The protocol has a `reboot` write for that:
the firmware ACKs, disables motion and reboots ~100 ms later (NACK while a
test runs). The worker sends it (`DeviceSession.reboot`); no screen does yet,
so until one does, the operator power-cycles the machine.

So the app holds two ports with distinct roles. The **control port** is the
Connect page's: live data and tests. The **programming port** is used only by
the Firmware page. For a flash, `flashWithSession` stops the control session,
programs the programming port, and afterwards reconnects the session to the
control port, never to the programming port. Flashing the port the control
session holds is refused (`resolveFlashPort` excludes it), and auto-reconnect
refuses to guess when two granted ports share the remembered USB id
(`matchControlPort` in `src/device/controlPort.ts`), since the wrong guess
resets the machine.

When the only granted port is the one the control session holds, the Firmware
page offers no programming port and says so: "MaD Control is connected through
the only serial device. Choose the programming port (the Prop Plug on J1 or the
P2-EVAL USB), or disconnect on the Connect page to flash through this one."
Flashing that held port is refused with `FLASH_ON_CONTROL_PORT`
(`src/firmware/flashWithSession.ts`), which tells the operator to disconnect
first and flash over the programming port.

Each release carries one image, `MaD-Firmware-<version>.bin`
(`pickFirmwareAsset` in `src/firmware/release.ts`). The Firmware screen
writes the recommended release's image: the newest release that speaks this
app's protocol version (`recommendedRelease`, read from
`firmware/manifest.json`). A release without that image (every release up to
0.14, whose single-port builds were `-P2Eval.bin`/`-release.bin` and
`-MaDEdge.bin`/`-madEdge.bin`/`-debug.bin`) or without `firmware-info.json`
is never recommended. The served folder holds `firmware/manifest.json` with
each listed release's image beside it, plus `firmware/latest.json` and
`firmware/latest.bin` for app versions from before the manifest: the newest
release with the one image, falling back to the newest old production build
(`-P2Eval.bin`/`-release.bin`) until one exists.

Two things this does *not* work over:

- The **control port** (J4/IC2 on the Edge carrier, or the bench FTDI on
  P30/P32). It has no reset line, so it cannot reach the boot ROM.
- Any USB-serial cable that does not drive `RESn` from DTR.

Web Serial exposes only USB vendor/product IDs — no serial number, no device
path — so two identical adapters cannot be told apart programmatically. The app
therefore resolves a target only when the choice is unambiguous (one granted
port, or a remembered one matching exactly one device) and otherwise asks. It
never falls back to "the first port", which is how you flash the wrong board.

## Validating against hardware

Run the CLI harness first. It drives the same `src/firmware/` code over Node's
`serialport`, so a failure there is a wiring or protocol problem rather than a
Web Serial one:

`MAD_SERIAL` is the programming port (the Prop Plug on J1, or the P2-EVAL
USB).

```bash
MAD_SERIAL=/dev/cu.usbserial-XXXX npm run hw:flash -- --detect
```

`--detect` only resets the board and reads the ROM version — it writes nothing.
Seeing `Prop_Ver G` proves the DTR reset and the autobaud window both work.
Then:

```bash
MAD_SERIAL=/dev/cu.usbserial-XXXX npm run hw:flash -- --ram   ../../Firmware/MaDCore/.pio/build/MaD/program
MAD_SERIAL=/dev/cu.usbserial-XXXX npm run hw:flash -- --flash ../../Firmware/MaDCore/.pio/build/MaD/program
```

Note the firmware build artifact is named `program` with no extension; CI
renames it to `MaD-Firmware-<version>.bin` for release assets. Releases up to
0.14 carried one single-port build per board instead (`-P2Eval.bin` and
`-MaDEdge.bin`; `-release.bin` and `-madEdge.bin` before, `-debug.bin` before
0.13). The file picker in the UI accepts any of them as a local file; flashing
an old one puts the protocol back on J1 (or on pins the app can't reach).

## In SIL

The update runs in SIL, on the ISS, with nothing faked: e2e scenarios FW1 and
COMPAT-reflash on `SIL/mad-reflash-cosim.toml` (`cd SIL && make e2e-reflash`,
MaD #134). That board's host is on the programming port J1, the Prop Plug's
(USB 0403:6015), and the module boots the firmware off its flash. With no
session held, the Firmware page resets the chip with its DTR pulse, which
crosses embsim's `chrome-cdp` DTR pin and a Prop Plug reset stage onto J1.3 and
the chip's `RESN`; the ROM, back in its serial window, takes the stub and the
image; the stub writes the module's simulated flash; and the new firmware's
boot line on J1 (P62), `Starting MaD Board <version>`, names the image's own
stamp in the board's log. The app opens nothing afterwards, having held no
control port. Scenario COMPAT-reflash runs the same chain from the other end:
the board boots the release from before the protocol handshake, which answers
on J1, the too-old banner offers the recommended firmware, the operator
disconnects (the app never flashes the port its session holds), and Install
recommended firmware writes it.

What SIL does not run yet is the reconnect to the new firmware: it answers on
the control port J4, and embsim's `chrome-cdp` gives a board one port. A board
with the host on both J1 and J4 is the follow-up; until then the reconnect, the
`ok` verdict and motion on the new firmware are held by COMPAT-update-loop on
the in-page fake board.

The board differs from the machine's default project, beyond where its host
sits, in two places, both open questions for the real machine: the Prop Plug
is taken to reset on DTR assert (`invert_dtr`), and S301's P59 pull-down is
open, without which the ROM boots the flash at once after a reset and no
flasher finds it (`SIL/mad-reflash-cosim.toml` says why for each).

## Open validation

Unit tests cover the framing, the checksum arithmetic and the image assembly
against an independent re-implementation of the ROM side, and FW1 runs the
chain in SIL (above), but the following can only be confirmed on a board:

- **DTR→RESn actually resets.** The schematic shows the net; the pulse shape a
  given adapter produces is not verified, nor which DTR edge the machine's
  Prop Plug resets on (SIL takes the assert).
- **The reset→autobaud window is reachable from JavaScript.** The ROM listens
  for `> ` only briefly before falling through to flash boot, and Web Serial
  write latency is less predictable than a native `write()`. `detectP2` retries
  five times, which may need tuning. In SIL the window is 100 ms (S301 positions
  3 and 4 open) and the probe lands inside it; with P59 pulled down there is no
  window at all.
- **The flash stub programs this board's SPI part.** The stub is loadp2's, so
  it is the same code the desktop path used; SIL runs it against embsim's
  W25Q128JV model, not the module's real part.
