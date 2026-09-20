# Spike 0d — the pin-op transport, and parity with the non-QEMU ISS

Part of [`docs/dev/p2-qemu-target-plan.md`](../../../docs/dev/p2-qemu-target-plan.md).
Artefacts: [`README.md`](README.md).

**Verdict: the SD bit-bang risk does not bite. Even under the worst possible
assumption — every pin drive needing a host round-trip — a QEMU target runs the
real firmware at ~0.10x the cost of `p2core`, i.e. ~10x faster. Parity is
comfortably exceeded, and the design question is settled.**

Measured 2026-09-20, M2, load ~3.8, patched `qemu-system-riscv32` v10.1.0.

---

## The question 0c left open

0c found pin drives average 1 per 12 014 instructions, but **13.7 % come in
bursts of ≤3 instructions** — the SD bit-bang shape, and the place the existing
ISS collapses to 0.002x. The open question was whether a pin drive can be served
by a synchronous helper, or whether each one forces a translation-block exit.

## What the two designs cost

Four 3-instruction loops, identical but for the one candidate op per iteration,
free-running:

| pin-op design | ns/inst | **ns per op** |
|---|---|---|
| baseline (no op) | 0.714 | — |
| **helper call, no TB end** | 0.719 | **~0** |
| **forced TB exit, no helper** | 18.533 | **53.5** |
| helper + forced TB exit (`csrw`) | 20.266 | 58.7 |

A **>50x gap** between the two designs. This is the measured justification for
design rules 1 and 2 (0a): pin ops must be helpers, and the translator must
never end a block at one.

The near-zero helper figure was checked rather than believed. `-d op` shows
`call p2probe,$0x0,$0,env,x5/t0,x6/t1` and `-d out_asm` shows one branch-link in
the host code, so the call is genuinely emitted. It measures near-zero because
it is *independent* work the M2 overlaps with the loop's `addi` dependency
chain. On a real critical path expect 1–3 ns — which changes nothing below.

## Can the net be resolved inside a helper? No.

`p2iss` is explicit about what a net-pin drive requires
(`SIL/p2iss/src/lib.rs`, the `step_until` caller):

> the engine drains the drive, resolves, delivers the sense (a component drives
> its response), resolves again, then fires this wake — all before the guest
> reads back. This is what makes a bit-banged bus a first-class net
> participant; **the cost is one engine pass per net-pin edge**.

That is a return to the host scheduler: other components are engine actors and
the engine owns virtual time and event ordering. A CPU helper cannot re-enter
it. **So on the net, each drive costs a TB exit (53.5 ns) plus an engine pass.**

Two consequences:

1. **In-process SD is the cheap configuration.** With the card modelled behind
   `PinBus` rather than lifted onto the net (`P2Iss::new(&image, real_card,
   &links)`), a pin op is a plain helper and costs ~0. This is the same option
   the earlier cosim work identified as giving ~0.1x on SD phases.
2. **The engine pass is not a QEMU cost.** `p2core` pays it identically today.
   It cancels out of any comparison between the two backends.

## Parity with `p2core`, worst case

Assume the *pessimal* thing: every pin drive is a net edge needing the host
round-trip. Using 0c's measured gap histogram over the real firmware
(200 M instructions), `p2core` at 42 ns/inst and a JIT'd P2 instruction at
4 ns/inst (0a-2's budget is 4.47; Spike 1a later measured 0.99):

```
  break-even: 1.41 instructions per net edge — QEMU wins above that
```

| gap bucket | drives | instructions | p2core | QEMU | ratio |
|---|---|---|---|---|---|
| 1 | 1 576 | 1 576 | 66 µs | 91 µs | **1.37x** (the only loss) |
| 2–3 | 702 | 1 755 | 74 µs | 45 µs | 0.60x |
| 4–7 | 145 | 798 | 33 µs | 11 µs | 0.33x |
| 128–255 | 3 238 | 620 077 | 26.0 ms | 2.7 ms | 0.10x |
| 16384–32767 | 2 965 | 72 866 358 | 3 060 ms | 292 ms | 0.10x |
| **whole 200 M run** | 16 647 | 200 000 000 | **8 400 ms** | **801 ms** | **0.10x** |

Only the gap=1 bucket loses, by 1.37x, and it covers 1 576 of 200 000 000
instructions.

**And the loss is bounded even if a real SD phase is far denser than this
window:**

| sustained net edges | p2core | QEMU | ratio |
|---|---|---|---|
| 1 per 8 instructions | 42.0 ns | 10.7 ns | 0.25x |
| 1 per 4 | 42.0 ns | 17.4 ns | 0.41x |
| 1 per 2 | 42.0 ns | 30.8 ns | 0.73x |
| 1 per instruction (physically impossible — a bit-bang needs a loop) | 42.0 ns | 57.5 ns | **1.37x** |

**QEMU cannot lose badly on this axis.** The worst conceivable case is 1.37x,
and the realistic case is a 4–10x win. That is the parity question answered.

## Where this leaves the programme

| spike | verdict |
|---|---|
| 0a — drive TCG from Rust | PASSED (callback 19–27 ns, exact slices) |
| 0b — cog RAM = registers + code | PASSED via the hybrid (Option A dead by 20x) |
| 0c — interleaving | no kill; firmware tolerates quantum 48 |
| 0a-2 — slice entry cost | PASSED — 4.47 ns (~15.7 host cycles) per JIT'd instruction |
| **0d — pin transport / parity** | **PASSED — ~10x `p2core` worst case, 1.37x worst conceivable** |

Phase 0 is complete and nothing kills the project.

## Caveats

- The 4 ns/inst JIT figure is a projection, not a measurement — no P2 target
  exists yet. 0a-2 budgeted 4.47 ns to hit 1.0x, so 4 ns is inside it — and
  Spike 1a has since measured a real P2 instruction at **0.99 ns**, which widens
  the margin considerably and makes this table conservative.
- The gap histogram is from a boot-dominated window. The sustained-density table
  above exists precisely because a genuinely SD-heavy window was not captured;
  it bounds the answer for any density.
- The helper cost is a lower bound (independent work, overlapped). 1–3 ns on a
  critical path would shift the break-even from 1.41 to ~1.5 instructions per
  edge — immaterial.
- `--disable-plugins` remains untested (the build carries `plugins = True`).
