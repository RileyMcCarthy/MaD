# Spike 0c artefacts

See `RESULTS.md` for the numbers. Two halves, as in 0b.

## Half 1 — what quantum the firmware tolerates (no QEMU)

`p2core-instrumentation.patch` is **cumulative over 0b's** — it adds 0c's
pin-drive gap histogram and a `step_one_pub()` so a harness can impose its own
cog quantum without touching the scheduler. Apply to a *copy* of
`SIL/p2core/src/lib.rs`; drop `quantum.rs`, `qdiff.rs` into its `examples/`.

```bash
cargo run --release --example quantum -- <p2 image> 60000000   # tolerance sweep
cargo run --release --example qdiff   -- <p2 image> 60000000   # dump consoles to /tmp
```

`ffcost.rs` needs only unmodified `p2core`; it measures how many instructions
the idle-poll fast-forward elides (the multiplier a TCG target does *not* get).

## Half 2 — what QEMU delivers at that quantum

`spike-rr-smp.patch` **supersedes** `../qemu-0a-unicorn/upstream/spike-rr.patch`:
same `QEMU_SPIKE_SLICE` / `QEMU_SPIKE_N` entry point, but it now drives *every*
vCPU round-robin exactly as `rr_cpu_thread_fn` does, and reports per-round and
per-instruction cost. Apply to QEMU v10.1.0 and build as in 0a (remember
`--disable-containers`).

```bash
./smp.sh 8 48 8000     # 8 harts, 48-instruction quantum, 8000 rounds
```

Needs `loop-nop.bin` from `../qemu-0b-smc/mksmc.py`'s sibling generator (or any
bare-metal loop at 0x80000000). **`sleep=off` is mandatory** — see 0b.
