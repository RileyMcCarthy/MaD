# Spike 0c — cog interleaving: the kill switch

Part of [`docs/dev/p2-qemu-target-plan.md`](../../../docs/dev/p2-qemu-target-plan.md),
Phase 0. Artefacts and how to re-run: [`README.md`](README.md).

**Verdict: the kill criterion does NOT fire.**

> ⚠️ **The ≥1.0x projection below was SUPERSEDED on 2026-09-20 by
> [Spike 0a-2](../qemu-0a2-entry-cost/RESULTS.md).** It derived slice overhead
> from a budget=1 measurement (219 ns / 48), which overstates the operational
> cost by ~2x — at budget 1 every instruction needs its own budget-cut TB and
> block chaining never engages. Measured directly at the operational point,
> stock slice overhead is **2.279 ns/inst**, not 4.56, and after legitimate
> ablations **1.216**. The budget for a JIT'd P2 instruction is therefore
> **5.29 ns (~18.5 host cycles)**, not 1.70 ns, and **1.0x is reachable**.
> Everything else in this document — the quantum the firmware tolerates, the
> 8-vCPU result, the fast-forward multiplier — stands.

Measured 2026-09-20, M2, load 3.7–4.2, patched `qemu-system-riscv32` v10.1.0,
real MaD firmware (`propeller2_debug/program`) through an instrumented `p2core`.

---

## What 0c had to settle

The plan's fear: *"The P2's cogs run in lockstep; p2core interleaves every
instruction. QEMU interleaves at translation-block granularity. The finer the
interleaving, the smaller the blocks, the less the JIT wins."* Kill if pin
accuracy forces a quantum small enough that TCG never amortizes.

That fear turned out to be **misdirected**, for a reason worth stating: pin ops
are helpers (design rule 1, from 0a), so an edge reaches the peripheral model
*inside the instruction*, not at a slice boundary. The quantum therefore does
not have to track pin drives at all. What it must track is cross-cog coupling —
hub RAM, locks, and `getct`-derived deadlines.

## Half 1 — the quantum the firmware actually tolerates

`p2core` normally runs the least-advanced cog one instruction at a time. The
harness reruns the same 60 M instructions stepping the frontier cog `Q` at a
time and compares **everything that leaves the CPU**: console text, per-pin byte
counts, pin drives, guest time, final cog PCs.

| quantum | guest µs drift | console | pin bytes | verdict |
|---|---|---|---|---|
| 1 | — | ref | ref | reference |
| 8 | +0.003 % | same | same | identical I/O |
| 16 | +0.004 % | 1 byte | same | **benign** (see below) |
| 24 | +0.004 % | same | same | identical I/O |
| 32 | +0.005 % | 1 byte | same | **benign** |
| 48 | +0.006 % | 1 byte | same | **benign** |
| **64** | **−3.855 %** | 2503 B vs 1999 B | **pin9 962→828, pin62 3999→5007** | **DIVERGED** |

The "1 byte" rows are all the *same* difference, and it is not a behavioural
one:

```
< eduling overrun (10688/1000 us) LOGGER (+0 since last report)
> eduling overrun (10687/1000 us) LOGGER (+0 since last report)
```

A one-microsecond difference in a `getct`-derived timestamp inside a log line.
q=1 is not ground truth either — real silicon runs eight cogs genuinely in
parallel, so any interleaving is an approximation and a 1 µs timestamp wobble is
expected of all of them.

**q = 64 is the first real divergence**, and it is unambiguous — brand-new
scheduling overruns appear that q=1 never reports:

```
> Scheduling overrun (9047/1000 us) MONITOR
> Scheduling overrun (10991/1000 us) CONTROL
> Scheduling overrun (60051/10000 us) COMMUNICATION
```

The cog manager's deadline checks start failing because peers are frozen too
long. So: **the firmware tolerates a cog quantum up to 48 instructions.**

For context, pin drives are far sparser than feared over this window — 16 647
drives, **1 per 12 014 instructions** (4.7 M pin *reads*, 1 per 42: the drivers
poll far more than they drive). 13.7 % of drives do come in bursts of ≤3
instructions, which is the SD bit-bang shape, but bursts account for ~4 000 of
200 M instructions here. **Caveat: this window is boot-dominated and light on
SD traffic** — see the residual risk below.

## Half 2 — what QEMU delivers at that quantum

`spike-rr-smp.patch` drives every vCPU round-robin exactly as
`rr_cpu_thread_fn` does, with an explicit icount budget per CPU. Bare-metal
riscv32 loop on all harts, `-icount shift=0,sleep=off`.

| quantum | 1 vCPU ns/inst | **8 vCPU ns/inst** | 8 vCPU M inst/s | x real (106 M) |
|---|---|---|---|---|
| 8 | 27.84 | 30.13 | 33.2 | 0.31x |
| 16 | 14.18 | 14.99 | 66.7 | 0.63x |
| 32 | 6.96 | 7.63 | 131.0 | 1.24x |
| **48** | — | **3.50 / 5.05** | 286 / 198 | 2.70x / 1.87x |
| 64 | 3.86 | 4.04 | 247.7 | 2.34x |
| 1024 | 0.92 | 0.93 | 1 076 | 10.15x |

