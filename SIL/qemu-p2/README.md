# `target/p2` — the QEMU Propeller 2 target

**Destined for a QEMU fork, not for this repo.** Phase 5 of
[`docs/dev/p2-qemu-target-plan.md`](../../docs/dev/p2-qemu-target-plan.md)
carries `target/p2` on a branch of a QEMU fork pinned as a submodule, the same
discipline `embsim` and `ProtoEmb` already use. This directory is a snapshot so
the work is reviewable and not lost while that fork is set up.

## Layout

| path | goes to |
|---|---|
| `target-p2/` | `target/p2/` in the QEMU tree |
| `hw-p2/` | `hw/p2/` |
| `p2-softmmu.mak` | `configs/targets/p2-softmmu.mak` |
| `register-p2.patch` | the five registration edits (`target/meson.build`, `hw/meson.build`, both `Kconfig`s, `QEMU_ARCH_P2` in `include/system/arch_init.h`) |

`insn.decode` is **not** copied here — it is generated from p2core by
`tools/gen_decoder.py --decodetree` and lives at
`SIL/p2core/generated/insn.decode`. Copy it into `target/p2/` before building.
`target-p2/gen_stubs.py` then emits `trans_stub.c.inc` for every pattern not
yet hand-written.

```bash
cp ../p2core/generated/insn.decode  <qemu>/target/p2/
cd <qemu> && patch -p1 < .../register-p2.patch
./configure --target-list=p2-softmmu --disable-containers && make
```

## What it does today

Executes real P2 instructions on `-M p2` (512 KB hub RAM, eight cogs as eight
vCPUs). 14 instructions are implemented and **every one is validated against
p2core instruction-by-instruction** — see `../p2core/tools/difftest.sh`.

The Phase 0 design decisions are built in, not merely documented:

- **Cog RAM and LUT live in `CPUArchState`**, deliberately absent from the
  address space. Routing the register file through softmmu costs +194 ns per
  write (Spike 0b) and the firmware does 0.62 of them per instruction.
- **Hub-exec is translated, cog-exec is interpreted** in runs of 48 via
  `helper_p2_interp_cog` — hub RAM takes zero SMC invalidations over a whole
  firmware run and is 93 % of instructions; cog RAM is the register file.
- **Operands resolve at translate time** to constant env offsets. `ALTx` is a
  prefix the translator sees, and only the instruction after one needs runtime
  indexing: 0.0999 % of the stream.
- **Pin ops are helpers that never end a block** (Spike 0d: ~0 ns vs 53.5 ns).
- Anything unimplemented **halts the cog and logs the opcode and PC** rather
  than silently doing the wrong thing.

## What it does NOT do

No branches, calls or hardware stack. No hub load/store. No prefixes
(`AUGS`/`AUGD`/`SETQ`/`ALTx`). No `SKIP`/`REP`. No smart pins, CORDIC,
streamer or `COGINIT`. The pin helpers are inert stubs where embsim's `PinBus`
will attach. It boots nothing; the silicon goldens in `../p2core/hwtest/` are
the Phase 2 target and are a long way off.
