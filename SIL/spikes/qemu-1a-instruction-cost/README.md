# Spike 1a artefacts — what a P2 instruction actually costs in TCG

Converts the last projection in the plan into a measurement. See `RESULTS.md`.

`p2-alu-probe.patch` (on top of 0c/0a-2/0d's patches) adds P2-shaped scratch
state to `CPURISCVState` (`p2_cog[512]`, `p2_c`, `p2_z`, `p2_clocks`) and makes
plain `FENCE` emit exactly the TCG a P2 ALU instruction needs:

    EEEE condition test -> read D -> read S -> ALU -> write D -> C/Z -> clock

`QEMU_P2_DYN=1` switches the operands to runtime-indexed (the post-`ALTx` case);
otherwise they are constant offsets, which the translator can resolve for
**99.9 %** of instructions (measured — see `RESULTS.md`).

```bash
python3 mkdensity.py
# then time dens-p2N.bin against dens-nopN.bin and take the slope 32 -> 64
```

**Two traps this spike hit — read before trusting a number:**

1. `EEEE = $E` selects bit `((C<<1)|Z)`, which is clear at reset, so the body
   was skipped forever and measured exactly nothing. Use `$F` (always).
2. At N=1 the answer is ~0 ns and it is **wrong** — the P2 work hides in the
   spare issue width of a loop that is latency-bound at ~1.6 IPC. Only the
   high-density slope is meaningful. Always verify emission with `-d op`
   (expect `ld_i32 ...,env,$0x1c` for `p2_cog[7]` and `setcond_i32`).
