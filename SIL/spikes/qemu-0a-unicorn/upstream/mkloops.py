#!/usr/bin/env python3
"""Bare-metal riscv32 loops for the upstream half of Spike 0a (no toolchain needed).

Load with: -M virt -bios none -device loader,file=<bin>,addr=0x80000000,cpu-num=0
"""
import struct

ADDI_T0_M1 = 0xFFF28293          # addi t0, t0, -1
J_M8       = 0xFF9FF06F          # j -8  (back to the loop body)
NOP        = 0x00000013

def lui(rd, imm20): return (imm20 << 12) | (rd << 7) | 0x37
def sw(rs2, rs1, imm):           # sw rs2, imm(rs1)
    return ((imm >> 5) << 25) | (rs2 << 20) | (rs1 << 15) | (2 << 12) | ((imm & 0x1F) << 7) | 0x23

T0, T1 = 5, 6
LOOPS = {
    "loop-nop.bin":  [NOP, ADDI_T0_M1, J_M8],
    "loop-mmio.bin": [lui(T1, 0x10000), sw(T0, T1, 0), ADDI_T0_M1, J_M8],   # virt 16550 THR
    "loop-plic.bin": [lui(T1, 0x0C000), sw(T0, T1, 4), ADDI_T0_M1, J_M8],   # PLIC source-1 priority
    "loop-csr.bin":  [(0x340 << 20) | (T0 << 15) | (1 << 12) | 0x73, ADDI_T0_M1, J_M8],  # csrw mscratch, t0
}
for name, words in LOOPS.items():
    with open(name, "wb") as f:
        f.write(b"".join(struct.pack("<I", w) for w in words))
    print(f"{name:14s} {[hex(w) for w in words]}")
