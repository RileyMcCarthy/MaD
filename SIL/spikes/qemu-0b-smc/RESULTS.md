# Spike 0b — cog RAM as register file *and* instruction memory

Part of [`docs/dev/p2-qemu-target-plan.md`](../../../docs/dev/p2-qemu-target-plan.md),
Phase 0. Artefacts and how to re-run: [`README.md`](README.md).

**Verdict: PASS — but only via the hybrid, and Option A is dead by 20x.**

Measured 2026-09-20, M2, load 3–4.5, patched `qemu-system-riscv32` v10.1.0
from Spike 0a, and the real MaD firmware (`propeller2_debug/program`,
200 M instructions) through an instrumented copy of `p2core`.

---

## Half 1 — what the real firmware actually does

This half needed no QEMU at all, and it reframed the problem.

| | measured over 200 M instructions |
|---|---|
| instructions fetched from **hub** (hubexec) | **93.02 %** |
| instructions fetched from **cog RAM** | **6.98 %** |
| instructions fetched from LUT | 0.00 % |
| cog-RAM writes | 123 297 139 = **0.62 per instruction** |
| cog-RAM writes landing on an address that is *also* executed | 938 381 = 0.76 % of writes |

Modelled QEMU translation-block lifecycle, at the finest possible granularity
(one long = one TB):

| region | translations | invalidations | re-translations |
|---|---|---|---|
| cog | 536 | 879 851 | **879 797** |
| LUT | 0 | 0 | 0 |
| **hub** | 8 754 | **0** | **0** |

Two facts do all the work:

1. **Hub RAM never self-modifies.** Zero invalidations across 8 754 translated
   hub longs covering 93 % of all instructions. The bulk of the firmware is an
   ordinary, well-behaved code region.
2. **Cog RAM re-translates once per 227 instructions.** Only 536 distinct cog
   longs are ever executed, but they are re-translated 880 K times — each hot
   cog long ~1 640 times over the run.

And the fact that decides the design:

| | |
|---|---|
| PC crossings between cog and hub space | 604 274 = 1 per 331 instructions |
| cog-space entries | 302 141, **mean run 46.2 instructions** |
| hub-space entries | 302 141, mean run 615.8 instructions |

A hybrid that interprets cog-exec pays **one helper entry per 46 interpreted
instructions**, not one per instruction. That is what makes it cheap.

## Half 2 — what an invalidation costs in real QEMU

Three riscv32 loops, identical instruction sequence and control flow
(`sw` / `jalr` to a victim / `ret` / `addi` / `jal`, 5 instructions per
iteration). **Only the store target differs**, so every difference is
attributable to what that address means to QEMU's SMC machinery.

| variant | store target | ns/inst | M inst/s | extra per store |
|---|---|---|---|---|
| `smc-nocode` | `0x80002000` — page with no translated code | 5.97 | 167.4 | — (baseline) |
| `smc-samepg` | `0x80000700` — **same page as code**, no TB covers it | 44.78 | 22.3 | **+194 ns** |
| `smc-victim` | `0x80000400` — exactly a translated TB | 746.03 | 1.3 | **+3 700 ns** |

Mechanism confirmed independently with `-d in_asm` (which prints only on
translation), 100 iterations each:

- `smc-nocode` and `smc-samepg`: the victim block is translated **once**. Zero
  re-translations.
- `smc-victim`: the victim block is translated **exactly 100 times** — one per
  write — while the loop block in the *same page* is translated twice, not 100
  times.

So **invalidation is per-TB-byte-range, not per-page**… but the *store* is
still trapped per-page, and that trap is sticky: `TLB_NOTDIRTY` only re-arms
when the page's TB list empties. That is the 194 ns: a write that invalidates
**nothing** still pays `notdirty_write` → `page_collection_lock` (two
`g_malloc`s, a GTree build and teardown, a lookup per TB on the page) on every
single store, forever, because FlexC's kernel permanently occupies cog RAM.

These two numbers were **predicted before being measured**. A parallel
source-reading pass over QEMU v10.1.0 forecast "150–600 ns/store, 50–300× the
clean case" and "1–10 µs/iteration" for the two cases; measurement landed at
194 ns and 3.7 µs. The prediction and the mechanism agree.

## Putting the halves together

Per-instruction cost for the real workload, using the measured rates above.
`base` is the JIT's cost for an ordinary instruction; the riscv32 proxy gives
5.97 ns/inst for branchy code with two indirect branches, so **6 ns is used as
a conservative base** (0.69 ns/inst straight-line is the optimistic end).

