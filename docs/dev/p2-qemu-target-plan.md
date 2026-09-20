# Plan: move the P2 ISS onto QEMU

Scoped 2026-09-19 against `feat/iss-rom-serial-flash`, after measuring the
current interpreter. Decision taken: **build a QEMU TCG target for the
Propeller 2 and make it the ISS.** This document is the plan, its design
decisions, its spikes, and the criteria that would stop it.

Companion to [`p2core-to-embsim.md`](p2core-to-embsim.md) (which still goes
ahead — see [Relation to the embsim promotion](#relation-to-the-embsim-promotion)),
[`sil-iss-components.md`](sil-iss-components.md) and embsim's
`DETERMINISM.md`.

---

## Why, in one line

**Crossing 1.0x real time is the prize, and only a JIT gets there.** At ≥1.0x
the whole clock-gating apparatus can be retired: the QEMU-Chrome computer node
stops being mandatory, `E2E_TIMEOUT_SCALE=10` goes away, the app's 2 s protocol
timeouts become honest against a native browser, and the
`ISS + bridge is meaningless` trap in `sil-two-valid-configurations` stops
existing because both pairings become valid. That is an architecture deletion,
not a faster test run.

### The arithmetic this rests on

> **Refined by Spikes 0c and 0a-2 (2026-09-20).** The target is **106 M inst/s
> for 1.0x**, not 126 M — `p2core`'s 0.19x is achieved while *eliding*
> idle-poll instructions via fast-forward, which a TCG target does not get
> (measured 1.25x multiplier). 0c initially projected 0.5–0.8x, but that came
> from a mis-modelled slice cost; **0a-2 measured it at the operational point
> and 1.0x is reachable** with a ~18.5-host-cycle budget per JIT'd P2
> instruction. The premise below stands.

Measured 2026-09-19 on a quiet M2 (see [Measurements](#measurements)):

| | M inst/s | real-time factor |
|---|---|---|
| p2core today | 24 | 0.19x |
| p2core + three local fixes (measured 2.54x) | 54 | 0.43x |
| + JIT 2x over that | 108 | 0.85x |
| + JIT 3x over that | 162 | **1.28x** |

Only **15.8%** of current interpreter time is real semantic work (`execute`,
`set_reg`, `rd_long`, pin bus); **84.2%** is scaffolding — fetch, decode,
operand plumbing, condition and prefix handling, scheduling. A translator that
removed *all* scaffolding is a **6.3x hard ceiling**. The plan is sized against
capturing roughly half of it.

---

## What "QEMU" has to mean here, and why it is the crux

**Not `qemu-system-p2` as a subprocess.** Every `WRPIN`/`RDPIN`/`TESTP`/`DIRA`
write has to reach embsim's net engine *synchronously*, at MHz rates. A socket
or QMP hop per pin operation is three orders of magnitude too slow. The
existing `embsim-qemu` `QemuNode` meters its guest with QMP `stop`/`cont` at a
**measured 0.3–0.5 ms floor**; the P2 needs ~6 ns pin resolution.

**So: QEMU is linked into the emulator process as a library**, and `PinBus`
calls become direct C→Rust function calls. This is the industrial pattern —
[QBox](https://www.machineware.de/products/qbox-qemu) layers `libqemu` →
`libqemu-cxx` → `libqbox` to put QEMU inside a SystemC TLM simulation, and
[Xilinx's libsystemctlm-soc](https://github.com/Xilinx/libsystemctlm-soc) does
the socket variant. It is also
[not officially supported by QEMU](https://www.minres.com/integrating-qemu-in-systemc-virtual-platforms/),
which means **we own the library patches as well as the target**.

That is the single biggest under-appreciated cost in this project, and it is
why Phase 0 exists.

---

## Architecture

```
  MaDSim / embsim board engine  ── time authority, nets, models, SD, flash, Chrome node
        │
        │  Component trait (same surface as P2Iss today)
        ▼
  embsim-p2-qemu  (Rust)  ── slices execution by icount, owns the CPU lifetime
        │
        │  FFI: run_slice(icount) ↓    PinBus callbacks ↑ (wrpin/rdpin/testp/dir_out/...)
        ▼
  libqemu-p2  (C)  ── target/p2 TCG frontend, hub RAM, 8 cogs
```

**QEMU owns:** instruction semantics, translation, hub RAM, cog RAM, the 8 cog
contexts, CORDIC, the FIFO/streamer addressing.

**embsim keeps:** the virtual clock and time authority, every net, every
peripheral model, the SD card, the flash, the serial links, the Chrome
computer node, determinism gating. Nothing electrical moves into QEMU.

The seam is `PinBus` — unchanged. That trait was written to be exactly this
boundary, and it survives the migration verbatim.

---

## Design decisions

### D1 — Eight vCPUs, single-threaded TCG, icount

Model each cog as a QEMU vCPU under `-accel tcg,thread=single` with `-icount`.
Single-threaded TCG plus icount gives deterministic interleaving, which is what
`DETERMINISM.md` actually requires. MTTCG (8 host threads) is refused: it is
nondeterministic.

Consequence, stated plainly: **QEMU's record/replay is unavailable**, because
it [works only in single-CPU TCG mode](https://www.qemu.org/docs/master/system/replay.html).
Run-to-run determinism does not depend on it; reverse debugging would.
Revisit only if we later collapse the eight cogs into one CPU with the cog id
carried in the TB flags.

### D2 — Cog RAM is memory, not TCG globals

`ALTD`/`ALTS`/`ALTI`/`ALTR` rewrite the *next* instruction's operand addresses
at runtime, so D and S cannot be resolved at translate time. Cog registers are
therefore an array in `CPUArchState`, and every ALU op is load/load/op/store
through a runtime index. This is the main reason we budget ~3x rather than ~6x.

Cog RAM is also the instruction memory at `$000–$1FF`. **Spike 0b settled how
to handle that** (see its findings under Phase 0):

- Cog RAM is **not** guest RAM. It lives in `CPUArchState` as an array reached
  by `tcg_gen_ld_i32`/`st_i32` at computed `env` offsets, so a register write
  never enters softmmu's store path. Measured: a store into a page holding
  translated code costs +194 ns *even when it invalidates nothing*, because the
  `TLB_NOTDIRTY` trap is per-page and sticky. At 0.62 cog writes per
  instruction that alone is 120 ns/inst — 3x slower than the interpreter.
- Cog-exec is **interpreted, not translated**: one helper per *run* of cog
  instructions (measured mean run 46.2), never one per instruction. Cog RAM is
  then never translated, so no invalidation machinery is needed at all.
- Hub RAM is ordinary code: **zero** invalidations measured over the whole run,
  and it is 93 % of all instructions.

### D3 — Prefixes, conditions and skips

- `EEEE` on every instruction → a TCG branch per instruction, as ARM32 does.
- `AUGS`/`AUGD`/`SETQ` → translate-time state in `DisasContext`, since the
  prefix and its consumer are adjacent in the instruction stream.
- `ALTx` → runtime, because the substitution value is a register.
- `SKIP`/`SKIPF`/`EXECF` → a runtime test per instruction inside a skip region.
- `REP` → a branchless hardware loop; ends the translation block.

`SKIP` and `REP` make block boundaries dynamic, which costs block chaining.

### D4 — The decoder stays single-source

`tools/gen_decoder.py` already generates `p2core/src/generated/decode.rs` from
the vendored PNut-TS table (`vendor/parseUtils.ts`, MIT). **Extend it to emit
QEMU's `insn.decode` DecodeTree file too.** The encoding table is then shared
between the reference interpreter and the TCG frontend, and the largest grind
in a new target — getting 359 encodings right — is already done and already
gated by `decoder_golden.rs`.

The *semantics* do not share: every op is written twice, once as Rust that
executes and once as C that emits code. That is permanent double maintenance,
and it is accepted deliberately — see [D5](#d5--p2core-becomes-the-oracle-not-dead-code).

### D5 — p2core becomes the oracle, not dead code

Do not delete p2core. Its value was never the dispatch loop; it is the
semantics burned in over months — `ADDS`/`SUBS` C is the true sign, `RDPIN WC`
means busy, `SETQ`'s L bit sits at 18, the FlexC quirks, the **1550 hardware
captures** and the 544→98 divergence burn-down. That corpus is what will
validate the TCG target, instruction by instruction.

So p2core is promoted from "the ISS" to "the reference model", and the
differential harness (Phase 2) is the main validation instrument.

This also means **the three local interpreter fixes are worth doing anyway**: a
2.5x faster oracle makes differential runs 2.5x cheaper, for about a week of work.

---

## Phase 0 — spikes, with accept/kill criteria

Nothing else starts until these three answer. Budget **2–3 weeks**. Each is a
throwaway; none needs a line of P2 semantics.

### 0a — Library spike: drive TCG from Rust in-process

Take an existing target (`riscv32` or `avr`), build QEMU as a shared library,
and from Rust: start a CPU, run N instructions by icount, stop exactly, read
state, and service a synchronous device callback that calls back into Rust.

- **Accept:** a pin-op-shaped callback costs **< 50 ns** round trip, and
  execution can be sliced at **≤ 1 µs** of virtual resolution from Rust.
- **Kill:** if slicing cannot be driven from outside QEMU's main loop without a
  thread hop per slice.

### 0b — Cog-exec self-modifying-code spike

A 2 KB region that is simultaneously the register file and the instruction
memory, running a FlexC-kernel-shaped loop that writes its own registers.
Measure the TB invalidation rate and the resulting throughput.

- **Accept:** ≥ 3x p2core's rate on the same loop.
- **Fallback:** hybrid — JIT hub-exec, interpret cog-exec — then re-measure.
- **Kill:** if the hybrid also fails to beat p2core on a FlexC-shaped workload.

#### Spike 0b — findings (2026-09-20): **PASSED via the hybrid; Option A is dead**

Full results: [`SIL/spikes/qemu-0b-smc/RESULTS.md`](../../SIL/spikes/qemu-0b-smc/RESULTS.md).

*What the real firmware does* (instrumented `p2core`, 200 M instructions):

| | |
|---|---|
| hubexec / cog-exec / LUT-exec | **93.02 % / 6.98 % / 0 %** |
| cog-RAM writes | **0.62 per instruction** |
| hub TB invalidations | **0** (8 754 hub longs translated, none ever re-translated) |
| cog TB re-translations | 1 per **227** instructions |
| cog-space entries | 302 141, **mean run 46.2 instructions** |

*What it costs in real QEMU* (riscv32 proxy, identical loops, only the store
target differs):

| store target | ns/inst | extra per store |
|---|---|---|
| page with no translated code | 5.97 | — |
| **same page as code, no TB covers it** | 44.78 | **+194 ns** |
| **exactly a translated TB** | 746.03 | **+3 700 ns** |

Invalidation is per-TB-byte-range (confirmed with `-d in_asm`: the victim block
re-translates once per write, the loop block in the same page does not), but the
*store trap* is per-page and **sticky** — `TLB_NOTDIRTY` only re-arms when the
page's TB list empties, and FlexC's kernel occupies cog RAM permanently. So a
write that invalidates nothing still pays `page_collection_lock` every time.

*Projection onto the real workload* (conservative base of 6 ns/inst):

| design | total | vs p2core (24 M) |
|---|---|---|
| **A** cog RAM as ordinary guest RAM | 143 ns/inst → 7 M inst/s | **0.3x — DEAD** |
| **D** cog RAM in `env`, cog-exec still JITted | 22 ns/inst → 45 M inst/s | 1.9x — misses the bar |
| **D + C** cog RAM in `env`, **cog-exec interpreted in runs** | **8.9 ns/inst → 113 M inst/s** | **4.7x — ACCEPT** |

**Three more design rules:**

3. **Cog RAM must never be softmmu guest RAM.** Hold the 8 × 512 longs in
   `CPUArchState`, reached by `tcg_gen_ld_i32`/`st_i32` at computed `env`
   offsets — an env *array*, not TCG globals (`target/avr/helper.c` notes a
   global may be live in a host register across a store).
4. **Interpret cog-exec; do not JIT it.** One helper per *run* of cog
   instructions (measured mean run: 46.2), never one per instruction —
   `-accel tcg,one-insn-per-tb=on` costs 14.14 ns/inst vs 1.14 ns/inst, so
   per-instruction blocks alone would miss the bar.
5. Hub RAM needs no special handling: zero invalidations measured.

**The open risk, and it is 0c's job.** Every projection uses a riscv32 proxy for
the per-instruction base. A real P2 instruction is dearer — an `EEEE` test on
every instruction, runtime-indexed register operands (forced by
`ALTD`/`ALTS`/`ALTI`), `SKIP` tests. At a 15 ns/inst base the hybrid lands at
58 M inst/s = 2.4x and **misses**. 0c must measure the base with the real slice
budget, not free-running.

### 0c — Interleaving spike (the real kill switch)

The P2's cogs run in lockstep; p2core interleaves every instruction. QEMU
interleaves at translation-block granularity. **The finer the interleaving, the
smaller the blocks, the less the JIT wins.** Measure throughput at the icount
quantum that pin-level SPI actually needs.

- **Accept:** ≥ 1.0x real time at the quantum the SD/flash SPI models require.
- **Kill:** if pin accuracy forces a quantum small enough that TCG never
  amortizes. **This is the criterion most likely to fail. If it fails, stop the
  project** — take the 2.54x interpreter work and revisit a Rust JIT instead.

#### Spike 0c — findings (2026-09-20): **kill criterion does not fire; ≥1.0x not demonstrated**

Full results: [`SIL/spikes/qemu-0c-interleaving/RESULTS.md`](../../SIL/spikes/qemu-0c-interleaving/RESULTS.md).

**The fear was misdirected.** Pin ops are helpers (rule 1), so an edge reaches
the peripheral model *inside the instruction*, not at a slice boundary. The
quantum only has to track cross-cog coupling — hub RAM, locks, `getct` deadlines.

*What quantum the firmware tolerates* (same 60 M instructions, frontier cog
stepped Q at a time, comparing console + per-pin bytes + drives + cog state):

| quantum | 8 | 16 | 24 | 32 | 48 | **64** |
|---|---|---|---|---|---|---|
| I/O | identical | identical¹ | identical | identical¹ | identical¹ | **DIVERGED** |

¹ differs only in one `getct`-derived timestamp inside a log line
(`10688` vs `10687 us`) — q=1 is not ground truth either, since real silicon
runs eight cogs in parallel. q=64 is unambiguous: brand-new `MONITOR`,
`CONTROL` and `COMMUNICATION` scheduling overruns the reference never reports.
**The firmware tolerates a quantum of 48.**

*What QEMU delivers* (8 harts, round-robin, `-icount shift=0,sleep=off`):

| quantum | 8 | 16 | 32 | **48** | 64 | 1024 |
|---|---|---|---|---|---|---|
| 8-vCPU ns/inst | 30.13 | 14.99 | 7.63 | **5.05** (misaligned) / 3.50 (aligned) | 4.04 | 0.93 |

**Eight vCPUs cost essentially nothing over one** (14.99 vs 14.18 ns/inst at
q=16) — the number of cogs is irrelevant, only the quantum matters. Budgets
that are a multiple of the guest's hot-loop length are ~40 % cheaper (they
avoid a budget-cut TB at an interior PC each round); a real P2 has many loop
lengths, so the misaligned figure is the one to plan with.

*A multiplier the plan was missing:* `p2core`'s 0.19x is achieved while
**eliding** idle-poll instructions via fast-forward, which TCG does not get.
Measured: 1.25x more instructions without it, so **1.0x real time needs
≈ 106 M inst/s = 9.43 ns/inst**, not the 126 M the plan assumed.

*The projection.* At q≈48 slice overhead is 4.12 ns/inst and cog-exec
interpretation (0b) is 3.29 ns/inst, leaving the hubexec JIT budget:

| hubexec JIT cost | total | real-time factor |
|---|---|---|
| 6 ns (0b conservative) | 12.99 ns/inst | **0.73x** |
| 2 ns (optimistic) | 9.27 ns/inst | **1.02x** |

**To reach 1.0x a JIT'd P2 instruction must cost ≤ ~2.2 ns (~7.6 host cycles)** —
covering the `EEEE` test, two runtime-indexed register loads (forced by
`ALTD`/`ALTS`/`ALTI`), the ALU op, the store and the clock update. Realistically
15–25 host instructions, so expect **0.5–0.8x**. The one big unmeasured lever is
slice-entry cost in a library build: 0a attributed all ~219 ns of it to Apple
W^X toggling, TLS, BQL/replay mutexes and QEMU's timer scan — none of it
translation. At ~60 ns entry the conservative row becomes 0.96x.

**Verdict: proceed.** ~~0.5–0.8x~~ — *superseded*: that projection divided a
budget=1 slice cost by the quantum, which overstates the operational cost ~2x.
[Spike 0a-2](../../SIL/spikes/qemu-0a2-entry-cost/RESULTS.md) measured slice
overhead at the operational point (**2.279 ns/inst stock, 1.216 after
legitimate ablations**), leaving **5.29 ns ≈ 18.5 host cycles** per JIT'd P2
instruction. That is enough for the `EEEE` test + two runtime-indexed register
loads + ALU + store + flags + clock add. **1.0x is reachable and the plan's
justification stands.**

**Residual risk that outranked everything else — now settled by
[Spike 0d](../../SIL/spikes/qemu-0d-pin-transport/RESULTS.md).** Measured: a
helper call that does **not** end the translation block costs ~0 ns, while a
forced TB exit costs **53.5 ns** — a >50x gap, and the measured justification
for design rules 1 and 2. The net *cannot* be resolved inside a helper
(`p2iss` requires a full engine pass per net-pin edge), so on the net each
drive costs a TB exit plus that pass — but the engine pass is identical for
`p2core`, so it cancels. Worst case, with **every** drive needing a host
round-trip, QEMU runs the real firmware at **0.10x the cost of `p2core`
(~10x faster)**; break-even is 1.41 instructions per edge and the worst
*conceivable* density (one edge per instruction) costs only 1.37x. **QEMU
cannot lose badly on this axis.** In-process SD (card behind `PinBus` rather
than on the net) removes the round-trip entirely.

**Phase 0 is COMPLETE and nothing kills the project:**

| spike | verdict |
|---|---|
| [0a](../../SIL/spikes/qemu-0a-unicorn/RESULTS.md) — drive TCG from Rust | PASSED — callback 19–27 ns, exact slices, no thread hop |
| [0b](../../SIL/spikes/qemu-0b-smc/RESULTS.md) — cog RAM = registers + code | PASSED via the hybrid; Option A dead by 20x |
| [0c](../../SIL/spikes/qemu-0c-interleaving/RESULTS.md) — interleaving | no kill; firmware tolerates a quantum of 48 |
| [0a-2](../../SIL/spikes/qemu-0a2-entry-cost/RESULTS.md) — slice entry cost | PASSED — 5.29 ns (~18.5 host cycles) per JIT'd instruction |
| [0d](../../SIL/spikes/qemu-0d-pin-transport/RESULTS.md) — pin transport / parity | PASSED — ~10x `p2core` worst case; 1.37x worst conceivable |

**Parity with the existing ISS is comfortably exceeded**, and 1.0x real time is
reachable. Phase 1 may start. The first `translate.c` is what converts the
5.29 ns budget from a projection into a measurement.

### Spike 0a — findings (2026-09-19)

Harness and full numbers: [`SIL/spikes/qemu-0a-unicorn/`](../../SIL/spikes/qemu-0a-unicorn/RESULTS.md).
Unicorn 2.1.5 (QEMU 5.0's TCG behind a synchronous API) stood in for "QEMU
as a library" so both acceptance numbers could be measured with no P2 code.
riscv32 guest, hand-encoded loop, M2, load average 7 (not a quiet box).

| | result | criterion |
|---|---|---|
| pure TCG, trivial loop | 1 421 M inst/s | — (≈ 60x `p2core`; the ceiling) |
| pin-op-shaped MMIO store → Rust closure | **18.7–26.5 ns** round trip | < 50 ns — **passes** |
| exact stop at `count = 80` | 153/153 slices exact | — |
| 80-instruction slice via `emu_start`, resume, repeat | **8.3 µs/slice**, 9.7 M inst/s | ≤ 1 µs — **fails, but see below** |
| Unicorn's per-instruction count hook armed | TCG drops 6x (1 421 → 235) | why icount, not hooks |

**The slice failure is Unicorn's, not TCG's.** `sample` on the slice loop
puts the fixed ~8 µs in `tcg_optimize` / `liveness_pass_1` /
`tcg_gen_code` / `sys_icache_invalidate`: it re-translates every call. The
source says why — a counted stop lands mid-block and goes through the
QEMU-5.0-era `cpu_exec_nocache`, which translates a one-shot budget-cut TB,
runs it, then `tb_phys_invalidate` + `tcg_tb_remove`. Upstream deleted that
path years ago; budget-cut TBs are cached under `CF_COUNT_MASK` cflags, and
the installed `qemu-system-riscv32` 11.1 with `-icount shift=0 -d in_asm`
shows exactly that — the cut block translated once, then silent.

**The "thread hop per slice" kill criterion does not bite.** Upstream's own
vCPU loop is the triple `icount_prepare_for_run(cpu, budget)` →
`tcg_cpu_exec(cpu)` → `icount_process_data(cpu)`
(`accel/tcg/tcg-accel-ops-rr.c`, `tcg-accel-ops-icount.c`, v10.1.0), callable
from any thread registered with RCU and TCG. The library entry point is that
triple plus an accel-ops whose `create_vcpu_thread` creates none. Unicorn is
the wrong foundation (retranslating slices, pinned to QEMU 5.0) and was the
right instrument.

**Upstream per-slice floor — measured** with a 40-line patch to
`rr_cpu_thread_fn` (`QEMU_SPIKE_SLICE`) on QEMU v10.1.0, same loop
(corrected 2026-09-20 for the `-icount ... ,sleep=off` pacing trap found in 0b):

| budget (insns/slice) | 1 | 8 | **80** | 800 | 8 000 | free-running |
|---|---|---|---|---|---|---|
| ns/slice | 219 | 214 | **243** | 778 | 5 678 | 0.69 ns/inst |

**Slice criterion: passes with 4x margin** (0.24 µs per 1 µs-of-cog slice),
stops exact on every row. The ~219 ns fixed part is all `cpu_exec` entry —
Apple-silicon JIT write-protect toggle, TLS, BQL/replay mutexes, TB hash
lookup, icount's timer scan, the interrupt check — none of it translation,
and most of it removable in a single-threaded library build.

**Two design rules the side-effect measurements force** (16550 store 199 ns,
PLIC store 259 ns, `csrw` 64 ns, Unicorn callback 19–27 ns):

1. **Pin ops are helpers, never `MemoryRegion`s.** `WRPIN`/`RDPIN`/`TESTP`/
   `AKPIN` and the `DIRA`/`OUTA` register writes call straight into Rust.
   MMIO under icount costs 199–259 ns per access — 3–4x the helper shape —
   which would make the SD bit-bang loop slower than `p2core`. This
   constrains D2/D3 and Phase 3.
2. **Never end a translation block at a pin op.** RISC-V pays ~64 ns per
   `csrw` almost entirely for the forced block exit. Keep `clocks` a TCG
   global so helpers read exact time without a boundary.

**Spike 0a: PASSED.** Two environment gotchas cost more time
than the measurement and are recorded in the spike's `RESULTS.md`: QEMU's
`configure` hangs forever in `docker version` on this Mac
(`--disable-containers`), and deleting `build/` under a live `ninja` looks
like a broken tree.

**Consequence for 0c:** budget-cut TBs mean the slice budget shapes the P2
target's block boundaries as much as `SKIP`/`REP` do. Measure 0c with the real
slice, never free-running.

---

## Phases 1–5

### Phase 1 — Skeleton target boots

`target/p2/`, mirroring `target/avr`'s shape (for scale: AVR is `translate.c`
85 KB, `cpu.c` 13 KB, `helper.c` 9 KB, `insn.decode` 7 KB, plus `cpu.h`,
`cpu-qom.h`, `cpu-param.h`, `helper.h`, `machine.c`, `gdbstub.c`, `disas.c`,
`meson.build`, `Kconfig` — and AVR has none of the P2's problems):

- QOM CPU class, reset, 8 cog contexts, hub RAM as a `MemoryRegion`
- `insn.decode` generated by `tools/gen_decoder.py` (D4)
- `translate.c` for ~30 instructions: `MOV`/`ADD`/`SUB`/`JMP`/`CALL`/`RET`,
  the `EEEE` field, hub-exec fetch, `AUGS`/`AUGD`
- `hw/p2/`: hub RAM + a stub pin bus that logs

**Milestone:** executes the boot ROM's first block and matches p2core's trace.

### Phase 2 — Instruction completeness against the oracle

Driven by coverage, not by the ISA manual: MaD firmware touches **88 of 359**
opcodes (see `p2-emulator-feasibility`), and `op_coverage.rs` already knows which.

- Differential harness: same image on p2core and QEMU-P2, compare all eight cog
  contexts every N instructions, first divergence wins. This is the core
  instrument and it is the thing to build first in this phase.
- Replay the `hwtest/` goldens (1.5 MB, captured from a real P2-EVAL) against
  the TCG target via `embsim-cpu-oracle`.
- Behaviours declared per the `writing-behaviours` skill; the Vibes ledger gates
  the new tests exactly as it gates p2core's.

**Milestone:** `hwtest/golden/oracle.txt` reproduces; `silicon_oracle`,
`silicon_probe` and `op_coverage` pass against QEMU-P2.

### Phase 3 — PinBus bridge and embsim integration

New crate `embsim-p2-qemu` exposing the **same component surface as `P2Iss`**
(`new(image, card, links)`, `with_level_pins`, `handle()`, `Component::attach`)
so `MaDSim` swaps backends behind one flag and every existing board model,
net, SD image and serial link keeps working untouched.

- embsim's virtual clock stays the authority; the engine asks for icount slices.
- `mad-emulator --iss-backend {p2core,qemu}`, defaulting to `p2core` until
  Phase 4 gates.

**Milestone:** `make playground-iss` boots the real firmware on QEMU-P2 and the
serial protocol round-trips at 2,000,000 baud.

### Phase 4 — The payoff

- Re-run `p2iss/examples/iss_speed.rs` unchanged. **Gate: ≥ 1.0x real time.**
- If met: flip the e2e default off `--computer`, run native Chrome with real
  wall-clock timeouts, delete `E2E_TIMEOUT_SCALE`, and rewrite
  `sil-two-valid-configurations` — the table collapses because ISS + bridge
  becomes meaningful.
- Keep `QemuNode` for runs that still want gated time (determinism work, CI
  under contention).

### Phase 5 — Maintenance posture

QEMU has no out-of-tree target mechanism, and the library patches are ours
regardless. Carry `target/p2` plus the library patches on a branch of a QEMU
fork, **pinned as a submodule** exactly as `embsim` and `ProtoEmb` already are,
and rebase on QEMU releases quarterly. Upstreaming the target is plausible
later and would not carry the library patches with it, so it is not a Phase 5
requirement.

CI builds the fork once and caches it; the gate is the differential harness
plus the `hwtest` goldens.

---

## Risks

| Risk | Mitigation |
|---|---|
| **Interleaving quantum kills the win** (Spike 0c) | Explicit kill criterion before any semantics are written |
| Library-mode QEMU is unsupported | Phase 0a proves it on a stock target first; patches pinned in a fork |
| Cog RAM SMC thrash | Hybrid fallback (Spike 0b), decided by measurement |
| Semantics written twice, forever | Accepted: p2core is the oracle and must not be retired |
| Encodings drift between the two | Single-source generator (D4), gated by `decoder_golden.rs` |
| QEMU API drift out of tree | Quarterly rebase; submodule pin, same discipline as embsim |

## Effort

Phase 0: **2–3 weeks.** Phases 1–3: **4–6 months** of focused work. Phase 4 is
short. That is the honest number, and Phase 0 exists so that most of it is
never spent if 0c says no.

## Insurance to run in parallel, starting now

The three measured interpreter fixes (2.54x, about a week) are **not wasted
work if QEMU lands**, because p2core stays as the oracle and a faster oracle
makes Phase 2's differential runs cheaper. Do them first regardless:

1. Drop the idle-poll bookkeeping from `step_one` (1.30x)
2. `cogs: Box<[Cog; 8]>` with `[cog & 7]` — kills 284 bounds checks (1.14x)
3. A cog quantum instead of switching every instruction (1.95x) — needs a yield
   check, since `step_until`'s own comment says bit-banged net devices depend on
   the per-pass interleaving

Rejected by measurement: a word-keyed decode memo cache (+2%).

---

## Relation to the embsim promotion

[`p2core-to-embsim.md`](p2core-to-embsim.md) still goes ahead. p2core belongs in
embsim either way — as the reference model rather than as the ISS. Only its
framing changes, and `embsim-p2-qemu` lands beside `embsim-p2-iss` under
`mcus/p2/`. Do not treat the two plans as alternatives.

---

## Measurements

All from 2026-09-19, quiet M2, `propeller2_debug/program`, best-of-N over 50M
instructions, in an isolated copy of `p2core`.

| Variant | M inst/s | vs base |
|---|---|---|
| base | 21.3 | 1.00x |
| drop idle-poll bookkeeping | 27.7 | 1.30x |
| `Box<[Cog; 8]>` + masked index | 24.4 | 1.14x |
| 64-instruction cog quantum | 41.5 | 1.95x |
| all three | 54.1 | 2.54x |
| word-keyed decode memo cache | 21.7 | 1.02x |

`sample` self-time: `step_one` (inlined into `step`) 73.2%, `decode` 11.0%,
`execute` 9.7%, `set_reg` 3.2%, `rd_long` 2.2%.

The quantum win is **locality, not the scheduler scan**: replacing
`frontier_cog()`'s 8-cog scan with an O(1) round-robin at quantum 1 bought only
4%. `Cog` is ~4.2 KB, so eight of them are eight distant cache lines. Quantum
512 is worse than 64.

**A caution that cost real time to find:** the first run of these benchmarks
reported 2.3 M inst/s and 0.019x real. Ten orphaned `emu-*` processes from an
abandoned session were eating 559% CPU on an 8-core machine. Killing them
changed nothing in the code and moved the ISS to 24 M inst/s / 0.19x. **Check
`uptime` before believing any SIL timing number**, and treat any "the ISS is
slow" bug report as unconfirmed until it is re-measured on a quiet box.
