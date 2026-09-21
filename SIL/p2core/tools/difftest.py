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
}


# For SOME opcodes the C/Z bits are VARIANT SELECTORS, not flag-write requests:
# op $4E is DECOD/BMASK/CRCBIT/CRCNIB chosen by (C,Z). Randomising C/Z there
# silently asks for a different instruction, so those ops pin them.
FIXED_CZ = {"decod": (0, 0)}


def ins(op, d, s, i=1, cond=0xF, c=0, z=0):
    return (cond << 28) | (op << 21) | (c << 20) | (z << 19) | (i << 18) | (d << 9) | s


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ops", default=",".join(OPS))
    ap.add_argument("--n", type=int, default=400)
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--out", required=True)
    a = ap.parse_args()

    names = [o for o in a.ops.split(",") if o]
    unknown = [o for o in names if o not in OPS]
    if unknown:
        sys.exit("unknown ops (add their real encoding to OPS): %s" % unknown)

    rng = random.Random(a.seed)
    prog = []
    # Seed the register file. MOV's S is a 9-bit immediate, so 0..511 -- enough
    # to exercise carry/borrow and zero once the ALU ops start combining them.
    for r in range(32):
        prog.append(ins(OPS["mov"], r, rng.randrange(512)))
    for _ in range(a.n):
        op = rng.choice(names)
        d = rng.randrange(32)
        i = rng.randrange(2)
        s = rng.randrange(512) if i else rng.randrange(32)
        cz = FIXED_CZ.get(op)
        c, z = cz if cz else (rng.randrange(2), rng.randrange(2))
        prog.append(ins(OPS[op], d, s, i=i, c=c, z=z))
    open(a.out, "wb").write(b"".join(struct.pack("<I", w) for w in prog))
    print("%d instructions (%d seed + %d random) over %s"
          % (len(prog), 32, a.n, ",".join(names)), file=sys.stderr)
    print(len(prog))


if __name__ == "__main__":
    main()