**Eight vCPUs cost essentially nothing over one** (14.99 vs 14.18 ns/inst at
q=16). Per-round cost scales with CPU count but so does work done, so the
*number of cogs is irrelevant* — only the quantum matters. That was not obvious
beforehand and it removes a whole class of worry about the 8-cog design.

**Two figures at q=48 because budget alignment matters.** A budget that is a
multiple of the guest's hot-loop length lands on a loop boundary; one that is
not forces an extra budget-cut TB at an interior PC every round:

| quantum | 30 | 31 | 32 | 33 | 45 | 47 | 48 | 49 | 51 |
|---|---|---|---|---|---|---|---|---|---|
| multiple of 3 | ✓ | | | ✓ | ✓ | | ✓ | | ✓ |
| ns/inst | 5.49 | 7.87 | 7.63 | 4.98 | 3.72 | 5.26 | 3.50 | 5.05 | 3.34 |

Aligned budgets are ~40 % cheaper, consistently. A real P2 has many hot loops of
different lengths, so **the misaligned figure (5.05 ns/inst at q≈48) is the
honest one to plan with.**

## A multiplier the plan was missing

`p2core`'s "0.19x real time" is achieved while **eliding** idle-poll
instructions via fast-forward. A TCG target has no such mechanism and must
execute every spin. Measured over 300 ms of guest time:

| | retired | instructions per second of *guest* time |
|---|---|---|
| fast-forward on (p2core default) | 25.4 M | 84.7 M |
| fast-forward off (what TCG must run) | 31.7 M | **105.6 M** |

Only a 1.25x multiplier — smaller than feared. **1.0x real time therefore needs
≈ 106 M inst/s**, i.e. **9.43 ns per instruction**, total.

## The projection, and the one number that decides it

At the top of the tolerated quantum (q≈48, misaligned), slice overhead is
5.05 − 0.93 = **4.12 ns/inst**. From 0b, cog-exec interpretation costs
0.07 × ~47 = **3.29 ns/inst**. That leaves the budget for JIT'd hubexec:

| hubexec JIT cost | total ns/inst | M inst/s | real-time factor |
|---|---|---|---|
| 6 ns (0b's conservative base) | 12.99 | 77 | **0.73x** |
| 4 ns | 11.13 | 90 | 0.85x |
| **2 ns** (optimistic) | **9.27** | **108** | **1.02x** |

**To reach 1.0x, a JIT'd P2 instruction must cost ≤ ~2.2 ns — about 7.6 host
cycles at 3.5 GHz.** That has to cover: the `EEEE` condition test, two
runtime-indexed register loads (forced by `ALTD`/`ALTS`/`ALTI`), the ALU op, the
result store, and the clock update. Realistically 15–25 host instructions. So
the honest expectation is **0.5–0.8x real time**, with 1.0x reachable only if
the slice-entry cost also comes down.

That last lever is real and unmeasured: 0a attributed the ~219 ns per
`cpu_exec` entry entirely to Apple-silicon JIT write-protect toggling, TLS
lookups, BQL/replay mutexes, QEMU's timer scan and the interrupt check — **none
of it translation**, and most of it absent from a single-threaded library build
with no QEMU timers. If slice entry fell to ~60 ns, overhead at q=48 drops from
4.12 to ~1.1 ns/inst and the conservative row becomes 0.96x.

## Verdict

- **Kill criterion: does not fire.** Pin accuracy does *not* force a small
  quantum — pin ops are helpers, and the firmware tolerates 48. At 48 the slice
  cost amortizes fine (4.12 ns/inst). The project is not stopped here.
- **Accept criterion (≥ 1.0x): not demonstrated.** 0.73–1.02x on measured
  proxies, most likely 0.5–0.8x once real P2 semantics are priced.
- **Phase 0 overall: proceed, with the target revised down.** Even the pessimistic
  end (0.5x) is ~2.6x today's 0.19x, which is a large win — but it is *not* the
  "cross 1.0x and delete the clock-gating apparatus" prize the plan was
  justified on. That justification should be revisited before committing 4–6
  months (see the plan's "Why, in one line").

## Residual risks, stated plainly

- **The SD bit-bang burst is not proven.** This window is boot-dominated; pin
  drives averaged 1 per 12 014 instructions. The known 0.002x pathology lives in
  SD phases where drives come every 1–3 instructions. If a pin helper can
  resolve the net synchronously and return, bursts are fine; if each drive needs
  a forced TB exit (~219 ns), SD phases collapse exactly as they do today. **This
  is the single most important thing to settle in Phase 1**, and it is a design
  question about the helper/net boundary, not about TCG.
- **The quantum result is one image, one 60 M-instruction window.** Re-run
  `quantum.rs` against an SD-heavy and a motion-heavy workload before relying on
  48.
- **`getct` semantics under a quantum.** A cog's clock jumps by Q×2 while peers
  are frozen; the cog manager's deadline arithmetic reads that. q=64 breaking is
  exactly this. A P2 target must keep per-cog clocks consistent with the same
  care `p2core`'s `system_clocks()` already documents.
- **Not measured:** slice-entry cost in a library build (the biggest single
  lever, above); alignment behaviour for a multi-loop workload; MTTCG is out of
  scope by D1 (nondeterministic).
