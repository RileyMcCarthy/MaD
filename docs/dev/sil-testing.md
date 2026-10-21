# SIL testing

The [SIL emulator](../how-it-works/sil-emulator.md) executes the **Propeller 2
image** on the instruction-set simulator, with the machine's pins on nets, so
you can test the whole stack — firmware, protocol, app — without hardware. All
`make` commands run from `SIL/`.

## Build the emulator

```bash
cd SIL
git submodule update --init --recursive   # first time: embsim + ProtoEmb submodules
make emulator     # Rust protocol types, then cargo build
make p2image      # the propeller2_debug image the emulator executes
```

`make emulator` generates the Rust codec into `Protocol/rust/src/generated`
(`make protocol`) and then `cargo build`. The image is a runtime input, built
by `make p2image` (`pio run -e propeller2_debug`). The `playground*` targets
build it, and the release emulator, for you; the `e2e`, `e2e-emulator` and
`e2e-bundle` targets build the production image and lay out the module's flash
and card (`make flash-image sd-image`), and the embsim tool builds `mad-runner`.

| Target | What it does |
|---|---|
| `make p2image` | Build the debug P2 image the ISS executes on the board route (`pio run -e propeller2_debug`) |
| `make p2image-production` | Build the production image (`pio run -e propeller2`), the one the project files' flash holds |
| `make protocol` | Regenerate the Rust protocol types for SIL |
| `make emulator` | Protocol + the Rust workspace |
| `make playground` | The ISS with MaD Control in a **Chrome window on the board's clock** (`mad-emulator --chrome`), the app served by its dev server (started for you). For a person. |
| `make playground-iss` | The same target, under the name it had beside the native playground. |
| `make playground-rom` | The ISS booting the mask ROM, the app's flasher in a Chrome window on the board's clock, on the programming UART (`P62`/`P63`, USB `0403:6015`) |
| `make playground-pty` | The ISS on a PTY at `/tmp/tty.iss`, at real time at most, for a serial console. No browser belongs behind it (below). |
| `make e2e-emulator` | The machine's project with the host's Chrome on `J1`, `mad-cosim.toml`, under `embsim run`: a **headless** Chrome on the board's clock, DevTools on 9222, nothing open, until Ctrl-C; attach the e2e suite to it |
| `make e2e` | The dev server, `e2e-emulator`'s board and the suite against it, then everything stopped (`SCENARIOS=…` selects) |
| `make e2e-rom` | FW-ISS: the app's flasher in a headless Chrome on the board's clock, against the ISS booting the mask ROM (`mad-emulator`) |
| `make e2e-bundle` | BUNDLE-live on `e2e-emulator`'s board: the app as it ships (built as `pages.yml` builds it, served by `vite preview`): connect, samples, machine state, unplug, and replug with the app reconnecting by itself |
| `make flash-image` | `build/flash.bin`: stage-1 and the production image, the module's boot flash |
| `make sd-image` | `build/sd.img`: a 32 MiB FAT16 card mirroring `./sd` |
| `make check` | `embsim check` on the four project files (`mad*.toml`), after `flash-image` and `sd-image` |
| `make test` | Build both images + protocol, then `cargo test` (includes `mad-catalog`'s PTY round trip on `mad.toml` — no Chrome) |
| `make clean` | Remove build artifacts and `cargo clean` |

## The machine's project files

`SIL/mad.toml` is the machine as it runs, as an embsim project: the Edge
carrier, the P2-EC32MB module in its socket with the ISS as its processor
(`mad-p2iss`), the module's flash and card, the DS2 add-on and the machine on
the carrier's connectors (embsim `MIGRATING-MAD.md` §1 and §4). Its host is on
the carrier's **debug header `J1`** (`P62`, `P63` and `GND`; `RESn`, `J1.3`,
unwired), where the machine's Prop Plug sits, and the module's flash holds the
**production build** (`pio run -e propeller2`), as the user decided
(2026-10-21). That build's MAIN channel receives on `P63` and transmits on
`P62` at 2,000,000 baud (`HW_pins.h`, `HAL_serial_config.c`), the pins `J1`
carries; the app flashes over `J1` (`Software/Control/README.md`, "Firmware
flashing"). **Open:** which image the machine runs. By default the app flashes
a release's madEdge image, the `propeller2_debug` build, whose protocol is on
`P53`/`P55` (`Software/Control/src/firmware/release.ts`, `pickFirmwareAsset`);
the production build is the release's `-release.bin`, flashed only as a local
file. Nothing sits on the Pi's connector `J4`: its line goes through
`IC2` to the carrier's `P52`–`P55`, which the EC32MB keeps for its PSRAMs and
has no finger for, so it cannot reach the chip
([board design](sil-board-simulation-design.md#the-p2-edge-module-gap)).

| File | The module boots | The host |
|---|---|---|
| `mad.toml` | the production firmware, off the flash | `host-serial` on `J1` |
| `mad-cosim.toml` | the same | `chrome-cdp` on `J1`, USB `0403:6015` |
| `mad-serial-boot.toml` | the ROM's serial boot, the flash erased | `host-serial` on `J1` |
| `mad-serial-boot-cosim.toml` | the same | `chrome-cdp` on `J1`, USB `0403:6015` |

```bash
cd SIL
make flash-image sd-image check    # the production image, both images laid out, all four files checked
MAD_REQUIRE_P2_IMAGE=1 cargo test -p mad-catalog --test mad --test projects
```

`mad-catalog/tests/mad.rs` runs `mad.toml` stepped: the inputs at rest; the
firmware booted off the flash and answering the host over `J1` (its version
and the machine's state, framed by ProtoEmb's framing crate and decoded with
the generated Rust codec, then the machine reading unfaulted and taking the
host's request to enable motion); and the encoder's pairs with the chip held
in reset. `tests/pty_protocol.rs` runs `mad.toml` live, as `embsim run
mad.toml --pty PATH` does, and reads the firmware's version on the PTY before
the run's 2 s of board time end. `tests/projects.rs` holds the four files to
one another. The debug image (`make p2image`) stays where a run needs its log
on `P62` or its MAIN channel on the bare chip's `P53`/`P55`: the playgrounds
(`mad-emulator`), the `p2core` and `p2iss` suites, and
`mad-catalog/tests/boot.rs`.

## The board route: the app in Chrome on the board's clock

There is **one** configuration a browser belongs in: the P2 image on the ISS,
with MaD Control in the host's Chrome held to the board's clock by embsim's
`chrome-cdp` node (embsim `PROJECTS.md` §5). Two boards carry it:

- **The e2e's: the machine's project**, `mad-cosim.toml` under `embsim run`
  (`make e2e-emulator`, embsim `MIGRATING-MAD.md` step 10): the carrier and
  the module as drawn, the production firmware booted off the module's flash,
  and the node on the carrier's debug header `J1`.
- **The playgrounds': `mad-emulator --chrome`** (step 1b): the debug firmware
  on the bare chip, the node on `P53`/`P55`. They move onto the project at
  step 11.

- **Time.** Every page and dedicated worker in that Chrome lives the board's
  time, a 1 ms quantum at a time over DevTools
  (`Emulation.setVirtualTimePolicy`). JavaScript runs in no virtual time;
  timers, `Date.now()`, `performance.now()` and the protocol core's clock
  advance only when the board's does. So the app's 2 s response timeout is
  2 s of the **board's** time, however slowly the ISS runs on the host.
- **Serial.** Every page's `navigator.serial` is the node's shim, whose one
  port is the board's protocol line, 2,000,000 baud 8N1, granted to every
  origin: on the project the line on `J1` (`P63`/`P62`), USB `0403:6015`, an
  FTDI FT231X, the chip in the Prop Plug; on `mad-emulator` `P53`/`P55`, USB
  `0403:6001`. It follows Chrome's rules: a `close()` refused while a stream
  is locked, `NetworkError` on an unplug, a new `SerialPort` and `connect` on
  a replug. The line has no modem pins: DTR, RTS and a break reach nothing.
- **The host's pins.** On the project, the file's wires: `HOST.TX` to
  `EDGE.J1.2` (`P63`), `EDGE.J1.1` (`P62`) to `HOST.RX`, `HOST.GND` on
  `J1.4`, `HOST.VIO` on the adapter's 3.3 V. On `mad-emulator`, the
  harness's host pins (`HOST.TX` to `P2.P53`, `P2.P55` to `HOST.RX`).
- **What it costs.** The ISS runs at a few percent of real time, so a second
  of the board's time is tens of seconds of the host's. On the project
  (measured, Apple M2, 2026-10-21): each board first boots the firmware off
  the module's flash, about 1.3 s of board time in about 24 s of host time,
  and `board-route.sh` starts a scenario only once the firmware's boot line
  is out; the board then ran at about 0.1x with the app attached, and at a
  few hundredths of that while the firmware works its card (G1, 3.1 s of
  board time in 184 s). The 23 scenarios that run there took 753 s, boards
  included; the per-PR ten 512 s. The node adds about half a millisecond of
  host time per 1 ms slice.
- **What it does not test.** Chrome's own Web Serial and the OS's serial
  driver are not in the byte path; animation frames, `ResizeObserver` and
  `IntersectionObserver` barely run on virtual time, so the live charts
  redraw only now and then.
- **What the project as drawn cannot do.** The carriage never moves: `IC14`,
  the isolator between the processor and the drive, has its secondary
  grounds on a net of their own, so nothing reaches the drive's step,
  direction and enable inputs (`mad-catalog/tests/mad.rs`), the run's summary says
  `0 steps commanded`, and the firmware latches `SERVO_STALL` at the first
  move it commands (measured). The project's machine has no jam either. The
  suite skips each scenario that moves the carriage, and SERVO-stall, on the
  project, saying why (`e2e/run-all.mjs`, `PROJECT_CANNOT`);
  `E2E_PROJECT_CANNOT=run` runs them anyway, for a change that may lift the
  reason. Whether the machine's carrier is bodged at `IC14` is not known.

### Playground

```bash
cd SIL
make playground
```

A Chrome window opens on the app (connect on the Connect screen: the port is
granted). The board's log follows in the terminal. Ctrl-C stops the board,
Chrome and the dev server it started.

### Running the e2e suite

```bash
cd SIL
make e2e                                   # the whole suite, then everything stopped
make e2e SCENARIOS=B1+C1,F7                # a subset
make e2e BOARD_PER_SCENARIO=1              # a fresh board for each scenario (as CI runs)
```

or by hand, in three terminals:

```bash
make e2e-emulator                          # wait for "… reached … DevTools at http://127.0.0.1:9222"
cd ../Software/Control && npm run dev
CDP_URL=http://127.0.0.1:9222 npm run e2e  # or SCENARIOS=… as well
```

`make e2e` serves the app with the dev server (on `APP_PORT`, 5174, unless
something already answers there, which it then uses), and `make e2e-bundle`
with the production bundle (`vite preview`); BUNDLE-live runs only on the
bundle. The dev server stays the suite's server because the M13 scenarios
read the live stream through a hook only a dev build has (`__madLive`), and a
failure report carries the app's log from a dev build without an opt-in.

Wait for the run's **"reached"** line before attaching: a page made before the
node holds Chrome is not on the board's clock. The suite makes a fresh browser
context per scenario, and its page at about:blank, then navigates it: Chrome
holds a page made that way from birth, and the node stops the run on a page
made with a URL.

Every budget in the suite is board time: a locator's `waitFor({ timeout })`,
`waitPageTime()` (in place of `waitForTimeout`) and `pageClock()` (in place of
`Date.now()` deadlines) all count the page's clock, which is the board's.
Nothing asserts on host time; each scenario prints its host and board time.
Clicks go through `press()`: Playwright's "stable" check waits on animation
frames, which barely run on virtual time, so `press()` checks the element is
visible, enabled and what `elementFromPoint` finds at its centre, then forces
the click. The link-drop scenarios (B5-reconnect, M11-idle-drop,
M11-mid-test-drop) pull the node's cable (`__embsim.link('unplug')`) and put it
back.
On `mad-emulator` (`BOARD_ROUTE=emulator` for `board-route.sh`, or
`E2E_BOARD_ROUTE=emulator` with the suite attached by hand), SERVO-stall jams
the carriage by creating `E2E_JAM_FILE`, the file `mad-emulator --jam-file`
watches: while it exists the drive keeps stepping but the carriage and its
encoder stand still. `board-route.sh` defaults it to `$BOARD_LOGS/jam`.
Without `E2E_JAM_FILE` set, SERVO-stall fails at once.

**In CI:** `control-e2e-board` gates a subset per PR on the project
(`make check`, then `make e2e`, one board per scenario, on the runner's
Chrome; `ci.yml`), then BUNDLE-live on the built bundle, and the nightly
(`e2e-nightly.yml`) runs the whole suite the same way after the node's Chrome
canary, with FW-ISS on `mad-emulator`'s ROM board. `control-e2e-boardless`
gates the scenarios that need no board (A1 and the firmware-flash `FW*` ones,
a host Chrome against in-page fakes).

!!! note "One scenario, one board"
    A fetch that holds a virtual-time budget for 2 s is granted that budget
    again under `advance`. A grant that still does not end stops the run after
    `stuck_after`. `make e2e BOARD_PER_SCENARIO=1` gives each scenario a fresh
    board, as CI does, so that stop costs one scenario.

## A browser on the host's clock is not a SIL configuration

!!! warning "The ISS behind a PTY or the WS bridge measures the host"
    The browser cannot open a PTY. The WS↔PTY bridge (`npm run sil:bridge`)
    relays one to a faked Web Serial port, and it defaults to `/tmp/tty.rpi`:
    the native firmware library's path, which no target serves any more.
    `make playground-pty` is on `/tmp/tty.iss` so that pairing the bridge with
    the ISS takes a deliberate act (the bridge's `MAD_PTY`). That pairing hands
    the board's bytes to a browser running at host speed, and the ISS
    interprets far slower than real time, so every wait the app makes measures
    the host rather than the machine. The bridge remains for real hardware
    (`tools/hw-ws-bridge.mjs`, `e2e/hw-read-save-config.mjs`), which runs in
    real time.

`mad-catalog` has a Chrome-free PTY round trip (`tests/pty_protocol.rs`):
`mad.toml` run live, as `embsim run mad.toml --pty PATH` runs it, a
`firmware_version` READ on the PTY once the firmware has printed its boot
line, and a DATA frame back before the run's 2 s of board time end. It runs
as part of `make test` / `sil-rust` and does not use `/tmp/tty.rpi`.

!!! note "SIL is single-instance"
    There is exactly [one emulator per process](../how-it-works/sil-emulator.md#one-emulator-per-process),
    so scenarios run serially against one emulator (the moral equivalent of
    `workers: 1`), and only one board runs on a machine at a time: stop a
    playground before `make e2e`. The project fixes its Chrome's DevTools
    port, 9222, and `board-route.sh` refuses to start a board while
    something already answers there.

The test harness and its parity criteria are documented in
[TEST_PLAN.md](https://github.com/RileyMcCarthy/MaD/blob/main/Software/Control/docs/TEST_PLAN.md).

## Capturing screenshots

The documentation screenshots are produced the same way — see
[Running the app → Regenerating screenshots](running-the-app.md#regenerating-documentation-screenshots).

## Firmware unit tests

Separate from SIL, the firmware has Unity unit tests:

```bash
cd Firmware/MaDCore && pio test -e native_test
```
