# Spike 1a — what a P2 instruction actually costs in TCG

Part of [`docs/dev/p2-qemu-target-plan.md`](../../../docs/dev/p2-qemu-target-plan.md).
Artefacts: [`README.md`](README.md).

**Verdict: a JIT'd P2 instruction costs 0.99 ns (~3.5 host cycles) against a
5.29 ns budget — 5.3x margin. End to end that is 1.46–1.74x real time. The last
projection in the plan is now a measurement.**

Measured 2026-09-20, M2, patched `qemu-system-riscv32` v10.1.0.

---

## A premise in the plan was wrong

D2 says: *"`ALTD`/`ALTS`/`ALTI`/`ALTR` rewrite the next instruction's operand
addresses at runtime, so D and S cannot be resolved at translate time… every ALU
op is load/load/op/store through a runtime index. This is the main reason we
budget ~3x rather than ~6x."*

But **`ALTx` is a prefix**: it sets `alt_d`/`alt_s`, which the *following*
instruction consumes. The translator sees the `ALTx` in the instruction stream
and knows exactly which instruction needs dynamic indexing. Every other
instruction has static D/S from the encoding.

Measured over the real firmware (200 M instructions):

| | |
|---|---|
| `ALTx` prefixes executed | 199 750 = **0.0999 %** of instructions |
| instructions needing a computed register offset | **0.0999 %** |
| instructions with **static** D/S the translator resolves | **99.9001 %** |
| (`SETQ`/`AUGS`/`AUGD`, also translate-time visible) | 2.918 % |

So the expensive form is a rounding error, not the common case.

## What was measured

`FENCE` was hijacked to emit exactly the TCG a P2 ALU instruction needs —
`EEEE` condition test → read D → read S → ALU → write D → C/Z flags → clock
increment — against P2-shaped scratch state in `CPURISCVState`. Emission was
verified in `-d op` (`ld_i32 loc2,env,$0x1c` is `p2_cog[7]`, `$0x800` is
`p2_c`, six `setcond_i32`), and the generated host code is ~39 instructions
static / ~49 dynamic.

**The naive measurement says 0 ns, and it is wrong.** One P2 op in a
3-instruction loop costs 0.01 ns, because that loop is *latency*-bound on its
own dependency chain at ~1.6 IPC and an 8-wide M2 hides the extra work in spare
issue width. The cost only appears when the P2 ops compete with each other:

| ops per loop body | P2 ns/iter | nop ns/iter | marginal ns per op |
|---|---|---|---|
| 1 | 2.153 | 2.144 | 0.010 |
| 2 | 2.374 | 2.196 | 0.089 |
| 4 | 4.278 | 2.380 | 0.474 |
| 8 | 7.691 | 2.628 | 0.633 |
| 16 | 14.890 | 3.105 | 0.737 |
| 32 | 29.541 | 4.184 | 0.792 |
| 64 | 63.092 | 6.120 | 0.890 |

Taking the slope from 32 → 64, with the loop's own overhead subtracted:

| operand form | share of instructions | ns per instruction | host cycles |
|---|---|---|---|
| **static** (translator-resolved) | 99.9 % | **0.988** | ~3.5 |
| runtime-indexed (post-`ALTx`) | 0.0999 % | 2.258 | ~7.9 |
| **weighted** | | **0.989** | **~3.5** |

**Budget from [0a-2](../qemu-0a2-entry-cost/RESULTS.md): 5.29 ns. PASS with 5.3x
margin.**

## End to end

Every term is now measured except the cog-exec interpreter:

| configuration | ns/inst | M inst/s | real-time factor |
|---|---|---|---|
| stock QEMU | 6.48 | 154 | **1.46x** |
| after legitimate ablations (0a-2) | 5.42 | 185 | **1.74x** |

Term breakdown of the 5.42:

| term | ns | share |
|---|---|---|
| slice entry (0a-2) | 1.22 | 22 % |
| hubexec JIT — 93 % × 0.989 (**this spike**) | 0.92 | 17 % |
| **cog-exec interpretation — 7 % × 47 (0b)** | **3.28** | **61 %** |

**The interpreter is now the dominant cost, not the JIT or the slice.** That
inverts the plan's assumptions and redirects where optimisation effort should
go. The 47 ns/instruction figure is `p2core`'s Rust rate, used as a stand-in; an
in-QEMU C interpreter should beat it:

| cog interpreter | ns/inst | real-time factor |
|---|---|---|
| 47 ns (p2core's rate) | 5.42 | 1.74x |
| 30 ns | 4.23 | 2.23x |
| 20 ns | 3.53 | 2.67x |
| 12 ns | 2.97 | 3.17x |

For completeness: this does **not** revive JIT-ing cog-exec. With the measured
JIT cost, 0b's Option D is 1.22 + 0.99 + 16.3 (re-translation) = 18.5 ns/inst =
0.51x. The hybrid stands.

## Caveats

- The ALU shape is one representative instruction. `RDLONG`/`WRLONG` go through
  softmmu and will cost more; branches, `SKIP` regions and `REP` have their own
  shapes. A full `translate.c` is still what settles the mix — but the headroom
  is now 5.3x, not 1.0x, so the conclusion is robust to a wide error bar.
- `COG_INTERP = 47 ns` is the one unmeasured term and it dominates. Measuring a
  real cog-exec interpreter is the highest-value remaining work.
- The M2's width flatters low-density code. The slope method removes that, but a
  narrower host (or CI runner) will see a higher per-instruction cost.
- All figures are single-host, riscv32-proxy. They bound the design; they do not
  replace a real target.
