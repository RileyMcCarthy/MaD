#!/usr/bin/env python3
"""Spike 0b proxy loops: isolate the cost of a QEMU TB invalidation + re-translation.

Every variant runs the IDENTICAL instruction sequence and control flow:

    loop:  sw   t1, 0(t2)      # store 'ret' to the variant's target address
           jalr ra, 0(t3)      # call victim (a lone `ret`) -> re-executes it
           addi t0, t0, -1
           bne  t0, zero, loop

Only the STORE TARGET (t2) differs, so any timing difference is attributable
to what that address means to QEMU's self-modifying-code machinery:

  nocode  0x80002000  a different page, containing no translated code
  samepg  0x80000700  the SAME page as the code, but no TB covers it
  victim  0x80000400  exactly the translated `ret` -> invalidate + re-translate
                      every iteration (the value stored IS `ret`, so the code
                      stays valid; QEMU invalidates on range overlap, not content)

Load at 0x80000000 on 'virt' with -bios none -device loader,...,cpu-num=0.
"""
import struct

RET = 0x00008067  # jalr x0, 0(x1)
X0, RA, T0, T1, T2, T3 = 0, 1, 5, 6, 7, 28

VICTIM = 0x80000400  # executed (called every iteration)
TARGETS = {
    "smc-nocode": 0x80002000,
    "smc-samepg": 0x80000700,
    "smc-victim": VICTIM,
}


def lui(rd, imm20):
    return ((imm20 & 0xFFFFF) << 12) | (rd << 7) | 0x37


def addi(rd, rs1, imm):
    return ((imm & 0xFFF) << 20) | (rs1 << 15) | (0 << 12) | (rd << 7) | 0x13


def sw(rs2, rs1, imm):
    return (((imm >> 5) & 0x7F) << 25) | (rs2 << 20) | (rs1 << 15) | (2 << 12) \
        | ((imm & 0x1F) << 7) | 0x23


def jalr(rd, rs1, imm):
    return ((imm & 0xFFF) << 20) | (rs1 << 15) | (0 << 12) | (rd << 7) | 0x67


def jal(rd, off):
    i = off & 0x1FFFFF
    return (((i >> 20) & 1) << 31) | (((i >> 1) & 0x3FF) << 21) | (((i >> 11) & 1) << 20) \
        | (((i >> 12) & 0xFF) << 12) | (rd << 7) | 0x6F


def bne(rs1, rs2, off):
    i = off & 0x1FFF
    return (((i >> 12) & 1) << 31) | (((i >> 5) & 0x3F) << 25) | (rs2 << 20) | (rs1 << 15) \
        | (1 << 12) | (((i >> 1) & 0xF) << 8) | (((i >> 11) & 1) << 7) | 0x63


def li32(rd, value):
    """lui+addi pair for a full 32-bit constant (addi's imm is sign-extended)."""
    lo = value & 0xFFF
    hi = (value - (lo - 0x1000 if lo & 0x800 else lo)) >> 12
    return [lui(rd, hi), addi(rd, rd, lo - 0x1000 if lo & 0x800 else lo)]


def build(target, iters):
    code = []
    code += li32(T0, iters)        # loop counter
    code += li32(T1, RET)          # the value we store
    code += li32(T3, VICTIM)       # call target
    code += li32(T2, target)       # store target (the only thing that varies)
    loop = len(code) * 4
    code += [
        sw(T1, T2, 0),
        jalr(RA, T3, 0),
        addi(T0, T0, -1),
    ]
    code.append(jal(X0, loop - len(code) * 4))
    assert len(code) * 4 <= VICTIM - 0x80000000, "prologue collided with victim"
    image = bytearray(b"\0" * (VICTIM - 0x80000000 + 4))
    struct.pack_into("<%dI" % len(code), image, 0, *code)
    struct.pack_into("<I", image, VICTIM - 0x80000000, RET)
    return image, loop


if __name__ == "__main__":
    ITERS = 0x200000  # 2,097,152 iterations x 5 instructions
    for name, target in TARGETS.items():
        img, loop = build(target, ITERS)
        with open(f"{name}.bin", "wb") as f:
            f.write(img)
        print(f"{name}.bin  store->0x{target:08X}  loop@0x{0x80000000+loop:08X}  "
              f"{len(img)} bytes  {ITERS} iters x 5 insns = {ITERS*5} instructions")
