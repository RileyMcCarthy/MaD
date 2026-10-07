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
build it for you.

| Target | What it does |
|---|---|
| `make p2image` | Build the P2 image the ISS executes |
| `make protocol` | Regenerate the Rust protocol types for SIL |
| `make emulator` | Protocol + the Rust workspace |
| `make playground` | ISS on `/tmp/tty.rpi` for **manual** testing — **real-time pacing** (`--speed 1`), release build. |
| `make playground-iss` | The same ISS on `/tmp/tty.iss`, so a manual session does not take `/tmp/tty.rpi`. |
| `make playground-rom` | The ISS booting the mask ROM, the host on the programming UART (`P62`/`P63`) |
| `make e2e-emulator` | The ISS behind the WS bridge, unpaced. **Not a valid SIL configuration** (below); no CI job runs it. |
| `make test` | Build the image + protocol, then `cargo test` (includes the MaDSim PTY protocol smoke — no Chrome) |
| `make clean` | Remove build artifacts and `cargo clean` |

## Manual testing with the playground

```bash
cd SIL
make playground
```

This starts the `mad-emulator` binary with a virtual serial port at
`/tmp/tty.rpi`. The host is a browser outside the emulator.

## Running the e2e suite: the computer node

There is one valid SIL configuration for the suite: the P2 image on the ISS,
and Chrome inside a QEMU guest the board's clock meters, talking real Web
Serial to the board's emulated FTDI. The browser cannot outrun the board,
because the board decides when the guest's vCPU runs at all.

**At the pinned embsim (0.2.0) there is no such host.** embsim 0.2.0 removed
the Chrome guest that `mad-emulator --computer` ran (with it the `vm-image` and
`playground-cosim` targets), and the host kind that replaces it, one the
board's clock meters, is embsim's to deliver (`SIL/embsim/MIGRATING-MAD.md` §2,
E4). Until then no run of the board-touching scenarios is a valid
configuration, and the nightly that ran them (`e2e-nightly.yml`) is off. At
embsim c5641f6 the run was:

```bash
make vm-image                                   # once
make playground-cosim                           # DevTools on 9222, control on 9223
npm run dev -- --host                           # the guest fetches from 10.0.2.2:5174
CDP_URL=http://127.0.0.1:9222 npm run e2e       # or e2e:smoke
```

Per PR, and on every move of the embsim pin, `control-e2e-boardless` runs the
scenarios that need no board at all (A1 and the firmware-flash `FW*` ones),
which launch a host Chrome against in-page fakes.

## Clicking around by hand

The browser can't see the emulator's PTY directly, so a small WS↔PTY bridge
relays bytes to the app's (faked) Web Serial port. From
`Software/Control/`, in separate terminals:

```bash
# Terminal 1 — emulator (from SIL/)
make playground          # real-time pacing

# Terminal 2 — WS bridge on ws://localhost:9999
npm run sil:bridge

# Terminal 3 — the app on http://localhost:5174
npm run dev
```

Then **`npm run sil:app`** opens a Playwright-controlled Chrome wired to the
emulator for hands-on testing.

!!! warning "The ISS behind the bridge is not a test configuration"
    The bridge hands the board's bytes to a browser running at host speed, and
    the ISS interprets far slower than real time, so every wait the app makes
    measures the host rather than the machine. Use it to look, not to assert:
    `make e2e-emulator` (the same pairing, unpaced) is kept only until the move
    onto an embsim project retires it, and no CI job runs it.

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
