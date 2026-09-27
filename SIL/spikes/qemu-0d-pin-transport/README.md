# Spike 0d artefacts — what a pin op costs, and parity with p2core

Answers the residual risk 0c flagged: during SD bit-bang bursts, pin drives
come every 1–3 instructions. Does that collapse a QEMU target? See `RESULTS.md`.

`pin-probe.patch` applies to `target/riscv/` on top of 0c/0a-2's patches. It
adds `helper_p2probe` (a pin-op-shaped helper: env + two register operands)
and re-points plain `FENCE` at it **without ending the translation block** —
the shape design rules 1 and 2 propose for `WRPIN`/`RDPIN`/`TESTP`.

```bash
python3 mkpins.py
../qemu-0a2-entry-cost/entry.sh <qemu-binary> "label"   # or measure per-loop
```

Verify the helper is really emitted before believing a near-zero result:

```bash
qemu-system-riscv32 ... -device loader,file=pin-helper.bin,... -d op,out_asm
# expect "call p2probe" in the TCG ops and one branch-link in the host code
```
