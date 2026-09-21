#!/usr/bin/env python3
"""Spike 0d: four 3-instruction loops that isolate what a P2 pin op costs.

Each loop is <op> / addi t0,t0,-1 / j -8, so exactly one candidate pin-op
shape runs per iteration and everything else is identical.

  pin-nop     nop        baseline, no op
  pin-helper  fence      -> hijacked by pin-probe.patch to emit a TCG helper
                            call WITHOUT ending the translation block
  pin-tbend   fence.i    -> pure TB end, no helper (QEMU's own comment)
  pin-both    csrw       -> helper + forced TB end (do_csr_post exits)
"""
import struct
ADDI_T0_M1 = 0xFFF28293
J_M8       = 0xFF9FF06F
LOOPS = {
    "pin-nop.bin":    0x00000013,
    "pin-helper.bin": 0x0FF0000F,
    "pin-tbend.bin":  0x0000100F,
    "pin-both.bin":   (0x340 << 20) | (5 << 15) | (1 << 12) | 0x73,
}
for name, body in LOOPS.items():
    w = [body, ADDI_T0_M1, J_M8]
    open(name, "wb").write(b"".join(struct.pack("<I", x) for x in w))
    print(f"{name:16s} {[hex(x) for x in w]}")
