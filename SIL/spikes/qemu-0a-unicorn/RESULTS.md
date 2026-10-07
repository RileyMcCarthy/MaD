# Spike 0a — driving QEMU's TCG synchronously from Rust

Part of [`docs/dev/p2-qemu-target-plan.md`](../../../docs/dev/p2-qemu-target-plan.md),
Phase 0. Throwaway harness; `cargo run --release` reproduces everything here.
Unicorn 2.1.5 (a fork of QEMU 5.0's TCG with a synchronous API) stands in for
"QEMU as a library" so the two acceptance numbers can be measured before any
P2 semantics exist.

Measured 2026-09-19 on an M2 (8 cores), riscv32 guest, hand-encoded loop,
50.3 M instructions per run. Two runs are shown because the machine was not
quiet: the first had another session's `cargo test` at 390 % CPU and load
average 65; the second had two Python processes at ~100 % each and load 7.

| | loaded (LA 65) | quieter (LA 7) |
|---|---|---|
| **A** pure TCG, nop body | 935 M inst/s | **1 421 M inst/s** (0.70 ns/inst) |
| **B** + MMIO store → Rust callback every iteration | 101 M inst/s, **26.5 ns/callback** | 144 M inst/s, **18.7 ns/callback** |
| **C** nop body, Unicorn's per-instruction count hook armed | 177 M inst/s | 235 M inst/s |
| **D** slice of 80 instructions from Rust, resume, repeat | 12.0 µs/slice, 6.7 M inst/s | **8.3 µs/slice, 9.7 M inst/s** |
| **E** `count = 80` retires exactly 80 per slice | 153/153 exact | 153/153 exact |

## What each row settles

**B — the callback criterion passes.** A pin-op-shaped store (softmmu →
MemoryRegion dispatch → C trampoline → `Weak::upgrade` → Rust closure) is
**18.7–26.5 ns** round trip against the plan's < 50 ns bar, and that is with
the loop doing nothing else, so it is the worst case per pin op.

**C — per-instruction hooks are the thing to avoid.** Unicorn implements
`count` as a `UC_HOOK_CODE` helper on every instruction (`hook_count_cb`,
`uc.c`). Arming it alone cuts TCG by ~6x (1 421 → 235). Upstream's icount
budget is decremented per translation block in the TB prologue instead; this
row is the measured reason the P2 target must use icount, not hooks.

**E — exact stops are achievable.** Every slice retired exactly the requested
count. Upstream's icount gives the same guarantee at TB granularity plus a
budget-cut TB for the remainder.

**D — Unicorn's `emu_start` is unusable for sub-µs slicing, and it is
Unicorn's fault, not TCG's.** The per-slice cost is ~8 µs *fixed* (slice = 1
costs 5.8 µs), i.e. the 80-instruction slice embsim needs runs slower than
today's `p2core` interpreter. `sample` on the slice loop puts the time in
`tcg_optimize`, `liveness_pass_1`, `tcg_gen_code` and `sys_icache_invalidate`:
**it re-translates on every call.** Mechanism, from the source: a counted stop
lands mid-block, and the QEMU-5.0-era `cpu_exec_nocache`
(`qemu/accel/tcg/cpu-exec.c:118-142` in `unicorn-engine-sys`) translates a
one-shot budget-cut TB, executes it, then `tb_phys_invalidate` +
`tcg_tb_remove` — so nothing is cached across slices. Upstream deleted
`cpu_exec_nocache` years ago; budget-cut TBs are now cached under
`CF_COUNT_MASK` cflags (`cflags_next_tb`), so a warm loop resumes through the
jump cache. The per-slice floor there is `cpu_exec` entry — RCU read lock,
`cpu_exec_enter`, `sigsetjmp`, jump-cache lookup — which is the number the
upstream half of this spike measures (see below).

## What this means for the plan

- The "thread hop per slice" kill criterion does not bite: Unicorn *is* TCG
  driven from the caller's thread, and upstream's own vCPU loop is the triple
  `icount_prepare_for_run(cpu, budget)` → `tcg_cpu_exec(cpu)` →
  `icount_process_data(cpu)` (`accel/tcg/tcg-accel-ops-rr.c`,
  `tcg-accel-ops-icount.c`, v10.1.0), which any thread that has registered
  with RCU and TCG can call. A library entry point is that triple plus an
  accel-ops whose `create_vcpu_thread` does not create one.
- Unicorn itself is **not** the library to build on: its slicing primitive
  retranslates, and it is pinned to QEMU 5.0. It was the right instrument for
  this measurement and the wrong foundation for the target.
- Budget-cut TBs mean the P2 target's block boundaries will be shaped by the
  slice budget as well as by `SKIP`/`REP`; Spike 0c should measure with the
  real slice, not free-running.

## Upstream half

[`upstream/spike-rr.patch`](upstream/spike-rr.patch) adds a `QEMU_SPIKE_SLICE=<budget>` mode to
`rr_cpu_thread_fn` in QEMU v10.1.0 that runs the triple N times back to back
on a bare-metal riscv32 loop and prints ns per slice. Same M2, load 7–15.

**Slicing (nop loop, `insns/slice` verified exact for every row):**

| budget (insns/slice) | ns/slice | marginal ns/inst |
|---|---|---|
| 1 | 218.7 | — (this *is* the fixed cost) |
| 8 | 214.3 | ~0 |
| **80** (≈ 1 µs of one P2 cog) | **242.7** | 0.39 |
| 800 | 777.5 | 0.74 |
| 8 000 | 5 677.8 | 0.68 |
| 80 000 | 54 795.3 | 0.68 |
| free-running | 0.69 ns/inst = **1.45 G inst/s** | — |

> **Corrected 2026-09-20.** These were first published ~25 % higher because
> `-icount shift=0` defaults to `sleep=on`, which paces virtual time (1 ns per
> instruction at shift 0) against the wall clock. Every figure here is now
> measured with `-icount shift=0,sleep=off`. The verdict is unchanged and the
> margin improves. See Spike 0b's `RESULTS.md` for how this was caught.

**Verdict on the slice criterion: passes with 4x margin.** An
80-instruction slice costs 0.24 µs against the ≤ 1 µs bar, and the fixed part
is ~219 ns however small the budget. Unicorn's 8.3 µs was Unicorn's.

`sample` on the budget = 1 loop attributes the ~219 ns entirely to `cpu_exec`
entry, none of it translation: `pthread_jit_write_protect_np` (Apple-silicon
W^X toggle per entry, the largest single item), `cpu_exec_loop`,
`_tlv_get_addr` (TLS for `current_cpu`/RCU), `riscv_cpu_exec_interrupt`,
BQL + replay `pthread_mutex_lock/unlock`, `qht_lookup_custom` /
`tb_htable_lookup`, `qemu_clock_deadline_ns_all` (icount's timer scan),
`object_dynamic_cast_assert`, `get/set_bql_locked`. In a library build with
one thread, no QEMU timers and a trivial interrupt model, most of that goes;
219 ns is the ceiling, not the floor.

**What a per-instruction side effect costs — three shapes, same loop:**

| body of the loop | ns per op | what it measures |
|---|---|---|
| `sw` to the `virt` 16550 THR (`-serial none`) | **199** | MMIO dispatch + the serial model's no-chardev transmit-retry `timer_mod` |
| `sw` to a PLIC priority register (no timers) | **259** | MMIO dispatch under icount, plain device write |
| `csrw mscratch, t0` | **64** | instruction → TCG helper → C, **plus the block exit the RISC-V translator forces after every CSR write** |
| Unicorn MMIO → Rust closure (above) | 18.7–26.5 | device write → host callback, no icount |

(Also corrected for the pacing bug; each loop is 3 instructions per iteration,
so the per-op cost is 3 × ns/inst minus the 2.07 ns/iteration nop baseline.)

Two design rules fall straight out of this table, and they matter more than
the slice number:

1. **P2 pin ops must be helpers, never memory-mapped.** `WRPIN`/`RDPIN`/
   `TESTP`/`AKPIN` are instructions, so they translate to
   `gen_helper_*` calls that hop straight to Rust — the Unicorn-callback
   shape, tens of ns. `DIRA`/`OUTA` are cog registers and get the same
   treatment. Modelling any of them as a `MemoryRegion` costs 199–259 ns per
   access under icount — 3–4x the helper shape — i.e. the SD driver's bit-bang
   loop would run slower than `p2core`.
2. **The P2 translator must not end the block at a pin op.** RISC-V ends TBs
   after CSR writes because CSRs can change translation state; that alone is
   most of the 64 ns. `WRPIN` changes nothing the translator cares about.
   Keep `clocks` as a TCG global so helpers can read exact time without a
   block boundary.

Free-running, slicing adds nothing per instruction (0.68–0.69 ns/inst nop,
sliced or not); every cost above is per op, not per slice.

### Spike 0a — overall

| criterion (from the plan) | result |
|---|---|
| pin-op callback < 50 ns | **pass** — 18.7–26.5 ns (helper shape); MMIO shape fails and is banned by rule 1 |
| slice ≤ 1 µs of virtual resolution from Rust | **pass** — 307 ns per 80-insn slice on upstream icount, exact stops |
| kill: slicing needs a thread hop per slice | **does not bite** — the triple runs synchronously in the caller's thread |

Spike 0b is done and PASSED — see [`../qemu-0b-smc/RESULTS.md`](../qemu-0b-smc/RESULTS.md),
which adds design rules 3–5 and corrects the pacing bug found above.

### Reproducing the upstream build (what cost time)

- `git clone --depth 1 --branch v10.1.0 https://github.com/qemu/qemu.git`
  is enough; meson fetches the wrap-backed subprojects (softfloat, testfloat,
  keycodemapdb, dtc) itself during configure.
- The block is inserted after `cpu->exit_request = 1;` in
  `rr_cpu_thread_fn` by anchor (a hand-written unified diff with wrong hunk
  counts is rejected by `patch`); add `#include <time.h>` for
  `clock_gettime`. `icount_get_raw()` is exported from
  `include/exec/icount.h`.
- **`configure` hangs in `docker version` on this Mac.** Docker Desktop is
  running but its daemon socket never answers, so the container-engine probe
  sleeps forever with no CPU and no log output — it sat 17 minutes before
  `pgrep -P <configure pid>` showed the child. `--disable-containers` is the
  fix (`configure` line 782 sets `use_containers=no`); a `docker`/`podman`
  shim that `exit 1`s, first on `PATH`, is belt and braces.
- **Do not `rm -rf build` while `ninja` is alive.** A restart that raced a
  delete against a live compile produced a cascade of
  `fatal error: 'qapi-visit-common.h' file not found` — the generated QAPI
  headers were deleted under the compiler — and looked like a broken tree.
  Check `ps -A -o command | grep scratchpad/qemu/build` first.
- Configure flags used: `--target-list=riscv32-softmmu --disable-containers
  --disable-docs --disable-werror --disable-gtk --disable-sdl --disable-vnc
  --disable-cocoa --disable-slirp --disable-guest-agent --enable-debug-info`.
- Guest images are hand-encoded (`loop-nop.bin`: `nop / addi t0,t0,-1 / j -8`;
  `loop-mmio.bin`: `lui t1,0x10000` then `sw t0,0(t1)` to the `virt` 16550
  every iteration), loaded with
  `-M virt -m 8M -bios none -device loader,file=…,addr=0x80000000,cpu-num=0
  -icount shift=0 -nographic -monitor none -serial none -display none`.
  Both were checked on the installed `qemu-system-riscv32` 11.1 with
  `-d in_asm,int`: the loop spins, the UART store does not trap, and the
  budget-cut TB is translated once and then cached.
