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
by `make p2image` (`pio run -e propeller2_debug`). `make playground` and
`make e2e-emulator` build it for you.

| Target | What it does |
|---|---|
| `make p2image` | Build the P2 image the ISS executes |
| `make protocol` | Regenerate the Rust protocol types for SIL |
| `make emulator` | Protocol + the Rust workspace |
| `make playground` | ISS on `/tmp/tty.rpi` for **manual** testing — **real-time pacing** (`--speed 1`), release build. |
| `make e2e-emulator` | The same ISS for the **e2e suite** — **unpaced virtual time** (`--speed 0`), so results do not depend on host speed. CI uses this. |
| `make playground-iss` | The same ISS on `/tmp/tty.iss`, so a manual session does not take the e2e PTY. |
| `make test` | Build the image + protocol, then `cargo test` (includes the MaDSim PTY protocol smoke — no Chrome) |
| `make clean` | Remove build artifacts and `cargo clean` |

## Manual testing with the playground

```bash
cd SIL
make playground
```

This starts the `mad-emulator` binary with a virtual serial port at
`/tmp/tty.rpi`. The host is a browser outside the emulator.

## Driving the web app against the emulator

The browser can't see the emulator's PTY directly, so a small WS↔PTY bridge
relays bytes to the app's (faked) Web Serial port. From
`Software/Control/`, in separate terminals:

```bash
# Terminal 1 — emulator (from SIL/)
make playground          # clicking around: real-time
# make e2e-emulator      # automated suite: unpaced virtual time (this is what CI runs)

# Terminal 2 — WS bridge on ws://localhost:9999
npm run sil:bridge

# Terminal 3 — the app on http://localhost:5174
npm run dev
```

Then either:

- **`npm run sil:app`** — opens a Playwright-controlled Chrome wired to the
  emulator for hands-on testing (pair with `make playground`), or
- **`npm run e2e`** / **`npm run e2e:smoke`** — the web-app suite against the live
  emulator. Pair with **`make e2e-emulator`**, not playground: under `--speed 1.0`
  a loaded CI runner cannot hold real time, and motion assertions sample mid-flight.

The MaDSim crate also has a Chrome-free PTY smoke (`tests/pty_protocol.rs`): boot
the binary, send a `firmware_version` READ, expect a DATA frame. It runs as part
of `make test` / `sil-rust` and does not use `/tmp/tty.rpi`.

!!! note "SIL is single-instance"
    There is exactly [one emulator per process](../how-it-works/sil-emulator.md#one-emulator-per-process),
    so scenarios run serially against one emulator (the moral equivalent of
    `workers: 1`). Close `sil:app` before running `e2e` — only one bridge reader
    at a time.

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
