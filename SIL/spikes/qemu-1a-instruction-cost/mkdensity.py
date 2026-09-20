#!/usr/bin/env python3
"""Spike 1a: loops of N P2-shaped instructions, to find the marginal cost.

A single P2 op in a 3-instruction loop measures ~0, because the loop is
*latency*-bound on its own dependency chain (~1.6 IPC) and an 8-wide M2 hides
the extra work in spare issue width. Only at high density do the P2 ops compete
with each other and the true throughput cost appear. Take the slope 32->64.

Each image is: <op> x N, addi t0,t0,-1, j back.
  dens-p2N.bin   op = FENCE, hijacked by p2-alu-probe.patch into a P2 ALU insn
  dens-nopN.bin  op = NOP, the same loop shape for subtraction
"""
import struct
ADDI = 0xFFF28293
FENCE = 0x0FF0000F
NOP = 0x00000013


def jal(rd, off):
    i = off & 0x1FFFFF
    return ((((i >> 20) & 1) << 31) | (((i >> 1) & 0x3FF) << 21)
            | (((i >> 11) & 1) << 20) | (((i >> 12) & 0xFF) << 12) | (rd << 7) | 0x6F)


for n in (1, 2, 4, 8, 16, 32, 64):
    for tag, body in (("p2", FENCE), ("nop", NOP)):
        w = [body] * n + [ADDI]
        w.append(jal(0, -4 * len(w)))
        open(f"dens-{tag}{n}.bin", "wb").write(b"".join(struct.pack("<I", x) for x in w))
    print(f"n={n:3d}: {n} ops + addi + j = {n+2} guest instructions/iteration")
