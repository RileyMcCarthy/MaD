# Spike 0a-2 — slice entry cost in a library build ("Option A")

Part of [`docs/dev/p2-qemu-target-plan.md`](../../../docs/dev/p2-qemu-target-plan.md),
Phase 0. Artefacts: [`README.md`](README.md).

**Verdict: 1.0x real time is reachable. This corrects Spike 0c, which was
pessimistic because of a measurement artifact of mine — not because of QEMU.**

> ⚠️ **CORRECTED 2026-09-20 — the BQL ablation below was UNSOUND.** Holding the
> BQL across `tcg_cpu_exec()` is illegal: `cpu_exec` takes a *bare* `bql_lock()`
> on its exception (`cpu-exec.c:739`) and interrupt (`:796`) paths, and
> `bql_lock_impl` asserts `g_assert(!bql_locked())` (`system/cpus.c:558`) — with
> `b_ndebug=false`, that assert is live. The ablation only survived because a
> nop loop never takes an interrupt or exception; on any real workload it would
> abort. **The sound figures are: slice overhead 1.979 ns/inst (not 1.216), and
> a budget of 4.47 ns (~15.7 host cycles) per JIT'd P2 instruction (not 5.29).**
> The BQL *saving* is not disproven — QEMU ships `stubs/iothread-lock.c`, a
> no-op BQL for single-threaded builds, which would make `bql_locked()` always
> false and the assert moot — but it is **not measured**, so it is not counted.
> Found by an adversarial source review after publication.

Measured 2026-09-20, M2, load 4–5, patched `qemu-system-riscv32` v10.1.0.

---

## The correction first

0c computed the per-slice entry cost `E` at **budget = 1** (219 ns) and divided
by the 48-instruction quantum, giving 4.56 ns/inst of slice overhead and a
budget of 1.70 ns (~6 host cycles) for a JIT'd P2 instruction — which I called
implausible, and concluded 0.5–0.8x.

**Budget = 1 is not the operational point and overstates it by ~2x.** At
budget 1 every instruction needs its own budget-cut TB and block chaining never
engages. Measured *directly* at the operational point (8 cogs, quantum 48), the
stock slice overhead is **~2.3–2.4 ns/inst**, not 4.56. The 0c projection should
be read as a lower bound that was measured wrong, and this document replaces it.

## What was measured

Everything below is at the operational point — 8 harts, `QEMU_SPIKE_SLICE=48`,
`-icount shift=0,sleep=off`, best of 5, one round = 8 × 48 = 384 instructions.
**Every run was gated on retiring its full `insns=` count before its timing was
believed.**

| | ns/round | ns/inst |
|---|---|---|
| stock | 1232.3 | **3.209** |
| `REPLAY`+`LIMIT`+`BQL` ablated | 969.5 | **2.525** |
| nop-loop base (quantum 1024, free-running) | — | 0.930 |

**Locks and timers, individually** (measured at budget = 1, where they are most
visible):

| ablation | E (ns) | saved | prediction |
|---|---|---|---|
| none | 211.7 | — | — |
| `replay_mutex` | 208.5 | 3.2 | ~0 — it short-circuits on `replay_mode == NONE`. Confirmed. |
| `icount_get_limit()` timer scan | 203.9 | 7.8 | — |
| ~~BQL around the slice~~ | ~~205.5~~ | ~~6.2~~ | **UNSOUND — see the correction above** |
| ~~**all three**~~ | ~~**190.3**~~ | ~~**21.4**~~ | analysts estimated 90–130 ns — **substantially over** |

**The Apple W^X toggle, by slope.** `pthread_jit_write_protect_np` has no state
tracking upstream, so every call is a real MSR write. Rather than delete it
(see the traps below), I *added* known toggle pairs and took the slope — a pair
restores the mode, so it cannot break correctness:

| extra pairs per `cpu_tb_exec` | 0 | 1 | 2 | 4 | 8 |
|---|---|---|---|---|---|
| ns/round (budget 1) | 210.5 | 273.4 | 333.9 | 456.9 | 702.2 |

Slope **61.5 ns per pair → ~30.7 ns per call**, dead linear. Run again at the
operational point, the same slope yields the *call count*: **4.74 `cpu_tb_exec`
calls per round**, so the stock W^X cost is 145.6 ns/round = **0.379 ns/inst**.

## The accounting

```
  measured stock                           +3.318 ns/inst
    - locks/timers (REPLAY+LIMIT only)     -0.409   <- BQL removed: unsound
    - nop-loop base (not slice overhead)   -0.930
  = slice overhead, soundly ablated         1.979   (stock 2.388)
```

The Apple W^X toggle (0.379 ns/inst, measured by slope) is *also* a real and
legitimately removable cost, but removing it needs per-thread memoization —
see the traps — so it is not folded into the figure above either.

