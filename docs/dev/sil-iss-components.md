# The ISS board: what is modelled, what is not

Tracking list for running the **real P2 firmware image** on `p2core`/`p2iss`
with every part of the PCBA present as a node on the net.

The rule this list is measured against: **components interact only through
`TheveninDrive` levels or periodic (pulse) drives.** No byte routes, no stream
routes, no shared tables. A signal that cannot be expressed that way is called
out explicitly rather than quietly special-cased.

Status keys: **done** · **partial** · **todo** · **broken**

---

## Pin map — settled, and previously contradictory

Three sources disagreed. Resolved against the hardware and the toolchain:

| Pin | Flash (boot) | microSD | Source |
|-----|--------------|---------|--------|
| P58 | DO (MISO)  | DAT0 / MISO | P2 Edge module guide; `MaD_Edge.kicad_sch` labels it `P58/FLASH_MISO` |
| P59 | DI (MOSI)  | CMD / MOSI  | as above |
| P60 | **CLK**    | **DAT3 / CS** | as above |
| P61 | **CS**     | **CLK**       | as above |

Flash and microSD **share four pins and swap CLK/CS between them.** That is
why the three maps disagreed:

- `p2core/src/board.rs` (`DO=58, DI=59, CS=60, CLK=61`) — **correct for SD**,
  and independently confirmed: FlexC's `_vfs_open_sdcard()` is
  `_vfs_open_sdcardx(pclk=61, pss=60, pdi=59, pdo=58)`
  (`toolchain-flexcc/include/filesys/fatfs/fatfs_vfs.c:82`).
- The P2 boot ROM uses `P61=#CS, P60=CLK, P59=DI, P58=DO` — **correct for
  flash**, and the opposite assignment.
- `Firmware/MaDCore/src/HAL/Include/HW_pins.h` (`SD_CLK=61, SD_MOSI=60,
  SD_MISO=59, SD_CS=58`) — **wrong**, and dead: nothing reads it for SD,
  because the firmware calls `_vfs_open_sdcard()` which carries its own pins.
  Misleading; should be corrected or deleted. See *Open items*.

---

## Components

| Component | Transport | Status |
|---|---|---|
| Host protocol link (P55/P53) | UART framed on Thevenin levels, rate derived from the guest's own `WXPIN` divisor | **done** |
| Debug console (P62) | Byte-level inside `p2core::Board`, forwarded to the emulator log | **partial** — not a node |
| DS2 piggy board (netlist) + ADS122U04 | UART on levels; analog inputs via MNA cluster solve | **done** — see F1 |
| Load cell bridge | Two Thevenin drives into AIN0/AIN1 | **done** |
| Servo drive — `STEP` | Timed level transitions (`p2iss::pulse::PulseDriver`), both `P_TRANSITION` and `P_NCO_FREQ` | **done** |
| Servo drive — `DIR`, `ENA` | Thevenin levels | **done** |
| Servo `RDY` | Sensed level | **done** |
| Quadrature encoder (A/B/Z) | Encoder model drives levels; `p2core` decodes Gray phases with slip counting | **done** |
| End stops (upper, lower) | `EndSwitch` dry contacts + weak pull-downs | **done** |
| Door end stop | Weak pull only — no model | **partial** |
| ESD lines (upper, lower, switch) | Sensed levels, idle **high** (`activeLow` in `HAL_GPIO_config.c`) | **done** |
| ESD power, charge pump | Driven levels | **done** |
| microSD card | **On nets** as a decoupled component; the ISS reads its smart-pin roles from the mode words (`p2core::smartbus`) and holds no SPI knowledge; firmware **mounts** it | **done** — see S1, S2, G4 |
| SPI boot flash | **On the net** (`p2iss::flashnode`), bit-banged edge-by-edge | **done** — see B1 |
| P2 ROM bootloader | **Executes** the real Parallax ROM and boots from the net flash | **done** — see B2 |

---

## Open items

### F1 — ADS122U04 never answers — **FIXED**
Root cause was **not** in the ADC model or the wiring: the shared UART
**deframer required a full nominal frame time before it would accept the next
start bit.**

A P2 smart pin asked for 115'200 baud at `clkfreq = 160 MHz` actually clocks
**115'273** — 0.06 % fast, a rate any real UART accepts without noticing.
Integer bit periods make the sender's frame 86'750 ns against the receiver's
86'800, so the second byte's start bit landed **50 ns before** the deadline,
was absorbed into the frame in progress, and the stream desynchronized
permanently. The model read the protocol's `0x55` sync byte as register data
and never recovered.

