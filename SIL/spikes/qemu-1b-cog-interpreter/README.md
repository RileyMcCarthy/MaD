# Spike 1b artefacts — the cog-exec interpreter

Spike 1a left one term unmeasured, and it was 61 % of the projected cost: the
cog-exec interpreter, carried as a 47 ns/instruction stand-in taken from
`p2core`'s Rust rate. This measures it. See `RESULTS.md`.

`p2-interp.patch` (on top of 1a's `p2-alu-probe.patch`) adds `helper_p2interp`
to `target/riscv` — a real P2 cog interpreter: fetch from cog RAM, decode the
fields, evaluate `EEEE`, read D and S (S may be an immediate), dispatch across
**41 opcodes**, write D, update C/Z, advance the clock. One helper call
interprets a *run* of instructions, which is the hybrid shape Spike 0b
established (measured mean run: 46.2).

Cog RAM is seeded with a pseudo-random mix of 42 real encodings so the dispatch
switch and its branch predictor see realistic variety.

```bash
# reuse dens-p21.bin from ../qemu-1a-instruction-cost/mkdensity.py
QEMU_P2_INTERP=46 qemu-system-riscv32 ... -device loader,file=dens-p21.bin,...
```

`QEMU_P2_INTERP=<n>` makes the hijacked `FENCE` call the interpreter for `n`
instructions instead of emitting 1a's inline ALU shape.

**Check linear scaling before believing any number** — ns per call must rise
proportionally with `n`. That is what proves the loop really iterates, and it
is the check that distinguishes a fast interpreter from a skipped one.
