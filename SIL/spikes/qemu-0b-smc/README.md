# Spike 0b artefacts

Reproduces the two halves of the measurement. See `RESULTS.md` for the numbers.

## Workload half — what the real firmware actually does

`p2core-instrumentation.patch` applies to a **copy** of `SIL/p2core/src/lib.rs`
(it is measurement scaffolding, not a change to ship). `characterize.rs` goes in
that copy's `examples/`. It counts, per cog-RAM / LUT / hub long: executions,
writes, and the modelled QEMU translation-block lifecycle
(translate → invalidate-on-write → re-translate), plus PC crossings between
cog and hub space.

```bash
cp -R SIL/p2core /tmp/p2char && cd /tmp/p2char
patch -p0 < .../p2core-instrumentation.patch      # paths are lib.rs-relative
cp .../characterize.rs examples/
cargo run --release --example characterize -- \
    ../../Firmware/MaDCore/.pio/build/propeller2_debug/program 200000000
```

## QEMU half — what an invalidation costs

Needs the patched `qemu-system-riscv32` from Spike 0a
(`../qemu-0a-unicorn/upstream/spike-rr.patch`, `QEMU_SPIKE_SLICE`).

```bash
python3 mksmc.py          # writes smc-{nocode,samepg,victim}.bin
./bench.sh smc-nocode.bin 20000000 2
```

`bench.sh` defaults to `-icount shift=0,sleep=off`. **`sleep=off` is not
optional** — see the pacing note in `RESULTS.md`.
