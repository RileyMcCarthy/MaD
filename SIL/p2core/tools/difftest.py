#!/usr/bin/env python3
"""Randomised differential test: qemu-system-p2 vs p2core, instruction by instruction.

Emits a program that first seeds r0..r31 with MOV #imm, then runs N randomly
chosen instructions with random D/S/I/C/Z. Both engines execute it and print
the same P2STATE line per instruction; the first differing line localises a
semantic divergence to the exact instruction.

usage: difftest.py --ops mov,add,... [--n 400] [--seed 1] --out prog.bin
"""
import argparse
import random
import struct
import sys

# Real PNut-TS encodings -- taken from generated/insn.decode, never guessed.
# (Guessing these is exactly how the first skeleton test silently did nothing.)
OPS = {
    "add": 0x08, "sub": 0x0C, "and": 0x28, "or": 0x2A, "xor": 0x2B,
    "mov": 0x30, "not": 0x31,
    "sar": 0x06, "cmp": 0x10, "cmps": 0x12, "test": 0x3E, "testn": 0x3F,
    "neg": 0x33, "abs": 0x32,
    "shl": 0x03, "shr": 0x02, "rol": 0x01, "ror": 0x00,
    "addx": 0x09, "subx": 0x0D, "adds": 0x0A, "subs": 0x0E,
    "fge": 0x18, "fle": 0x19, "decod": 0x4E, "encod": 0x3C, "ones": 0x3D,
    "muxc": 0x2C, "muxnc": 0x2D, "muxz": 0x2E, "muxnz": 0x2F,
    "zerox": 0x3A, "signx": 0x3B,
    "sumc": 0x1C, "sumnc": 0x1D, "sumz": 0x1E, "sumnz": 0x1F,
    "getbyte": 0x47, "cmpr": 0x14, "incmod": 0x38, "decmod": 0x39,
    "negc": 0x34, "negnc": 0x35, "negz": 0x36, "negnz": 0x37, "cmpsub": 0x17,
    "rcl": 0x05, "rcr": 0x04, "bitl": 0x20, "bith": 0x21,
}


# For SOME opcodes the C/Z bits are VARIANT SELECTORS, not flag-write requests:
# op $4E is DECOD/BMASK/CRCBIT/CRCNIB chosen by (C,Z). Randomising C/Z there
# silently asks for a different instruction, so those ops pin them.
FIXED_CZ = {"decod": (0, 0)}


def ins(op, d, s, i=1, cond=0xF, c=0, z=0):
    return (cond << 28) | (op << 21) | (c << 20) | (z << 19) | (i << 18) | (d << 9) | s


# ---- control flow ---------------------------------------------------------
#
# Branches have to be generated, not sampled: a random target walks off the
# program and the two engines then diverge on garbage rather than on a bug.
# Every form below is emitted with a target computed from its own position, so
# the program provably stays inside itself. Backward branches only ever appear
# as a bounded countdown on a RESERVED register, so the program terminates.
MISC = 0x6B            # the misc block, EEEE 1101011 CZL DDDDDDDDD SSSSSSSSS
S_PUSH, S_POP, S_JMPD, S_CALLD_ = 0x2A, 0x2B, 0x2C, 0x2D
LOOP_REG = 31          # reserved: nothing else writes it, so loops terminate
LOAD_ADDR = 0x1000     # where difftest.sh and p2state.rs place the program


def misc(sel, d=0, l=0, cond=0xF, c=0, z=0):
    return (cond << 28) | (MISC << 21) | (c << 20) | (z << 19) | (l << 18) \
        | (d << 9) | sel


def rel20(op, disp, cond=0xF):
    """JMP/CALL #rel -- a signed BYTE displacement from the next PC."""
    return (cond << 28) | (op << 21) | (1 << 20) | (disp & 0xFFFFF)


