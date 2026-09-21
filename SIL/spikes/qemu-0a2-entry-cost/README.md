# Spike 0a-2 artefacts — slice entry cost

Follow-up to 0a and 0c ("Option A"): how much of QEMU's per-slice entry cost a
single-threaded in-process libqemu can legitimately drop. See `RESULTS.md`.

`spike-ablations.patch` is cumulative over 0c's `spike-rr-smp.patch` — same
`QEMU_SPIKE_SLICE` / `QEMU_SPIKE_N` entry point, plus four env-gated probes
(all default OFF, so an un-ablated build behaves exactly as stock):

| env | effect | legitimacy |
|---|---|---|
| `QEMU_ABL_REPLAY=1` | skip `replay_mutex_lock/unlock` in the icount triple | legitimate (record/replay is off) |
| `QEMU_ABL_LIMIT=1` | skip `icount_get_limit()`'s two timer-list scans | legitimate (the host owns the budget) |
| `QEMU_ABL_BQL=1` | hold the BQL across the run instead of per slice | legitimate (QEMU ships a no-op BQL stub for exactly this) |
| `QEMU_WX_EXTRA=k` | add k **extra** `pthread_jit_write_protect_np` PAIRS per `cpu_tb_exec` | a *measurement* probe, not an ablation |

Build as in 0a (`--disable-containers`), then:

```bash
./entry.sh <qemu-binary> "label" [ENV=VAL ...]
```

**Always gate on correctness.** Every run above was checked to retire the full
`insns=` count before its timing was believed — see the trap section in
`RESULTS.md` for why that matters.
