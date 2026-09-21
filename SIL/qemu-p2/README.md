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

Three files are **generated and not copied here**:

- `insn.decode` comes from p2core, via `tools/gen_decoder.py --decodetree`, and
  lives at `SIL/p2core/generated/insn.decode`. The 359 encodings stay
  single-source: p2core's Rust decoder and this target are generated from the
  same PNut-TS table, so they cannot drift.
- `trans_stub.c.inc` and `interp_stub.c.inc` are emitted by
  `target-p2/gen_stubs.py`, one per dispatcher. Every DecodeTree pattern needs
  a function to link; anything not hand-written halts the cog and logs the
  opcode and PC rather than silently doing the wrong thing.

```bash
cp ../p2core/generated/insn.decode  <qemu>/target/p2/
cd <qemu> && patch -p1 < .../register-p2.patch

# The stub files are #included, so they have to exist before the build. One
# insn.decode, two dispatchers -- see "Two engines" below.
python3 scripts/decodetree.py --static-decode=decode_p2 --insnwidth=32 \
        -o /tmp/d.c.inc target/p2/insn.decode
python3 scripts/decodetree.py --static-decode=interp_p2 --translate=iexec \
        --insnwidth=32 -o /tmp/i.c.inc target/p2/insn.decode
python3 target/p2/gen_stubs.py /tmp/d.c.inc target/p2/trans_stub.c.inc
python3 target/p2/gen_stubs.py /tmp/i.c.inc target/p2/interp_stub.c.inc --interp

./configure --target-list=p2-softmmu --disable-containers && make
```

`--disable-containers` matters on macOS: `configure` otherwise hangs in
`docker version`.

## What it does today

Runs the real MaDCore firmware. `qemu-system-p2 -M p2 -kernel <image>` boots it
the way silicon does — the first `$1F8` longs of hub become cog 0's RAM and it
runs them from cog `$000`, because a P2 image is a cog program, not a hub one —
and **the first million instructions are identical to p2core's**, state by
state, registers, flags, stack pointer and cycle count
(`../p2core/tools/fwtest.sh`).

198 DecodeTree patterns are hand-written in each engine, covering every
mnemonic the firmware executes: 80 in hub space, 41 in cog space, measured over
20 M instructions with `../p2core/examples/ophist.rs`.

## Two engines, one instruction set

Hub-exec is translated (`translate.c`, TCG) and cog-exec is interpreted
(`interp.c`) — the hybrid Spike 0b measured at 4.7x against 0.3x for making cog
RAM ordinary guest memory. Three things stop the interpreter becoming a second
opinion about the ISA:

- the **decoder is shared**. `decodetree --translate=iexec` emits a second
  dispatcher over the same `insn.decode`, so `trans_*` and `iexec_*` cannot
  disagree about an encoding;
- everything with real machinery behind it — the pin bus, the lock pool,
  CORDIC, hub block transfers, the hardware stack, COGINIT, REP, SKIP — calls
  the **same helpers** from both;
- and the differential harness runs generated programs in **both** spaces, so
  the interpreter is diffed against p2core exactly as the translator is.

What is genuinely duplicated is the ALU core, and that is what the harness
covers most densely.

## The Phase 0 design decisions, built in

- **Cog RAM and LUT live in `CPUArchState`**, deliberately absent from the
  address space. Routing the register file through softmmu costs +194 ns per
  write (Spike 0b) and the firmware does 0.62 of them per instruction.
- **Hub-exec translated, cog-exec interpreted** in runs of 48 via
  `helper_p2_interp_cog`: hub RAM takes zero SMC invalidations over a whole
  firmware run and is 93 % of instructions; cog RAM is the register file and
  would re-translate 880 000 times.
- **Operands resolve at translate time** to constant env offsets. `ALTx` is a
  prefix the translator sees, and only the instruction after one needs runtime
  indexing: 0.0999 % of the stream.
- **Instruction-stream state travels in the TB key** — which prefixes are live,
  whether a REP or SKIP is running — so a block with none pending emits nothing
  for them at all.
- **Pin ops are helpers that never end a block** (Spike 0d: ~0 ns vs 53.5 ns).
- **The board arms a quantum timer under `-icount`.** Round-robin TCG only
  switches vCPUs when `cpu_exec` returns, and its budget comes from the next
  virtual deadline — with no timer armed, the first cog to spin starves every
  other one and COGINIT appears to work while the cog that called it never runs
  again.

## Test harnesses

All in `../p2core/tools/`, all diffing against p2core state by state:

| | |
|---|---|
| `difftest.sh` | randomised programs; `cog=1` runs the body in cog space |
| `edgetest.sh` | hand-built probes for stream edges a random program reaches only by luck |
| `cogtest.sh` | two cogs: COGINIT, compared on final register state, not timing |
| `fwtest.sh` | the real firmware |

## What it does NOT do yet

- **The peripherals are the bring-up model.** `pinbus.c` mirrors p2core's small
  `SmartPins`, not its `Board`: no SD card, no serial peer, no flash. That seam
  is where embsim's engine attaches, and it is the next thing — not the CPU.
- **No streamer** (`XINIT`/`XZERO`/`XCONT`/`SETXFRQ`), so the transition-mode
  smart-pin clock path halts rather than guessing.
- **The refused set matches p2core's**, deliberately: an instruction the oracle
  traps on cannot be differentially tested, so implementing it would ship
  untested code. `POLLCT1-3` are refused for a stronger reason — the CT
  deadline *is* modelled, so a poll that always reported not-set would
  contradict `WAITCT1`.
- **Interrupts, `SKIPF`/`EXECF`, and the hub FIFO** are not modelled.
- The silicon goldens in `../p2core/hwtest/` are still the Phase 2 target.
