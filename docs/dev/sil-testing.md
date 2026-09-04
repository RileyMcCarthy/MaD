# SIL testing

The [SIL emulator](../how-it-works/sil-emulator.md) runs the **real firmware** on
your host with emulated peripherals, so you can test the whole stack — firmware,
protocol, app — without hardware. All `make` commands run from `SIL/`.

## Build the emulator

```bash
cd SIL
git submodule update --init --recursive   # first time: embsim + ProtoEmb submodules
make emulator     # build firmware (.a) + Rust protocol types, then cargo build
```

`make emulator` chains the pieces: `make firmware` (`pio run -e native_emulator`),
`make protocol` (generate the Rust codec into `Protocol/rust/src/generated`), then
`cargo build`.

| Target | What it does |
|---|---|
| `make firmware` | Build `libfirmware.a` via PlatformIO |
| `make protocol` | Regenerate the Rust protocol types for SIL |
| `make emulator` | Build firmware + protocol + the Rust workspace |
| `make playground` | Run the emulator + trace viewer for manual testing — **real-time pacing** |
| `make e2e-emulator` | Run the emulator for the e2e suite — **unpaced virtual time**, so results do not depend on host speed |
| `make test` | Build everything and run the Rust test suite (`cargo test`) |
| `make clean` | Remove build artifacts and `cargo clean` |

## Manual testing with the playground

```bash
cd SIL
make playground
```

This starts the `mad-emulator` binary with a virtual serial port at
`/tmp/tty.rpi` and a **trace viewer** at <http://localhost:3000> showing live
signals (stepper position, force, GPIO, encoder, …).

## Driving the web app against the emulator

The browser can't see the emulator's PTY directly, so a small WS↔PTY bridge
relays bytes to the app's (faked) Web Serial port. From
`Software/Control/`, in separate terminals:

```bash
# Terminal 1 — emulator (from SIL/)
make playground

# Terminal 2 — WS bridge on ws://localhost:9999
npm run sil:bridge

# Terminal 3 — the app on http://localhost:5174
npm run dev
```

Then either:

- **`npm run sil:app`** — opens a Playwright-controlled Chrome wired to the
  emulator for hands-on testing, or
- **`npm run e2e`** — runs the full web-app E2E suite against the live emulator.

!!! note "SIL is single-instance"
    There is exactly [one firmware per process](../how-it-works/sil-emulator.md#one-firmware-per-process),
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