1.0x real time needs ≤ 9.43 ns/inst total (0c), of which cog-exec
interpretation is a fixed 3.29 ns/inst (0b). So the budget for one JIT'd
hubexec P2 instruction is `X = (9.43 − slice − 3.29) / 0.93`:

| | slice overhead | X budget | in host cycles |
|---|---|---|---|
| stock QEMU | 2.388 | 4.03 ns | ~14.1 |
| **after SOUND ablations** | **1.979** | **4.47 ns** | **~15.7** |
| *(with an unsound BQL removal, for reference)* | *1.608* | *4.87 ns* | *~17.0* |

A P2 instruction needs roughly: the `EEEE` condition test, two runtime-indexed
register loads (`ALTD`/`ALTS`/`ALTI` force the indexing), the ALU op, the
result store, C/Z flag updates, and a clock add — **~15–25 host instructions**.
TCG output is not optimally scheduled, but at 2–4 IPC that is ~5–12 cycles,
comfortably inside 15.7. (Spike 1a has since measured it: **0.99 ns**.)

**So 1.0x is reachable, with headroom.** The premise the whole plan was
justified on survives.

## What is legitimate, and what is not

| item | removable in a libqemu? | why |
|---|---|---|
| `replay_mutex` | **yes** | already a no-op when record/replay is off; D1 gave record/replay up anyway |
| `icount_get_limit()` timer scan | **yes** | the Rust host owns the budget and passes it in; there are no QEMU timers |
| BQL per slice | **probably, but NOT by the method measured here** | holding it across `tcg_cpu_exec` trips `g_assert(!bql_locked())` on the interrupt/exception paths. QEMU does ship `stubs/iothread-lock.c`, a no-op BQL for single-threaded builds, which would make the assert moot — but that is unmeasured, so the saving is **not counted** |
| Apple W^X toggles | **yes, with care** | memoize the mode per thread and toggle only on transition (what Unicorn does). Must be **per-thread** — see traps |
| `--disable-qom-cast-debug` | yes, but **worthless** | measured 217 vs 223 ns: no effect, despite `object_dynamic_cast_assert` showing in the profile |
| RCU read guard in `cpu_exec` | **no** | its two `dmb ish` barriers are removable by asserting no concurrent reclaimer, but deleting the guard is cheating unless nothing ever calls `call_rcu` from another thread |
| asserts (`NDEBUG`) | **no** | QEMU `#error`s on `NDEBUG` (`include/qemu/osdep.h:288-302`). Not available. |

Untested and still on the table: `--disable-plugins` (the build carries
`plugins = True`, and `qemu_plugin_disable_mem_helpers()` sits immediately after
`tcg_qemu_tb_exec` in `cpu_tb_exec`).

## Traps hit, and what they cost

1. **Deleting the W^X toggle hangs QEMU, silently.** `qemu_thread_jit_execute()`
   is what makes the JIT pages *executable*; skip it and the thread jumps into
   write-mode (non-executable) memory. The process spins at 100 % CPU rather
   than crashing, so it reads as "slow", not "broken". First ablation attempt
   burned ~20 minutes this way.
2. **Memoizing it in a process-wide global hangs it too.** `pthread_jit_write_protect_np`
   is **per-thread** state; a shared memo goes stale across threads and skips a
   toggle that was actually needed. It must be `__thread` (which on macOS costs
   a `_tlv_get_addr` call — part of what you were trying to save).
3. **Hence the slope method.** Adding matched toggle *pairs* and measuring the
   slope gives ns/toggle without ever risking correctness, and the same slope at
   a second budget yields the call count for free. Prefer it to ablation
   wherever removal could change behaviour.
4. **`"$@"` inside a bash function is the function's args, not the script's.**
   `env "$@" ...` silently picked up `1 1 200000` and every run produced no
   output. Capture script-level args into an array at script scope.
5. **Gate every timing on correctness.** Two of the hangs above would have been
   reported as timings if the harness had not required the full `insns=` count
   first.

## Residual risks (unchanged from 0c, and they still dominate)

- **The SD bit-bang burst is unproven.** Still the single most important thing
  to settle in Phase 1, and unaffected by anything measured here.
- **`cpu_handle_interrupt` takes the BQL per translation block** whenever
  `interrupt_request != 0` (`cpu-exec.c:783`/`:852`) — which is the steady state
  for level-pending INT1–3 on the P2. That does not show in a nop-loop
  measurement at all and could be significant for the real target.
- The cog-exec interpretation term (3.29 ns/inst) is the largest fixed cost in
  the budget and comes from 0b's estimate of ~47 ns per interpreted instruction.
  An in-QEMU C interpreter should beat `p2core`'s Rust, which would widen the
  margin further.
- All figures use a riscv32 nop loop for the base. The real P2 base is `X` —
  the thing being budgeted — so it is not double-counted, but instruction mix
  will shift the slice/base ratio.
