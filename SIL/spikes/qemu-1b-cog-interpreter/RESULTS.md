# Spike 1b — the cog-exec interpreter

Part of [`docs/dev/p2-qemu-target-plan.md`](../../../docs/dev/p2-qemu-target-plan.md).
Artefacts: [`README.md`](README.md).

**Verdict: the interpreter is not the bottleneck. A real P2 cog interpreter costs
0.82 ns/instruction measured, and even at `p2core`'s full-semantics rate the
end-to-end answer stays above 2.7x real time. The term that Spike 1a made the
dominant cost is, in fact, 2.6 % of it.**

Measured 2026-09-20, M2, patched `qemu-system-riscv32` v10.1.0.

---

## What 1a left open

1a measured every term but one and found the cog-exec interpreter was **61 %**
of the projected cost — carried as a **47 ns/instruction stand-in** borrowed
from `p2core`'s overall Rust rate (24 M inst/s). That stand-in was doing a lot
of work in the projection, so it needed measuring.

## What was measured

`helper_p2interp` is a real P2 cog interpreter in `target/riscv`: fetch from cog
RAM → decode fields → evaluate `EEEE` → read D and S (S may be immediate) →
dispatch → write D → update C/Z → advance the clock. One call interprets a *run*
of instructions, which is the hybrid shape 0b established (mean run 46.2). Cog
RAM is seeded with a pseudo-random mix of 42 real encodings.

| run length | ns per call | **ns per interpreted instruction** |
|---|---|---|
| 16 | 13.41 | 0.838 |
| **46** (the measured mean run) | 38.34 | **0.834** |
| 64 | 49.45 | 0.773 |
| 128 | 93.06 | 0.727 |

Cost scales linearly with run length, which is what proves the loop really
iterates rather than being skipped.

**Dispatch width is not the bottleneck.** Widening the switch from 6 opcodes to
**41**, and the seeded mix to 42, moved it only from 0.712 to 0.834 ns —
so I-cache pressure and branch prediction on the dispatch are not where the
time goes.

## Why this is so much faster than `p2core`, and how far to trust it

0.82 ns is ~2.9 host cycles per interpreted instruction, against `p2core`'s
42 ns. That gap is real but the probe is a **lower bound**, because it omits:

- hub access (`RDLONG`/`WRLONG` go through the hub map with masking)
- the `ALTx` / `AUGS` / `AUGD` / `SETQ` prefix state and its per-instruction checks
- `SKIP` / `SKIPF` / `REP` pattern tests
- pin ops, branches, calls and the hardware stack
- the other ~47 of the 88 opcodes MaD's firmware actually touches

And its locality is ideal: 512 instructions looping in L1 with a saturated
branch predictor, and hot state the compiler can keep in registers.

`p2core` with its three measured ablations (54.1 M inst/s = **18.5 ns/inst**) is
the natural **upper bound** — a full-semantics interpreter running one cog in a
quantum, which is exactly the hybrid's shape.

## End to end, across the whole plausible range

| cog-exec interpreter | ns/inst | M inst/s | real-time factor |
|---|---|---|---|
| **0.82 ns** — this probe (lower bound) | 2.19 | 456 | **4.30x** |
| 3 ns — a plausible real interpreter | 2.35 | 426 | 4.02x |
| 8 ns — pessimistic | 2.69 | 371 | 3.50x |
| **18.5 ns** — `p2core` full semantics (upper bound) | 3.43 | 292 | **2.75x** |
| *(47 ns — 1a's stand-in, for reference)* | *5.42* | *185* | *1.74x* |

**Across the entire range the answer stays above 2.7x real time.** The
conclusion no longer depends on which end of the bound you believe — which is
the point of bounding it.

Term breakdown at the measured 0.82 ns (ablated slice):

| term | ns | share |
|---|---|---|
| slice entry | 1.22 | 55 % |
| hubexec JIT | 0.92 | 42 % |
| **cog-exec interpretation** | **0.06** | **2.6 %** |

## The assumptions have now inverted twice

- The plan assumed the **JIT** would be the hard part. 1a measured it at 0.99 ns
  and made the **interpreter** look dominant at 61 %.
- 1b measures the interpreter and it collapses to 2.6 %. **Slice entry is now
  the largest single term at 55 %** — and 0a-2 already showed most of it is
  removable in a library build (Apple W^X toggling, TLS, BQL/replay mutexes,
  QEMU's timer scan), with the irreducible part being `cpu_exec` entry itself.

So the optimisation target, if one is ever needed, is **slice entry** — i.e.
how cheaply the Rust host can re-enter TCG. Everything else is already small.

## Caveats

- The probe is a lower bound, as set out above. The bounded range is the honest
  result; the single number is not.
- `p2core`'s 42 ns is not a fair like-for-like — it carries full ISA semantics,
  8-cog interleaving, idle-poll bookkeeping and `PinBus` trait dispatch. The
  18.5 ns ablated figure is the fair comparison and is used as the upper bound.
- Single host, riscv32 proxy. A narrower host or a CI runner will be slower
  across the board, but the *ratios* between terms should hold.
