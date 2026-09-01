# embsim improvement backlog

Living TODO for the SIL framework (`SIL/embsim`) and the MaD consumer (`SIL/MaDSim`).
Inspired by what Renode gets right as an ISS **without** turning embsim into a Renode remake.

**Order is dependency order.** Native SIL stays the default (fast PR CI). ISS is an option on the same pin/time fabric.

Non-goals (unchanged from [BOARD_ENGINE.md](https://github.com/RileyMcCarthy/embsim/blob/main/BOARD_ENGINE.md)): cycle-accurate silicon, PCB parasitics, remaking tlib/QEMU, using Renode as embsim’s kernel.

---

## P0 — Own virtual time

One `virtual_us` counter. The engine (or an idle jump with no time authority) is the only thing that increases it. `--speed` only paces the host after a jump.

- [x] **`virtual_us` is a counter**, never `Instant`. `advance_to` is the only write.
- [x] **`wait_until` / `wait_virtual_us` park** until `now` reaches the deadline.
- [x] **Emulator preempts at HAL** ([embsim#26](https://github.com/RileyMcCarthy/embsim/pull/26)).
- [x] **One clock:** playground `init(speed>0)` jumps then sleeps; tests `init(0)` jump instantly.
- [x] **Tests assert virtual time** (`at t = 100_000 µs, encoder == N`) — e2e `VT-linear` interpolates the downloaded CSV (`time_us` = `HAL_time_getUs` = SIL `virtual_us`).

Unblocks: firmware without emulator yield macros, and ISS `step_until(t)` later.

---

## P1 — Runtime hygiene (Renode-shaped, still native)

- [x] **`Reset()` on every peripheral and MCU instance.** `PeripheralInstance::reset()` ([embsim#31](https://github.com/RileyMcCarthy/embsim/pull/31)).
- [x] **Unimplemented HAL / pin / register access logs** (`embsim_peripherals::access`; P2 trampolines report negative channels).
- [x] **Inspect API:** `PeripheralInstance::inspect()` — UART FIFO depths, GPIO, encoder, pulse-out count, unimplemented counter (lock owners / cog park still open).
- [x] **UART = byte FIFO + host backend.** HAL talks to RX/TX FIFOs; PTY/socket is `init_channel_fd` or `write_host_rx` / `take_host_tx`. Baud is virtual-time.
- [x] **Host-visible testers** wait on virtual time (UART byte arrived by `t`) — `host_tester_byte_is_visible_by_a_virtual_deadline`. GPIO-at-t still open.

---

## P2 — Finish MCU-as-component (already designed)

Board engine slice status (2026-07): serial force path + owned entry shipped; GPIO declaration-only; encoder/pulse-out still hand-wired.

- [ ] **HAL-table → pin facade** for GPIO, encoder, and pulse-out (not only serial). CI fails if tables are stripped.
- [ ] **MadMachine wiring** can be netlist + tables instead of hand-indexed HAL channels (keep a bench-component escape hatch).
- [ ] **Per-instance everything** (already partly done): no process-global clock/peripherals for a second MCU.
- [ ] **Provenance** on remaining plant/sensor numbers (datasheet or governing equation).

---

## P3 — Analog / plant (not ISS)

- [ ] **SPICE / transient analog** behind the reserved `ClusterSolver` seam (quasi-static MNA stays default).
- [ ] Raise fidelity of one digital peripheral at a time **behind the pin interface** (bit-timed serial, PWM edges) without changing consumers.
- [ ] Fault injection on streams (byte loss) rather than hoping cycle-accurate UART emerges.

---

## P4 — ISS option (`embsim-p2-iss`)

Do this **after P0**. Same pin graph and time counter as native. CLI: `--backend native | iss`.

### Framework (embsim)

- [ ] **`IssCore` trait:** `load(image)`, `step_until(t)`, pin drive/sense. Native MCU and ISS MCU are both `Component`s.
- [ ] **CPU ≠ pin machines.** Interpreter only executes PASM2. Smartpin/GPIO/UART are separate models the CPU pokes via `WRPIN`/`RDPIN`/`TESTP`.
- [ ] **Unknown opcode / unknown pin mode traps** (log + stop). Do not no-op.
- [ ] **Do not** make QEMU or Renode the kernel. Optional later: Renode/Unicorn **behind `IssCore`** for Cortex-M / RISC-V.
- [ ] Crate name: **`embsim-p2-iss`** (sibling of `embsim-p2` HAL trampolines). Spike may live in MaD `SIL/p2core/` then promote.

### P2 core (must-work from MaD `propeller2_debug/program`)

- [ ] Load raw FlexC hub image at `$000`; boot `coginit` to `$404` / `entry`.
- [ ] `HUBSET` (record clkfreq at hub `$14`; ignore PLL).
- [ ] Time: `GETCT`, `WAITX`, `ADDCT1`, **`WAITCT1`** (jump). `_waitms` is this, not a spin.
- [ ] CORDIC as functions: `QDIV`/`QMUL`/`GETQX`/`GETQY`.
- [ ] `SETQ` block hub R/W; `WRFAST`/`WFLONG`.
- [ ] **FCACHE** (`CALLPA` + copy into cog RAM). Lock waits and `waitms` inner loops need it.
- [ ] Locks: `LOCKNEW`/`LOCKTRY`/`LOCKREL`; failed `locktry` yields the cog.
- [ ] `COGINIT`/`COGSTOP`/`COGID` + FlexC `entry`/`ptra` worker ABI (7 MaD cogs).
- [ ] Pin ops: `WRPIN`/`WXPIN`/`WYPIN`/`RDPIN`, `DIR*`/`DRV*`/`FLT*`, `TESTP`.

### Smartpin modes (MaD debug image)

Use `propeller2_debug` so MAIN is hardware UART (pins 53/55), not FlexC `_txraw`.

- [ ] `P_ASYNC_TX` / `P_ASYNC_RX` — 2 Mbaud on 53/55 → host PTY; 115200 on 0/2 → ADS122U04.
- [ ] `P_QUADRATURE` — encoder A/B (9/10).
- [ ] `P_TRANSITION` + `P_OE` — counted stepper pulses (pin 8).
- [ ] `P_NCO_FREQ` + `P_OE` — continuous velocity.
- [ ] GPIO IN/OUT/DIR — enable, dir, endstops, ESD.
- [ ] **v1 skip:** SD SPI (58–61), I2C navkey (bit-bang). Mount-fail is already a firmware path.

### MaD consumer

- [ ] `mad-emulator --backend iss --firmware …/propeller2_debug/program`
- [ ] `make playground-iss` (or `playground-p2bin`) — same PTY `/tmp/tty.rpi` as native.
- [ ] Pin map from `HW_pins.h`, not gcc DWARF.
- [ ] E2E unchanged except which playground is running. PR CI = native; nightly = ISS smoke IDs.

### ISS build slices (each is a running program)

- [ ] **A.** Hub + 1 cog reaches `_main` (log `call #_main`).
- [ ] **B.** Async UART → PTY; `printf("Starting MaD Board\n")` appears.
- [ ] **C.** 8 cogs + locks; cog manager starts 7 workers.
- [ ] **D.** Motion + force pins into existing gantry/ADS122U04; app connects; jog moves encoder.
- [ ] **E.** Point `npm run e2e` smoke at ISS playground.

---

## P5 — Later / other MCUs

- [ ] **`IssCore` adapter for Unicorn** (CPU library, `step_until`) or **Renode as a process** (CPU + STM32 catalog) — only when a second MCU is actually in play.
- [ ] Do **not** write an ARM/RISC-V decoder in embsim.
- [ ] Do **not** put plant physics inside UART/GPIO models.

---

## Suggested sequence

```
P0 time  →  P1 reset/inspect/UART  →  P2 pin facade
                 ↓
            P4 ISS (A→E)     P3 analog when a test needs it
                 ↓
            P5 other-MCU ISS plugin
```

MaD default remains `make playground` (native). ISS is `make playground-iss` plus a slower CI job.