def dj(op7, cz, d, off, cond=0xF):
    """DJNZ/DJZ/DJF/TJZ -- a signed 9-bit offset in INSTRUCTIONS."""
    return (cond << 28) | (op7 << 21) | ((cz >> 1) << 20) | ((cz & 1) << 19) \
        | (1 << 18) | (d << 9) | (off & 0x1FF)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ops", default=",".join(OPS))
    ap.add_argument("--n", type=int, default=400)
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--out", required=True)
    ap.add_argument("--cf", type=float, default=0.0,
                    help="fraction of body slots that become control flow")
    a = ap.parse_args()

    names = [o for o in a.ops.split(",") if o]
    unknown = [o for o in names if o not in OPS]
    if unknown:
        sys.exit("unknown ops (add their real encoding to OPS): %s" % unknown)

    rng = random.Random(a.seed)
    dmax = LOOP_REG if a.cf else 32   # the loop counter stays untouched

    def alu(cond=0xF):
        op = rng.choice(names)
        d = rng.randrange(dmax)
        i = rng.randrange(2)
        s = rng.randrange(512) if i else rng.randrange(32)
        cz = FIXED_CZ.get(op)
        c, z = cz if cz else (rng.randrange(2), rng.randrange(2))
        return ins(OPS[op], d, s, i=i, c=c, z=z, cond=cond)

    prog = []
    sub = 0
    if a.cf:
        # A subroutine for CALL to land in, placed first and jumped over. Its
        # last instruction is an `_ret_` prefix rather than a RET, so both
        # spellings of "return" are covered.
        body = [alu() for _ in range(3)] + [alu(cond=0)]
        prog.append(rel20(0x6C, 4 * (len(body) + 1)))   # jmp over it
        sub = len(prog)
        prog += body
    # Seed the register file. MOV's S is a 9-bit immediate, so 0..511 -- enough
    # to exercise carry/borrow and zero once the ALU ops start combining them.
    for r in range(32):
        prog.append(ins(OPS["mov"], r, rng.randrange(512)))

    kinds, n_cf = ["jmpf", "call", "loop", "tjz", "pushpop", "jmpd"], 0
    while len(prog) - sub < a.n:
        if a.cf and rng.random() < a.cf:
            k = rng.choice(kinds)
            n_cf += 1
            if k == "jmpf":                       # skip the next 1..3
                skip = rng.randrange(1, 4)
                prog.append(rel20(0x6C, 4 * skip))
                prog += [alu() for _ in range(skip)]
            elif k == "call":                     # into the subroutine
                prog.append(rel20(0x6D, 4 * (sub - len(prog) - 1)))
            elif k == "loop":                     # a bounded countdown
                inner = rng.randrange(1, 4)
                prog.append(ins(OPS["mov"], LOOP_REG, rng.randrange(2, 6)))
                prog += [alu() for _ in range(inner)]
                prog.append(dj(0x5B, 1, LOOP_REG, -(inner + 1)))
            elif k == "tjz":                      # forward, sometimes taken
                skip = rng.randrange(1, 4)
                prog.append(dj(0x5C, 2, rng.randrange(dmax), skip))
                prog += [alu() for _ in range(skip)]
            elif k == "pushpop":
                prog.append(misc(S_PUSH, d=rng.randrange(dmax)))
                prog.append(misc(S_POP, d=rng.randrange(dmax),
                                 z=rng.randrange(2)))
            else:                                 # JMP D, register-indirect
                # The target is an absolute HUB address, and MOV's immediate
                # is only 9 bits, so it is built as (addr >> 4) << 4 | low.
                # (Once AUGS lands this collapses to `mov r,##addr`.)
                r = rng.randrange(dmax)
                base = len(prog)
                prog += [0, 0, 0]                     # patched below
                prog.append(misc(S_JMPD, d=r))
                prog.append(alu())                    # jumped over
                addr = LOAD_ADDR + 4 * (base + 5)
                assert addr < 8192, "program outgrew the 9-bit MOV immediate"
                prog[base] = ins(OPS["mov"], r, addr >> 4)
                prog[base + 1] = ins(OPS["shl"], r, 4)
                prog[base + 2] = ins(OPS["add"], r, addr & 15)
        else:
            prog.append(alu())

    open(a.out, "wb").write(b"".join(struct.pack("<I", w) for w in prog))
    print("%d instructions (%d seed + %d body, %d control-flow sites) over %s"
          % (len(prog), 32, len(prog) - sub - 32, n_cf, ",".join(names)),
          file=sys.stderr)
    print(len(prog))


if __name__ == "__main__":
    main()
