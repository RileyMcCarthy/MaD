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
by `make p2image` (`pio run -e propeller2_debug`). The `playground*`, `e2e*`
and `check` targets build the production image and lay out the module's
flash and card (`make flash-image sd-image`), and the embsim tool builds
`mad-runner`; `e2e-stall` builds the debug image and the release
`mad-emulator`, whose board it still runs SERVO-stall on.

| Target | What it does |
|---|---|
| `make p2image` | Build the debug P2 image the ISS executes on the board route (`pio run -e propeller2_debug`) |
| `make p2image-production` | Build the production image (`pio run -e propeller2`), the one the project files' flash holds |
| `make protocol` | Regenerate the Rust protocol types for SIL |
| `make emulator` | Protocol + the Rust workspace |
| `make playground` | `mad-playground.toml` under `embsim run`: the machine with MaD #285 fixed, MaD Control in a **Chrome window on the board's clock**, the app served by its dev server on 5174 (started for you). For a person. |
| `make playground-iss` | The same target, under the name it had beside the native playground. |
| `make playground-rom` | `mad-serial-boot-playground.toml`: the ROM's serial boot on `J1` (USB `0403:6015`), the app's flasher in a Chrome window on the board's clock. The flasher writes the flash, as FW-ISS does; a RAM load's reply is garbled until MaD #295 is fixed. |
| `make playground-pty` | `mad.toml` under `embsim run`, its host a PTY at `/tmp/tty.iss`, for a serial console. No browser belongs behind it (below). |
| `make e2e-emulator` | The machine's project with the host's Chrome on `J1`, `mad-cosim.toml`, under `embsim run`: a **headless** Chrome on the board's clock, DevTools on 9222, nothing open, until Ctrl-C; attach the e2e suite to it |
| `make e2e` | The dev server, `e2e-emulator`'s board and the suite against it, then everything stopped (`SCENARIOS=…` selects) |
| `make e2e-rom` | FW-ISS: the app's flasher in a headless Chrome on the board's clock, against the ISS booting the mask ROM on the project's serial boot (`mad-serial-boot-cosim.toml`) |
| `make e2e-bundle` | BUNDLE-live on `e2e-emulator`'s board: the app as it ships (built as `pages.yml` builds it, served by `vite preview`): connect, samples, machine state, unplug, and replug with the app reconnecting by itself |
| `make e2e-motion` | What the project as drawn cannot run (the scenarios that move the carriage), on `mad-ic14-fixed-cosim.toml`, the board with MaD #285 fixed (`SCENARIOS=…` narrows the set; `MOTION_SHARD=K/N` runs every N-th of it from the K-th); SERVO-stall is skipped there, for the jam |
| `make e2e-stall` | SERVO-stall on `mad-emulator`'s board (`BOARD_ROUTE=emulator`, the debug image, a headless Chrome on the board's clock): the one scenario no project can run, since it jams the carriage (MaD #298) |
| `make flash-image` | `build/flash.bin`: stage-1 and the production image, the module's boot flash |
| `make sd-image` | `build/sd.img`: a 32 MiB FAT16 card mirroring `./sd` |
| `make check` | `embsim check` on the seven project files (`mad*.toml`), after `flash-image` and `sd-image` |
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
| `mad-ic14-fixed-cosim.toml` | `mad-cosim.toml` with MaD #285 fixed: one wire from `IC14`'s ground to `EN_GND` | `chrome-cdp` on `J1` |
| `mad-playground.toml` | `mad-ic14-fixed-cosim.toml` | its Chrome headed, a window on the app |
| `mad-serial-boot-playground.toml` | `mad-serial-boot-cosim.toml` | its Chrome headed, a window on the app's Firmware page |

Every file but the #285 fix's two keeps the carrier as drawn, where `IC14`,
the isolator between the processor and the servo drive, passes nothing (its
drive-side ground pins reach only `C26`). The fix's file is the board with
#285 fixed, word for word `mad-cosim.toml` but one `[[pin_short]]` from
`IC14`'s pin 9 to `J21.8` (`EN_GND`), the wire #285 names for a carrier
built as drawn; `tests/projects.rs` holds it to that. Every file takes
`JP1`, the enable jumper, on its open-collector pads 2–3: the firmware never
drives the enable pin `P6`, so `IC14` gives its default high there, which
turns `Q1` on to sink the drive's active-low enable; on pads 1–2 that high
reaches the enable itself and the drive stays disabled (measured, #285
fixed). Which pads the machine's carrier has closed is not confirmed.

```bash
cd SIL
make flash-image sd-image check    # the production image, both images laid out, all seven files checked
MAD_REQUIRE_P2_IMAGE=1 cargo test -p mad-catalog --test mad --test projects
```

`mad-catalog/tests/mad.rs` runs `mad.toml` stepped: the inputs at rest; the
firmware booted off the flash and answering the host over `J1` (its version
and the machine's state, framed by ProtoEmb's framing crate and decoded with
the generated Rust codec, then the machine reading unfaulted and taking the
host's request to enable motion); the encoder's pairs with the chip held
in reset; and, with #285's wire added, the firmware jogging the carriage
0.5 mm forward and 0.25 mm back, each to rest within its 8-count parking
deadband, the drive enabled and `P5` reading the drive's ready line.
`tests/pty_protocol.rs` runs `mad.toml` live, the command `embsim run
mad.toml --pty PATH` hands `mad-runner` run in its own process, and reads the
firmware's version on the PTY before the run's 2 s of board time end.
`tests/projects.rs` holds the seven files to one another. The debug image
(`make p2image`) stays where a run needs its log on `P62` or its MAIN channel
on the bare chip's `P53`/`P55`: `mad-emulator` (SERVO-stall, `make
e2e-stall`), the `p2core` and `p2iss` suites, and
`mad-catalog/tests/boot.rs`.

## The board route: the app in Chrome on the board's clock

There is **one** configuration a browser belongs in: the P2 image on the ISS,
with MaD Control in the host's Chrome held to the board's clock by embsim's
`chrome-cdp` node (embsim `PROJECTS.md` §5). Two boards carry it:

- **The machine's project**, under `embsim run`: the e2e on `mad-cosim.toml`
  (`make e2e-emulator`, embsim `MIGRATING-MAD.md` step 10), the carrier and
  the module as drawn, the production firmware booted off the module's flash,
  and the node on the carrier's debug header `J1`; the scenarios that move
  the carriage on `mad-ic14-fixed-cosim.toml` (`make e2e-motion`); FW-ISS
  on the ROM's serial boot, `mad-serial-boot-cosim.toml` (`make e2e-rom`);
  and the playgrounds on headed copies, `mad-playground.toml` and
  `mad-serial-boot-playground.toml` (step 11).
- **`mad-emulator --chrome`** (step 1b): the debug firmware on the bare chip,
  the node on `P53`/`P55`. It runs SERVO-stall alone (`make e2e-stall`),
  because that scenario jams the carriage and no project has a jam (MaD
  #298). It retires once a project has one.

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
  and `board-route.sh` starts a scenario once the firmware's boot line is
  out (a hint for pacing: the scenario's connect is the check, below); the
  board then ran at about 0.1x with the app attached, and at a few
  hundredths of that while the firmware works its card (G1, 3.1 s of board
  time in 184 s). The 23 scenarios the project runs (14 on a board, and 9
  that need none: A1 and FW1–3, FW5–9) took 753 s, boards included, and
  BUNDLE-live on the bundle 36 s; the per-PR ten 512 s. The node adds about
  half a millisecond of host time per 1 ms slice.
- **What it does not test.** Chrome's own Web Serial and the OS's serial
  driver are not in the byte path; animation frames, `ResizeObserver` and
  `IntersectionObserver` barely run on virtual time, so the live charts
  redraw only now and then.
- **What the project as drawn cannot do.** The carriage never moves: `IC14`,
  the isolator between the processor and the drive, has its secondary
  grounds on a net of their own (MaD #285), so nothing reaches the drive's
  step, direction and enable inputs (`mad-catalog/tests/mad.rs`), the run's
  summary says `0 steps commanded`, and the firmware latches `SERVO_STALL` at
  the first move it commands (measured). The project's machine has no jam
  either. The suite skips each scenario that moves the carriage, and
  SERVO-stall, on the project as drawn, saying why (`e2e/run-all.mjs`,
  `PROJECT_CANNOT`): 41 of the 55 that touch a board.
  `E2E_PROJECT_CANNOT=run` runs them anyway, for a change that may lift the
  reason. Whether the machine's carrier is bodged at `IC14` is not known.
  They run on the board with #285 fixed, where the carriage moves: `make
  e2e-motion` (the set from `node e2e/run-all.mjs --list --cannot`, run on
  `mad-ic14-fixed-cosim.toml`; `board-route.sh` exports `E2E_PROJECT`, by
  which the suite skips), per PR G2+G3+H2+I and nightly the whole set.
  SERVO-stall stays skipped there: no project has a jam yet.

### Playground

```bash
cd SIL
make playground
```

`mad-playground.toml` runs under `embsim run`: the machine with MaD #285
fixed, so the carriage moves. Its Chrome opens a window on the app at the
file's url, the dev server on 5174 (connect on the Connect screen: the port
is granted). The board's log follows in the terminal, and the run prints
where Chrome's DevTools are. Ctrl-C stops the board, Chrome and the dev
server it started. `make playground-rom` does the same on
`mad-serial-boot-playground.toml`, the window on the app's Firmware page;
it may not boot what the app sends until FW-ISS runs on the project (MaD
#284).

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
this checkout's dev server already answers there, which it then uses; a
server another checkout started there is refused, by the working directory
`lsof` reports for it), and `make e2e-bundle` with the production bundle
(`vite preview`); BUNDLE-live runs only on the bundle. The dev server stays
the suite's server because a failure report carries the app's log
(`__madLog`), which a dev build exposes without an opt-in
(`src/diagnostics/log.ts`). The M13 scenarios (`make e2e-motion`) also read
the live stream through `__madLive`, which only a dev build has
(`src/store/liveBuffer.ts`).

A scenario's connect is done only once the firmware has answered: samples
arriving and the opening handshake's firmware version in the status bar,
waited for in page time (`e2e/fixtures.mjs`, `connectToSil`). The status
dot turns connected as soon as the port opens, before anything is heard from
the board, so the connect is what makes a silent firmware fail every
scenario. On the project `board-route.sh` also waits for the firmware's boot
line before starting a scenario, as pacing only: a page that connected
while the module was in its ROM and stage-1 would spend its first opening
read on a board that cannot answer it, the others queued behind it (2252 ms
of board time until the response timeout, measured on a silent board).

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
SERVO-stall is not yet on a project (MaD #298): the machine's kind has no
jam (a lever a stepped kind cannot take from a file the wall clock polls),
so the suite skips it on every project file. On `mad-emulator` (`make
e2e-stall`, which sets `BOARD_ROUTE=emulator` for `board-route.sh`; or
`E2E_BOARD_ROUTE=emulator` with the suite attached by hand) it jams the
carriage by creating `E2E_JAM_FILE`, the file
`mad-emulator --jam-file` watches: while it exists the drive keeps stepping
but the carriage and its encoder stand still. `board-route.sh` defaults it
to `$BOARD_LOGS/jam`. Without `E2E_JAM_FILE` set, SERVO-stall fails at once.

**In CI:** `control-e2e-board` gates a subset per PR on the project
(`make check`, then `make e2e`, one board per scenario, on the runner's
Chrome; `ci.yml`), then BUNDLE-live on the built bundle, then G2+G3+H2+I on
the board with MaD #285 fixed (`make e2e-motion`), then SERVO-stall on
`mad-emulator` (`make e2e-stall`). The nightly
(`e2e-nightly.yml`) runs the whole suite the same way after the node's Chrome
canary, and FW-ISS on the project's serial boot (`make e2e-rom`,
`mad-serial-boot-cosim.toml`); beside it three jobs run everything the
project as drawn cannot run on the #285-fixed board, a third each (`make
e2e-motion MOTION_SHARD=K/3`).
`control-e2e-boardless` gates the scenarios that need no board (A1 and the
firmware-flash `FW*` ones, a host Chrome against in-page fakes).

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
`mad.toml` run live, a `firmware_version` READ on the PTY from the run's
start and again until answered, and a DATA frame back before the run's 2 s
of board time end. It runs as part of `make test` / `sil-rust` and does not
use `/tmp/tty.rpi`. It runs the command `embsim run mad.toml --pty PATH`
hands `mad-runner` in its own process (`embsim_cli::run`, over the same
kinds), on a copy of `mad.toml` beside images it lays out itself, so `cargo
test` needs neither the `embsim` binary nor `make flash-image sd-image`. The
hand-over from `embsim` to `mad-runner` and the checked-in file with the
`make` images are exercised by `make check` and `make e2e`.

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