Fix (embsim, `board/src/uart.rs`): close a frame at `stop_sampled_ns()` — the
**midpoint of the stop bit**, which is where real hardware samples it — rather
than at end-of-frame. That buys the standard half-bit of tolerance in both
directions. Regression tests
`a_marginally_fast_sender_still_frames_back_to_back_bytes` and its slow
counterpart; the fast one fails without the fix.

Also fixed in `p2iss`: every transmit pin now idles **high from attach**, so a
far end has a mark level to detect a start bit against before the guest has
configured any rate.

**This is an upstream embsim change and needs its own PR.**

Consequence worth noting: with the force gauge actually streaming, the ISS
changed the speed figure of the day (0.74x → 0.35x), but both numbers predate the G3 time-model fix and were artifacts of it; see G3 for the honest measurement.

### S1 — microSD as a node — **DONE**

The framing gap is closed. Root cause: **AKPIN assembles as `WRPIN #1,S`**
(confirmed against flexspin's listing), so the acknowledge `rcvr_mmc` opens with
never reached the bit-level receiver; the stale word it had latched during the
preceding transmit satisfied `TESTP` immediately, the guest ran a byte ahead of
the bus and deselected mid-frame. Fixed by catching the `WRPIN #1` acknowledge
in the SPI path, and restarting the receiver's bit counter on `WXPIN`. The full
SDv2 initialisation now decodes off the wire, and the firmware **mounts** the
card (see S2).

Original detail follows.

### S1 (original) — microSD as a node — built, one gap left

The bus is real. `p2core::SpiShift` is a bit-level shifter pair
(`p2core/src/spi.rs`), `p2iss::spi_bus::SpiSequencer` drives the clock and MOSI
as `TheveninDrive` levels one transition at a time, and
`p2iss::sdnode::SdCardNode` is a component that senses CLK/CS/MOSI and drives
MISO. `p2iss::P2Iss::with_spi` puts the guest's four SPI pins on nets.

**Working and asserted** (`p2iss/tests/sd_node.rs`): clock edges cross a net,
chip select gates them (a deselected card ignores the 64 dummy init clocks),
bytes assemble out of bits, and the card decodes **CMD0 — frame, argument and
CRC — off the wire**.

Four hardware behaviours had to be modelled to get there, each found by reading
`sdmm.cc` rather than guessing:

1. **SPI mode 3, not mode 0.** The driver sets
   `spm_ck = P_PULSE | P_OE | P_INVERT_OUTPUT` and calls it `CPOL = 1`. The
   clock idles **high**, leads with a falling edge, drives data on the leading
   edge and samples on the trailing one.
2. **`DIRL`/`DIRH` on the transmit pin are reset/liven**, not direction.
   `WYPIN` loads the *shifter* while reset and the *buffer* once livened.
3. **The transmitter is two registers deep.** `xmit_mmc`'s continuous-mode loop
   queues the next longword and spins on `TESTP PIN_DI` for the buffer to
   empty. A one-register model loses every word but the last.
4. **The receiver holds one word, not a queue.** A word completing before the
   last was read overwrites it. Queueing them made `TESTP` read true when
   nothing had arrived, so the driver stopped waiting for the bus and fired
   burst after burst into a transfer that had not happened.

**The remaining gap**: every command after `CMD0` arrives misframed, currently
by four bit times — the card reads `0xF4` where `0x48` was sent, which is four
idle ones followed by the first four bits of `CMD8`. The byte boundary slips
somewhere between the first response and the second frame, a region containing
a deselect, a reselect and `wait_ready`'s idle bytes. It is a **count of clock
edges going astray**, not a wire-order or polarity error — either of those
would have broken `CMD0` too.

Captured as `the_card_completes_the_full_initialisation_sequence`, `#[ignore]`d
rather than weakened, to be un-ignored when it passes.

**Cost, measured** (`p2core/examples/sd_cost.rs`): a three-second boot clocks
194 SPI bytes ≈ 4 656 engine events; a sustained 512-byte block is ~12 k.
Affordable — an earlier estimate against this was wrong.

### S2 — FlexC `mount()` — **DONE**

The mount succeeds. There were two defects between the card and a working
mount, both fixed:

1. **A `p2core` `BITH` span bug.** flexspin encodes a method-pointer tag as
   `obj | (index << 20)`, which compiles to `BITH obj, #20 ADDBITS 4` — a
   *five-bit span*, not one bit. `p2core`'s `BITH`/`BITL`/`BITNOT` set a single
   bit, turning method tag 31 into tag 1, so `mount()`'s `(*v->init)(name)`
   dispatched into the cog manager's task table instead of the filesystem's
   `v_init` and returned 1. Fixed with a span implementation and a regression
   test (`bit_instructions_cover_their_addbits_span`).
2. **A toolchain heap-reuse bug** in `fatfs_vfs.c`: the `FFS` block (which
   carries ff.c's `FatFs[]` statics as members) was not zeroed, so `f_mount`
   read a garbage "old volume" and ran `disk_deinitialize` on it — closing the
   block handle that had just been opened. Fixed by zeroing the two managed
   blocks in the toolchain source (a local patch; see *Toolchain patches*).

With both fixed the firmware reads block 0 (boot sector) then block 129 (root
directory) over the wire and advances past the mount. Tests
`p2iss/tests/sd_mount.rs` (formatted card mounts, blank card is probed and
rejected) and `sd_node.rs` (the full init sequence completes).

### S2 (original) — FlexC `mount()` returns -1 — narrowed
`dev_nvram.c:218: failed to mount sd card: /sd`, so the firmware boots on
failsafe records. The image is a valid FAT16 volume — `fsck_msdos` reads it
clean, and `p2iss::sdimage`'s own tests walk the directory tree and cluster
chains — so the fault is not in the image.

**Narrowed with `p2iss/examples/sd_mount_probe.rs`**: against the byte-routed
card the guest issues `CMD0, CMD0, CMD8, CMD55, ACMD41, CMD58` — a complete,
correct SDv2 initialisation — and then **never reads a single block**
(`reads: []`). FatFs cannot have started mounting, so the failure is inside
`_sdmm_open` (`fatfs_vfs.c:30`): either `disk_setpins`/pin reservation or
`disk_initialize` returning `STA_NOINIT`. The byte-routed model cannot get
further because it cannot represent what `disk_initialize` does next — the 15 kΩ
pull-up on the receive pin, or the smart-pin reconfiguration
(`_wxpin(PIN_CLK, ck_div)`, `_wrpin(PIN_DI, spm_tx)`) at its tail.

**Likely subsumed by S1.** A faithful bit-level bus represents all of it; this
should be re-tested once S1's framing gap closes rather than chased separately.

### B1 — SPI boot flash — **DONE** (on the net)

`p2iss::flashnode::FlashNode` is a first-class component on real nets. It wraps
`p2core::SpiFlash` (the shared protocol: `$66`/`$99` reset, `$04` write-disable,
`$05` status→`$00`, `$03` read-data), senses CLK/CS/MOSI and drives MISO. It
shares the four Edge-module pins with the microSD, distinguished by chip select,
with **CLK/CS swapped** (flash `CLK=P60`, `CS=P61`).

**It works because the ISS yields at every net-pin event** — the mechanism that
answers "why can't embsim handle a bit-banged device". See *The yield mechanism*
below. `p2iss/tests/rom_boot_net.rs` boots the real ROM from a net flash: the
flash sees ~17k clock edges cross the net, and the payload runs.

`p2core::SpiFlash` also has a Board-resident host (`Board::with_flash`) used by
`p2core/tests/rom_boot_chain.rs` — a fast, instant-pin path for the CPU-level
boot test, with no net. Same protocol logic, two mounts (exactly as the SD card
is both byte-routed in `Board` and net-routed via `SdCardNode`).

### B1 (original) — SPI boot flash as a node
The P2 Edge carries a serial flash on P58–P61 with **CLK = 60, CS = 61** — the
same four wires as the microSD, with those two exchanged. Nothing models it.

The infrastructure now exists: `SpiPins::FLASH` is defined alongside
`SpiPins::SD`, and a flash component would sense the same bus behind its own
chip select, exactly as the hardware distinguishes them. Blocked on S1's
framing gap — there is no point adding a second device to a bus whose byte
boundaries drift.

### B2 — P2 ROM bootloader — **DONE**

The real Parallax boot ROM executes end to end. `p2core::Machine::with_boot_rom`
loads the 16 KB ROM into the top of hub RAM and starts COG 0 at `$FC000`
(wrapping to `$7C000`), exactly as silicon does. The ROM seeds its RNG, loads
its own cog/LUT images, walks the pull-up decision tree on P59/P60/P61, and —
finding the flash strap on P61 — bit-bangs the SPI flash, loads its first
kilobyte, verifies the 256 longs sum to `"Prop"`, copies them to cog RAM and
jumps.

That kilobyte is `p2iss/rom/stage1.spin2`, this repository's stage-1 loader: it
reads the application length at flash `$400`, streams the application into hub 0,
and relaunches the cog on it — the same entry convention the ROM used on
stage-1. `p2iss::flashimage::boot_flash` builds the layout.

Getting the ROM to run needed a batch of instructions the MaD firmware never
uses, each added to `p2core` with its behaviour read off the ROM source or
flexspin's output: `RCL`/`RCR`, the hub FIFO (`WRFAST`/`RDFAST`/`WF*`/`RF*`),
`SETD`/`SETS`, `SETQ2`→LUT block loads, `DRVC`/`DRVNC`/`DRVZ`/`DRVNZ`/`DRVNOT`,
`BITC`/`BITNC`/`BITZ`/`BITNZ`, the `SETSE`/`POLLSE`/`SETINT` event ops (inert),
and the full `J{n}CT/SE/INT/ATN/PAT/…` jump-on-event family. Two structural
fixes came with them: the 20-bit PC now **wraps** rather than trapping (so
`$FC000` hub-exec works), and an **augmented `S` is a 32-bit literal**, never a
`PTRA`/`PTRB` expression — without that the ROM's own self-load read from the
wrong place. Test: `p2core/tests/rom_boot_chain.rs`.

Reference: `p2iss/rom/rom_booter_v33k.spin2` (trimmed Parallax source; see
`p2iss/rom/README.md`).

### B2 (original) — P2 ROM bootloader
Real silicon loads 16 KB of boot code from an internal ROM into the top of hub
RAM; COG 0 runs it, sets RC-FAST, samples pull-ups/downs on P59/P60/P61 to pick
a boot source, and loads the application from **serial, SPI flash, or SD**.
The ISS skips all of it and writes the image into hub RAM directly.

What the ROM does, from the Parallax documentation: on reset the P2 loads 16 KB
of boot code from an internal serial ROM into the top of hub RAM; COG 0 runs
it, sets RC-FAST, and samples pull-ups/pull-downs on **P59/P60/P61** to choose
between serial, SPI flash and SD as the boot source.

Reference: `ROM_Booter_v33k.spin2` in `parallaxinc/propeller`
(`resources/FPGA Examples/`) — permissively available, worth reading before
implementing rather than inferring the decision tree.

Depends on B1: there is nothing to boot *from* until the flash is a device.

### G1 — Debug console is not a node
P62/P63 are still byte-level inside `p2core::Board`. They should be a
`SerialLink` like the protocol and force-gauge links.

### G2 — `HW_pins.h` SD block is wrong and unused
Correct it to the real microSD map (`CLK=61, CS=60, MOSI=59, MISO=58`) or
delete it, and note that `_vfs_open_sdcard()` carries the pins.

### G3 — ISS runs below real time — measured, and mostly the firmware's polling

The old "0.74×" was an artifact. `system_clocks()` returned the *maximum* cog
clock and `step_until` round-robined by turn, so one cog's `waitx`/`waitct1`
dragged the machine's "now" forward and froze every other cog for the length of
the wait: the protocol cog answered ~2.5 s late, and the phantom
`Scheduling overrun (19994/1000 us)` came from the same jump. Time is now the
frontier — the *minimum* over running cogs; `GETCT`/`WAITCT1` use the cog's own
clock; a `coginit`'d cog inherits its starter's clock. Request→reply is
50–100 ms of wall at `--speed 1`.

Honest speed after that: ~0.1× on an M2, ~22–29 M guest instructions/s of wall.
A profile (`sample`, 8 s, steady state) puts ~61% in `p2core` interpretation,
~23% in the pacer's `nanosleep` (genuine guest idle — unpaced reaches 0.10×
against 0.09×), and **~7% in the embsim net engine**. A transaction-level bus
would trim that 7%, not the interpreter; see `docs/dev` scope notes before
reopening the byte route (embsim c254a64 deleted it on purpose).

Where the guest instructions go, on the Board model: **the firmware's own
free-running polls.** After the G5 fix below, `HAL_serial_recieveBytes`'s
1024-iteration idle spin (SERIAL cog) is ~85% of all executed instructions, the
force-gauge `_getus` timeout loop most of the rest. `waitx`/`waitct1` are free
clock jumps in the ISS (and cheaper on silicon), so a short backoff in those
idle paths would make the ISS nearly real-time without touching the
interpreter. The existing idle-poll fast-forward (`PollState`) only skips pure
register-only self-loops; it saves nothing while any other cog is busy, because
`step_until` still steps every cog under the deadline once per pass.

Cheap interpreter wins measured on a copy, not yet landed: precompute the
per-pass deadline in clocks instead of `now_us()` + a mul/div per cog (+5.5%),
hoist the `std::env` lookups out of the hot path and a 4-byte `rd_long` fast
path (+4.5%); a decode cache is worth only ~2%.

### G5 — `SETQ` + `WRLONG #imm` is a block *fill* — **FIXED**

flexcc lowers `memset(p, 0, len)` to `setq #len/4-1` / `wrlong #0, p`
(31 sites in this image; every module's `_init`). p2core executed the immediate
form as the register form — a block *copy* from cog register 0 upward — so each
`_init` sprayed cog 0's FCACHE contents over its own data. The visible chain:
`app_testManagement_data.request.pendingManualMoveCount` received the bytes of a
`jmp` word (0x5D9000), the CONTROL cog drained six million phantom moves under
the CONTROL-channel lock forever (`lib_staticQueue_push: data is FULL` on every
one), and MONITOR spent 100% of its instructions in `locktry` on that lock —
"live readout never populated" in the app e2e. Found by tracing lock-table
transitions per instruction, then watching the corrupted hub long for writers
(the writer was `_app_testManagement_init+0x18`, i.e. the memset itself).
Symbols came from re-assembling the flexcc `.p2asm` with `flexspin -2 -l`,
which the PlatformIO build does not produce.

After the fix: zero queue-full prints, guest demand 172 M → 75 M instructions per
virtual second, app e2e smoke 2/20 → 8/20. Regression: `p2core/tests/block_fill.rs`.

What the corrected ISS then surfaced — firmware, not ISS, and not yet acted on:
- **MONITOR stack overflow.** 1024-byte stack, 1000 bytes (97%) peak; the upper
  canary trips at the first test start (`Stack underflow detected on channel 0`)
  → channel ERROR → `APP_CONTROL_FAULT_COG` → every later `WRITE_MOTION_ENABLE`
  NACKed. The debug image's `%0.3f` `DEBUG_*` formatting on that cog is the
  likely straw.
- **NVRAM save unmounts the LOGGER's volume.** A runtime profile save
  (`dev_nvram_run: 4 -> 3`) mounts and `umount`s the single FatFs volume on
  MAIN while LOGGER owns it; LOGGER's next opens fail with errno 12 and
  `WRITE_TEST_RUN` is NACKed (`invalidatedPartialUpload`). `dev_nvram.c:464`
  already works around the boot-time version of the same race.
- LOGGER overruns of 1.4–5.3 ms on file open/close (FatFs directory work inside
  a 1 kHz tick) — real, noisy, not fatal.
- p2core's `LOCKTRY` lets the owning cog re-acquire (reentrant); CLAUDE.md
  documents HAL locks as non-reentrant. Verify against the silicon doc — the
  firmware's shared CONTROL-channel lock (`app_motion` / `app_testManagement` /
  `app_control`) has nested-acquire paths that only work if silicon agrees.

### U1 — the UART deframer fix must go upstream
`embsim/board/src/uart.rs` gained `UartFraming::stop_sampled_ns` and two
regression tests (see F1). The submodule is on the unmerged branch
`feat/delete-byte-routes`; this needs its own PR to
[embsim](https://github.com/RileyMcCarthy/embsim) before the MaD pin bump.

### G4 — the SD smart-pin path is generalized — **DONE**

The SD card is now as decoupled from the CPU as the flash. `p2core::smartbus`
models the P2's synchronous-serial smart pins as CPU hardware: it reads the
clock/TX/RX roles from the mode words the firmware programs (`P_PULSE` clock,
`P_SYNC_TX`/`P_SYNC_RX` with the clock-pin offset in bits 26:24 — the same field
the quadrature decoder reads), shifts and samples on the clock's edges, and
exposes the driven pin levels. The ISS no longer declares an "SPI bus" or knows
any pin roles: it lifts the four SD pins onto nets generically (`with_sync_serial`
enables the board's smart-pin model), pumps the clock pin's edges over virtual
time, and moves levels. `SdCardNode` is a plain net-sensing component.

Two bugs were found completing this, both worth recording:
- **`WYPIN y` on a pulse clock is `y` pulses = `2y` transitions** — the old
  sequencer knew this (`transitions = pulses * 2`); the first cut clocked half.
- **One edge per distinct virtual instant.** The yield re-wakes and the periodic
  slice all call the pump at the same instant; firing an edge on each burst
  several transitions into one net resolution, which collapse on the wire and
  make the device miss edges. The pump now gates on a scheduled edge time
  (`NetPins::next_edge_ns`) — the same discipline the flash bit-bang needs, made
  explicit for the smart-pin clock.

`p2core::Board` keeps its byte-routed SD for standalone runs and unit tests (off
unless `enable_smart_bus`), exactly as it keeps the byte path beside the net one
for other peripherals.


### G6 — the SD *write* path had never been exercised — **FIXED**

Every failure that looked like a filesystem or firmware fault on the ISS —
`fopen(..., "wb")` returning errno 12, `WRITE_TEST_RUN` NACKed, "New Test
started" never appearing — was the card model. `errno 12` is **`EIO`** in
FlexC's non-standard `errno.h` (`ENOMEM` is 7, `EMFILE` 11), and
`_set_dos_error` maps it from `FR_DISK_ERR`; the guest was reporting a disk
fault, accurately. Four defects, all in `p2core`, none in the firmware:

- **`CMD24` could not receive its block.** The command arm set
  `Phase::ReceivingBlock`, then `xfer_inner`'s `Command` arm overwrote it with
  `Responding` because a response was now queued, and draining that response
  returned the card to `Command`. `ReceivingBlock` was unreachable. The host
  read `$FF` where `xmit_datablock` wants the `$05` data-accepted token, and
  the 512 payload bytes went to the command collector, which latches on any
  `%01xxxxxx` byte and manufactured commands out of file data — a directory
  entry's `"BIN "` decoded as `CMD2`. Fixed with `pending_write` +
  `after_responding()`.
- **`CMD18`/`CMD25` were not implemented at all.** `sdmm.cc` picks the
  multi-block form for *any* `count > 1`, which is most of what FatFs asks
  for, and the model answered `R1_ILLEGAL` — `send_cmd() == 0` reads that as
  failure. Single-sector metadata writes worked, so a file would be created
  and then fail on its contents, which reads as an intermittent fault.
- **Releasing CS did not abandon a transfer.** `xmit_datablock` starts with
  `wait_ready()`, and on timeout returns *without* sending the token: the card
  is left waiting for a block that never comes. Only a deselect frees it, and
  the net-side node stops exchanging bytes entirely while CS is high — so a
  card that only noticed the release during an exchange never noticed at all.
  It stayed in `ReceivingBlock` and swallowed every later command frame as
  payload; the captured wire shows the host re-sending `58 00 00 00 a5 01`
  into a card answering `$FF`, with the bus dead for the rest of the run.
  Fixed by making it `SdCard::set_selected`, called from the CS sense.
- **Idle-poll fast-forward starved the bus.** See G7.

Regression tests: `p2core/tests/sd_block_write.rs` drives the card exactly as
`sdmm.cc` does (command frame, R1 poll, token, payload, CRC, data response)
for single block, multi-block read and write, a deselect mid-block, and the
"command accepted but no block sent" stall.

### G7 — fast-forward must not skip a spin on a *pin* mid-transfer — **FIXED**

`testp` changes nothing and passes every purity test, so the idle-poll detector
counted `testp / jmp #$-1` as a confirmed idle loop and jumped the cog's clock
to the end of the slice. But `step_until` is called with the engine's *current*
instant, so a fast-forwarded cog executes about one iteration per wake — while
`sdmm.cc` times its own transfers out in guest clocks (500 ms in `wait_ready`,
125 ms for a data token). The transfer crawled, the timeout expired, and
`select()` failed with no command ever reaching the card: 31 writes per run
became zero. A/B with `P2CORE_NO_FF=1` was decisive.

The rule is now: a loop that reads a pin (`TESTP`/`TESTPN`/`RDPIN`/`RQPIN`, or
`INA`/`INB` as a source) may still be fast-forwarded when nothing is clocking —
a level can then only change on a net wake, which ends the slice anyway — but
never while `PinBus::external_transfer_busy()` reports a burst in flight. The
blanket version of this rule cost 4x throughput (0.10x → 0.03x); gated on an
in-flight transfer it costs nothing measurable.

### Firmware findings the corrected ISS surfaced — **FIXED**

- **MONITOR overflowed its stack.** 1024 bytes against a measured 1032-byte
  deepest path (`app_monitor_run` → `processLogging` → `IO_SDCard_push` →
  `lib_staticQueue_push` → `DEBUG_ERROR` → `fprintf` → `__dofmt` →
  `__fmtfloat`; the `%0.3f` timestamp in `DEBUG_*` is most of it). The canary
  tripped at the first test start, the channel went to ERROR,
  `APP_CONTROL_FAULT_COG` latched, and every later motion-enable was NACKed —
  six e2e scenarios waiting on "Motion: enabled". Now 2048.
- **The two canary messages were swapped.** The stack grows *up* from
  `stack[0]`, so corrupting the lower canary is an underflow and running off
  the top is the overflow; the strings said the opposite.

### G8 — the guest slept a full slice after every SD byte — **FIXED**

Measured, not guessed: a burst-timing probe over a whole run put a byte's wire
time at a median **0.40 us** and the gap after it at a median **93.6 us**, so
**99.9% of SD virtual time was dead gap** and a sector cost ~50 ms of guest
clock instead of ~0.2 ms. `service_smart_clock` armed nothing when a burst
finished, so the guest waited for the next periodic `SLICE_NS` wake before it
could clock the next byte. `sdmm.cc` times its own transfers out in guest
clocks, so this alone can fail a transfer the card answered perfectly.

The fix arms a wake at the next microsecond, which is the finest step
`step_until` can act on. It must be computed from **`now_ns`**, not from the
edge's own `due`: `due` can already be in the past when the wake fires, and
arming there makes the wheel refire at an instant virtual time cannot leave —
that deadlocked the engine and was the reason the first attempt was reverted.
After the fix the median gap is **0.60 us** (156x better) with idle throughput
unchanged at 0.10-0.12x.

### G9 — `DIR`/`OUT` are per-cog; the pad sees the OR — **FIXED**

This was the lost data token, and the cause was nowhere near the SD model.

`Board` mirrored `DIRA`/`DIRB`/`OUTA`/`OUTB` into one global pair, but they are
**per-cog** registers on the P2 and the pad sees the OR across all eight — the
firmware says so itself at `dev_nvram.c:462` ("The P2 ORs pin DIR/OUT across all
8 cogs"). So any cog's write erased every other cog's. The debug console (P62)
and the SD card (P58..P61) share `DIRB`, and a `DEBUG_*` print issues about
**327,000 `DIRB` writes in 30 seconds**, every one of them with the SD bits
clear. Each made `dir_of(P59)` read low, and `Board::dir_out_changed` forwards
that to the smart bus as `set_tx_livened(false)` — which is a **reset** of the
sync-serial transmit shifter, not a direction change.

When one landed between `sdmm.cc`'s `dirh PIN_DI` and its clock burst, the
loaded `$FE` data token was wiped and the card was clocked `$FF` instead. The
card then sat in `ReceivingBlock { got: 0 }` discarding all 512 payload bytes,
`xmit_datablock` failed, and FatFs never persisted the file's directory entry or
FAT — so the G-code file could not be re-opened and no test could start. It was
intermittent precisely because it depended on a print landing inside that
window.

Fixed by tracking `dir`/`out` per cog and OR-ing them at the pad, with the cog
index threaded through `PinBus::dir_out_changed`. Regression tests in
`p2core/tests/per_cog_dir.rs` cover the console-versus-SD case directly, that a
pin is released only once every cog has released it, and that `OUT` is OR-ed the
same way. After the fix an isolated run completes the whole sequence for the
first time: G-code written, closed, **re-opened for read**, sample file opened,
moves processed, test started.

Note the class of bug: any peripheral sharing a `DIR` bank with a pin another
cog drives was exposed to this. The SD was simply the first to notice, because
its transmit path treats `DIR` as a reset.

### G10 — with the SD actually working, the *engine* is the bottleneck

A profile taken during SD traffic inverts the idle picture completely:

| | idle | during SD traffic |
|---|---|---|
| `p2core` interpretation | ~61% | **83 samples** |
| net engine (`EngineCore::run`) | ~7% | **3727 samples** |

The hot spots are per-edge overhead — the wake heap, mutex traffic,
`publish_levels`, and malloc/free from `PinHandle` churn — not CPU emulation.
`publish_levels` has since been made allocation-free (fixed arrays instead of
`HashMap`s, and the component facade is no longer cloned per call), which
removed the malloc traffic but did not move the throughput needle: the cost is
in the engine's per-edge resolve, at roughly 24 engine events per SD byte.

**This corrects the earlier answer in G3.** The claim that a transaction-level
SPI/I2C bus "would trim 7%, not the interpreter" was measured with the SD
*idle*, when the interpreter genuinely dominated. Now that writes work, an
SD-heavy phase drops the ISS to ~0.00-0.01x and the engine dominates. For the SD
path specifically a transaction-level hand-off is the right lever after all —
which is what the fidelity-first design (a shared edge-to-transaction decoder
plus batched drive sequences, with the capability-gated word hand-off held in
reserve) was scoped to deliver.

### Still open — SD throughput

The suite is unchanged at 8/20, and the binding constraint has moved: the SD is
now *correct* but slow enough that the app's 15 s waits expire during a test
run. Speed alternates between 0.10-0.11x when idle and 0.00x whenever the SD is
busy. The remaining work is the throughput programme above, not another
correctness hunt.

## The computer node (co-simulation)

The ISS interprets every instruction, so a run's virtual time falls far
behind the wall clock (≈0.1× idle, ≈0.002× during SD traffic), and a host
app that measures its timeouts in wall time — MaD Control's 2 s protocol
budget — gives up before the firmware has done a few milliseconds of work.
The answer is not to make the app patient but to put the host on the board:
`embsim-qemu` runs the app's Chrome inside a QEMU guest (HVF, native speed)
whose clock only advances while the board's does. The node is a registered
virtual-clock actor: it parks at every 1 ms slice boundary, the engine
advances the board that far, the node thaws the guest for the same span of
wall time, freezes it, and parks again. An in-guest agent answers the
guest's own `CLOCK_MONOTONIC` once per slice so the books are exact (skew
stays within a slice or two over any run, no drift). The guest talks to the
board over an emulated FTDI on the same `HOST.TX`/`HOST.RX` pins the PTY
used, and the app uses its real Web Serial — the e2e's fake serial is not
installed in this mode.

Run it: `make vm-image` once, then `make playground-cosim`, serve the app
with `npm run dev -- --host`, and drive the suite with
`CDP_URL=http://127.0.0.1:9222 npm run e2e` (Playwright attaches with
`connectOverCDP`; every wall-clock wait is scaled by `E2E_TIMEOUT_SCALE`,
default 10, because the guest lives at the board's pace). Scenarios that
need the fake serial's `__silDropLink` hook (B5, M11) are skipped in this
mode; the ones that launch their own host Chrome (A1, boot ROM) still do.

What was measured building it, so nobody re-measures it: one freeze/thaw
costs 0.5 ms of host time; the guest lives the metered window minus a
constant 0.14 ms with ~3 µs jitter; a zero-length window still lets it live
~0.3 ms. Under HVF the guest reads the hardware counter directly and QEMU
only holds an additive offset, so stop/cont is the platform's only time
primitive — there is no rate scaling short of TCG's `icount`, which is
refused with hardware virtualisation. Chromium's Web Serial and
secure-context policies match explicit origins only (`http://10.0.2.2:5174`;
a bare host or `:*` is ignored), and Chrome's DevTools HTTP endpoint wants
HTTP/1.1 and may not close the connection. Three more, found by running the
suite: (1) with Hypervisor.framework's own GIC (QEMU's default on macOS 15+)
a vCPU that executes `WFI` with no timer pending parks inside `hv_vcpu_run`
and QEMU's kick does not bring it back, so a QMP `stop` waits in
`pause_all_vcpus` for an interrupt that never comes — `ChromeGuest` passes
`-M virt,kernel-irqchip=off` so `WFI` exits to QEMU's own wait (diagnosed
with `sample <qemu pid>`: `VcpuStateManager::wait_for_interrupt` under
`Hv::Vcpu::run`); (2) slirp's IPv6 router advertisements land a SLAAC
address on the guest's NIC minutes after boot and Chrome aborts every load
in flight with `ERR_NETWORK_CHANGED` — the netdev runs `ipv6=off`; (3) the
guest's Chrome outlives every scenario, so the harness opens a fresh browser
context per scenario, or the app remembers its port and data folder from
the last one and reconnects by itself. Details and the guest image's
conventions: `SIL/embsim/qemu/` and `SIL/embsim/qemu/guest/chrome/README.md`.
