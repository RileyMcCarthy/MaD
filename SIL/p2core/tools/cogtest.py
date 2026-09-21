#!/usr/bin/env python3
"""Two-cog COGINIT test: the one thing the randomised harness cannot cover.

`difftest.py` diffs the engines instruction by instruction on cog 0's trace.
That stops working the moment a second cog runs: cog 0's view of hub RAM then
depends on the interleaving, and p2core (one instruction per step, least
advanced cog first) and QEMU (round-robin with a quantum) do not interleave the
same way. Matching them would mean matching schedulers, which is not what
COGINIT correctness means.

So this asks the question that IS well posed: cog 0 starts cog 1, cog 1 does
something observable, cog 0 waits for it and records what it saw. Both engines
must end in the same REGISTER state. Timing is deliberately not compared.

Cog 1 is started in HUB-exec (mode bit $20), so it runs translated code. The
cog-exec path is a different mechanism -- still the Spike 0b interpreter -- and
is not what this test is about.

usage: cogtest.py --out prog.bin
"""
import argparse
import struct

LOAD = 0x1000          # cog 0's code, where the loader puts the image
COG1 = 0x1800          # cog 1's code, inside the same loaded image
FLAG = 0x40            # the hub long cog 1 writes and cog 0 waits on
MAGIC = 0x1AB          # ...with this value (9 bits: one MOV immediate)


def ins(op, d, s, i=1, cond=0xF, c=0, z=0):
    return (cond << 28) | (op << 21) | (c << 20) | (z << 19) | (i << 18) \
        | (d << 9) | s


def misc(sel, d=0, l=0, cond=0xF, c=0, z=0):
    return (cond << 28) | (0x6B << 21) | (c << 20) | (z << 19) | (l << 18) \
        | (d << 9) | sel


MOV, SHL, ADD, WRLONG, RDLONG, COGINIT, TJZ = \
    0x30, 0x03, 0x08, 0x63, 0x58, 0x67, 0x5C


def rel20(op, disp, cond=0xF):
    return (cond << 28) | (op << 21) | (1 << 20) | (disp & 0xFFFFF)


def build():
    # ---- cog 0 -----------------------------------------------------------
    c0 = []
    # r1 = COG1, built from two 9-bit fields since MOV's immediate is small.
    c0.append(ins(MOV, 1, COG1 >> 9))
    c0.append(ins(SHL, 1, 9))
    c0.append(ins(ADD, 1, COG1 & 511))
    # COGINIT #%10_0001, r1 -- cog 1, hub-exec ($20), D literal so z = 1.
    c0.append(ins(COGINIT, 0x21, 1, i=0, c=0, z=1))
    # wait: r2 = [FLAG]; if r2 == 0 jump back one instruction
    c0.append(ins(RDLONG, 2, FLAG, i=1))
    # -2 instructions: back to the RDLONG, not to the TJZ itself. (-1 lands on
    # the TJZ and spins forever on a value it never re-reads.)
    c0.append(ins(TJZ, 2, 0x1FE, i=1, c=1, z=0))
    c0.append(ins(MOV, 3, 0xAB))                      # "I saw it" marker
    c0.append(ins(MOV, 4, 0))                         # r4 = PTRB of cog 0 (0)
    park0 = len(c0)
    c0.append(rel20(0x6C, -4))                        # jmp $ -- park here

    # ---- cog 1 (hub-exec at COG1) ----------------------------------------
    c1 = []
    c1.append(ins(MOV, 5, MAGIC))
    c1.append(ins(WRLONG, 5, FLAG, i=1, c=0, z=0))    # [FLAG] := MAGIC
    c1.append(rel20(0x6C, -4))                        # park

    img = bytearray((COG1 - LOAD) + 4 * len(c1))
    for k, w in enumerate(c0):
        img[4 * k:4 * k + 4] = struct.pack("<I", w)
    base = COG1 - LOAD
    for k, w in enumerate(c1):
        img[base + 4 * k:base + 4 * k + 4] = struct.pack("<I", w)
    return bytes(img), park0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    img, park = build()
    open(a.out, "wb").write(img)
    print(len(img) // 4)


if __name__ == "__main__":
    main()
