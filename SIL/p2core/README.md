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

**Smart-pin configuration is decoded, not ignored.** A model that only watches
`WYPIN` takes the byte and discards the mode word and bit period — which works,
and cannot see a wrong `clkfreq`. `src/smartpin.rs` decodes the mode and derives
the baud rate from the bit period the firmware computed, so misconfiguration
shows up as a wrong rate instead of bytes that look fine:

| pin | mode | derived | nominal |
|-----|------|---------|---------|
| 0/2 | Async Rx/Tx | 115,273 | 115,200 (force gauge) |
| 9 | Quadrature | — | servo encoder |
| 53/55 | Async Rx/Tx | 2,000,000 | 2,000,000 (host protocol) |
| 58/59/61 | SyncRx / SyncTx / Pulse | — | SD MISO / MOSI / clock |
| 62/63 | Async Tx/Rx | 230,547 | 230,400 (debug console) |

It deliberately does *not* simulate bit edges. The models on the other side
consume bytes at a declared rate (embsim's `StreamRole::ByteSink { baud_hz }`),
so edges would be re-serialised at that boundary and the fidelity thrown away.
Carrying the derived rate keeps the check without the edge storm. Clocked
protocols are the exception and stay clock-driven: for SD SPI the clock count
*is* the transfer.

**Traps, never silent no-ops.** Unknown opcode, out-of-range PC and out-of-range
hub access all stop with the address. A no-op turns a firmware change into
drifting numbers that look like a tuning problem.

## Verification

`tests/decoder_golden.rs` checks every decoded instruction against **flexcc's own
listing** — all 27,627 hub instructions in the real image, not a sample. With no
public RTL, that listing is the strongest instruction-level oracle available
offline. Regenerate the golden with `python3 tools/gen_golden.py` after a
firmware rebuild (it is gitignored — a build artifact).

The remaining tests are acceptance checks against the real image, each pinning a
milestone: boot to `_main`, `clkfreq`, the startup banner, the SD failure path,
soft-float sanity, tagged-pointer masking, multi-cog bring-up, a fully
configured machine, and the protocol round trip. They skip when the firmware
artifact is absent.

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
- **`GETBYTE`/`GETNIB`/`GETWORD` take field N *of S*, and N is in the C/Z bits**
  (plus bit 21 for the 3-bit nibble index) — that is what the `ds*get` form names
  mean. Taking the source from D and the index from S turned `buf[0] = 0x40|cmd`
  into command index 1 on every SD frame, and corrupted printf's field handling
  so every log line arrived padded with runs of spaces.
- **`REP D,S` repeats D instructions S times** — D is the block LENGTH. Swapped,
  every REP block ran one instruction long; harmless until an FCACHE'd loop
  executed its trailing `_ret_` each iteration, popping the call stack until it
  underflowed and "returned" out of `mad_begin`'s `while (true)`.
- **Hub access is unaligned-capable.** `send_cmd` stores its argument with
  `*(DWORD*)(buf+1)`; masking the address to a long boundary redirects it onto
  `buf[0..3]`.
- **Hub addresses are masked, and FlexC relies on it** — it builds tagged
  pointers with an `augs`/`or` pair and lets the hardware ignore the tag. A
  strict out-of-range check reports those as wild, which is why `strict_hub` is
  off by default and is a bring-up aid, not a soundness check.

## Sources

All permissive; the GPL models (QEMU, Unicorn) were deliberately not consulted.

- **PNut-TS** (MIT) — instruction encodings, vendored.
- **flexspin/spin2cpp** (MIT) — FlexC ABI and FCACHE semantics.
- **spinsim** (MIT, terms at the tail of `pasmsim2.c`) — ALU/flag semantics.
- **`sdmm.cc`** (ChaN, "no restriction on use") — the SD driver under test.