| design | register writes | re-translation | base | total | vs p2core (24 M) |
|---|---|---|---|---|---|
| **A** — cog RAM as ordinary guest RAM | 0.62 × 194 = **120.3 ns** | 16.3 ns | 6 ns | **143 ns/inst → 7.0 M inst/s** | **0.3x — DEAD** |
| **D** — cog RAM in `env`, cog-exec still JITted | ~0 | 16.3 ns | 6 ns | 22.3 ns/inst → 45 M inst/s | 1.9x — below the 3x bar |
| **D + C** — cog RAM in `env`, **cog-exec interpreted in runs** | ~0 | **0** | 6 ns | **8.9 ns/inst → 113 M inst/s** | **4.7x — ACCEPT** |

The hybrid row: 93.02 % at 6 ns + 6.98 % interpreted at ~47 ns (p2core's
~42 ns/inst plus a ~250 ns helper entry amortised over the measured 46.2-instruction
run) and **no re-translation at all**, because cog RAM is never translated.

Option A fails by 20x against the bar and is 3x slower than the interpreter it
would replace. It is not a tuning problem; it is the sticky per-page store trap
multiplied by 0.62 register writes per instruction.

## Design rules this adds (carry into 0c and Phases 1–3)

3. **Cog RAM must never be softmmu guest RAM.** Hold the 8 × 512 longs in
   `CPUArchState` and reach them with `tcg_gen_ld_i32`/`st_i32` at computed
   `env` offsets, so a register write never enters the store slow path. (It
   must be an env *array* with a computed offset, not TCG globals — AVR's
   `target/avr/helper.c` notes a global may be live in a host register across a
   store.)
4. **Interpret cog-exec; do not JIT it.** One helper that interprets a *run* of
   cog instructions until the PC leaves cog space — never one helper per
   instruction. Measured worst case for per-instruction blocks:
   `-accel tcg,one-insn-per-tb=on` costs **14.14 ns/inst (70.7 M inst/s)**
   against 1.14 ns/inst normally, i.e. one TB per instruction alone would miss
   the bar.
5. Hub RAM is an ordinary code region and needs no special handling — measured
   zero invalidations over the whole run.

## Caveats, stated plainly

- **The base cost is the open risk, and it is 0c's job.** Every projection above
  uses a riscv32 proxy for `base`. A real P2 instruction is dearer: an `EEEE`
  condition test on every instruction, register operands that must be
  runtime-indexed because `ALTD`/`ALTS`/`ALTI` can rewrite them, and `SKIP`
  tests. If the P2 base turns out to be ~15 ns/inst, the hybrid lands at
  58 M inst/s = 2.4x and **misses the bar**. 0c must measure the base with the
  real slice budget, not free-running.
- **The 3.7 µs re-translation is macOS-arm64-flavoured.** Codegen there pays
  `pthread_jit_write_protect_np` per TB (the top item in Spike 0a's profile).
  On Linux x86-64 it should be materially cheaper, which would move Option D
  alone closer to viable.
- **Workload-specific.** The 93/7 split, 0.62 writes/inst and 1-per-227
  re-translation rate come from this firmware image over its first 200 M
  instructions (boot plus steady state). A different image shifts them.
- **Not run:** the planned `V2-n` sweep (per-store cost vs number of live TBs on
  the page), which would separate the fixed `page_collection_lock` cost from the
  O(TBs-on-page) term. It only matters if Option A were viable, and it is not.
  Also not run: `precise_smc` behaviour (RISC-V, like a future P2 target, leaves
  it off, so a store into the executing TB runs stale — a correctness note for
  Phase 2, not a rate).

## A measurement trap that produced a wrong answer first

The first run of Half 2 reported all three variants at **exactly 1.000 ns/inst**.
Two independent bugs:

1. **`-icount shift=0` throttles to wall clock.** `sleep=on` is the default, so
   virtual time (1 ns per instruction at shift 0) is paced against real time and
   anything faster is slept down to exactly 1 ns/inst. **Always pass
   `sleep=off`** when measuring. This also means Spike 0a's free-running figure
   was pacing-clamped; its corrected numbers are in that spike's `RESULTS.md`.
2. `sed 's/.*ns\/slice=\([0-9.]*\).*/\1/'` matches greedily, and the harness
   line also contains `insns/slice=` — which *ends in* `ns/slice=`. The column
   labelled ns/slice was really insns/slice, making every ratio 1.000 by
   construction. `bench.sh` now parses with `awk` on `=`-split fields.
