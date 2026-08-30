# p2core — a Propeller 2 instruction-set simulator

Runs the **real flexcc-compiled P2 image**, instruction by instruction.

This is a second SIL execution model, not a replacement for the existing one.
The native backend (`embsim-p2`) compiles the firmware with clang for the host
and substitutes the HAL — fast, debuggable, and structurally unable to see
flexcc codegen bugs, 32-bit pointer assumptions, cog stack overflow, or
smart-pin misconfiguration, because it never executes a byte of P2 machine code.
`p2core` executes the artifact you actually flash.

```
cargo run -p p2core --release --example run -- \
    ../../Firmware/MaDCore/.pio/build/propeller2_debug/program
```

```
Starting MaD
0.005 - .../src/DEV/dev_nvram.c: 364: dev_nvram_run: 0 -> 1
1.550 - .../src/DEV/dev_nvram.c: 218: failed to mount sd card: /sd
```

## Status

**Boots the real image to a fully-populated machine and answers protocol
requests.** All eight cogs run, every peripheral has its smart pins configured
(force gauge 0/2, servo encoder 9, host protocol 53/55, SD SPI 58-61, debug
console 62/63), and a host request gets a structured reply:

```
-> 55 00 03                         read firmware version
<- 55 02 03 10 00 "0.0.0" ... C6 14  sync, data frame, cmd 3, len, payload, CRC
```

That is the capability SIL tests need. The SD card model completes the CMD0 /
CMD8 handshake with a correct R7; mounting a real filesystem is not done yet, so
the firmware currently takes its documented mount-failure path and runs on
failsafe records.

## Design

**Functional, not cycle-accurate.** The P2 RTL is not public and the encoding
tables carry no cycle counts, so there is no oracle for per-instruction timing.
Instruction cost is a nominal constant, which makes virtual time systematically
approximate and *bit-reproducible* rather than randomly wrong.

**Dependency-free.** Hub bytes in, [`PinBus`] calls out, `step_until` for time —
no embsim types. Promoting this into `embsim-p2-iss` should be a `git mv`.

**The decoder is generated**, not hand-written. `tools/gen_decoder.py` turns the
vendored PNut-TS table (`vendor/parseUtils.ts`, MIT, © Iron Sheep Productions
and Parallax) into `src/generated/decode.rs`: 359 encodings collapse to six
decode shapes. Regenerate with `python3 tools/gen_decoder.py`; the output is
committed, matching the repo's generate-then-commit convention.

**Traps, never silent no-ops.** Unknown opcode, out-of-range PC and out-of-range
hub access all stop with the address. A no-op turns a firmware change into
drifting numbers that look like a tuning problem.

## Verification

`tests/decoder_golden.rs` checks every decoded instruction against **flexcc's own
listing** — all 27,627 hub instructions in the real image, not a sample. With no
public RTL, that listing is the strongest instruction-level oracle available
offline. Regenerate the golden with `python3 tools/gen_golden.py` after a
firmware rebuild (it is gitignored — a build artifact).

The remaining tests are acceptance checks against the real image: boot to
`_main`, `clkfreq`, the startup banner, the SD failure path, and soft-float
sanity. They skip when the firmware artifact is absent.

## Things that cost hours, so they are written down

Each of these produced correct-looking behaviour while being wrong:

- **The L bit lives in two places.** S1 forms are `EEEE ooooooo 0LI` (bit 19);
  the misc block is `EEEE 1101011 CZL` (bit **18**). Reading the wrong one made
  `setq #2` mean `setq #$28`, so `popregs_` block-copied 512 longs over cog RAM.
- **PTR expressions**: bit 5 CLEAR is *pre*-modify; the index scales by access
  width; and a `SETQ` block transfer advances the pointer by the **whole block**.
- **`ALTD`/`ALTS` S is two fields** — `S[8:0]` offsets the substituted field,
  `S[17:9]` is a signed increment written back to D. flexspin's FCACHE depends on
  the writeback: its `ret_instr_` doubles as an ALTD post-decrement
  (`backends/asm/outasm.c:6213`). spinsim implements only the substitution, so it
  is an *incomplete* oracle here.
- **The `*sj` forms take a signed 9-bit PC-relative offset** when S is immediate.
- **Shifts set C to the last bit shifted out**, and `ENCOD` sets `C = (S != 0)`.
  Omitting these left integer behaviour perfect and corrupted every float — and
  MaD's force and position maths is float.
- **`RDPIN ... WC` sets C for BUSY**, not ready. `TESTP` must read a configured
  pin as complete, because drivers `AKPIN` then wait.
- **`AKPIN` is literally `WRPIN #1,S`.**

## Sources

All permissive; the GPL models (QEMU, Unicorn) were deliberately not consulted.

- **PNut-TS** (MIT) — instruction encodings, vendored.
- **flexspin/spin2cpp** (MIT) — FlexC ABI and FCACHE semantics.
- **spinsim** (MIT, terms at the tail of `pasmsim2.c`) — ALU/flag semantics.
- **`sdmm.cc`** (ChaN, "no restriction on use") — the SD driver under test.
