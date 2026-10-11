#!/usr/bin/env python3
"""Hand-built probes for instruction-stream edges the random generator misses.

Each of these came from a real divergence. A randomised program reaches them
only by luck -- the REP one needs a conditional instruction in the LAST slot of
a block, the prefix ones need a prefix immediately before a taken branch -- so
they are written out by hand and kept.

usage: edgetest.py <name> <out.bin>     (prints the step budget)
"""
import struct
import sys


def ins(op, d, s, i=1, cond=0xF, c=0, z=0):
    return (cond << 28) | (op << 21) | (c << 20) | (z << 19) | (i << 18) \
        | (d << 9) | s


def misc(sel, d=0, l=0, cond=0xF, c=0, z=0):
    return (cond << 28) | (0x6B << 21) | (c << 20) | (z << 19) | (l << 18) \
        | (d << 9) | sel


def aug(d, imm23, cond=0xF):
    return (cond << 28) | ((0b11110 | d) << 23) | (imm23 & 0x7FFFFF)


def rel20(op, disp, cond=0xF):
    return (cond << 28) | (op << 21) | (1 << 20) | (disp & 0xFFFFF)


MOV, CMP, ADD, RDLONG, WRLONG, REP, JMP, SKIP_SEL, SETQ_SEL = \
    0x30, 0x10, 0x08, 0x58, 0x63, 0x66, 0x6C, 0x31, 0x28
IF_NZ = 0b0101      # bit (C<<1)|Z of EEEE selects: execute iff Z = 0


def rep_cancelled_tail():
    """A REP block whose LAST slot is condition-false.

    p2core reaches its tick only at the very end of a step, and the EEEE-false
    path returns before that -- so the block does NOT wrap on the cancelled
    slot. It runs the instruction AFTER the block and wraps from there: one
    extra instruction and two extra clocks per iteration.
    """
    return [
        ins(MOV, 0, 0),
        ins(CMP, 0, 0, i=1, c=0, z=1),          # Z := 1, so IF_NZ cancels
        ins(REP, 2, 3, i=1, c=1, z=1),          # rep #2,#3
        ins(ADD, 1, 1),                         # block[0]
        ins(ADD, 2, 1, cond=IF_NZ),             # block[1] -- cancelled
        ins(MOV, 3, 5),                         # after the block
    ]


def setq_across_branch():
    """A pending SETQ must not survive a taken branch.

    The branch leaves the translation block from inside its own body, so a
    clear emitted after the body is never reached -- and a leaked SETQ turns
    the following RDLONG into a block transfer. This is the firmware's own
    `SETQ / COGINIT` shape. Hub $40.. is seeded with distinct values, because
    an all-zero hub hides a block read behind a single one.
    """
    p = []
    for k in range(4):
        p.append(ins(MOV, 4, 0x50 + k))
        p.append(ins(WRLONG, 4, 0x40 + 4 * k, i=1, c=0, z=0))
    p += [
        ins(MOV, 0, 3),
        misc(SETQ_SEL, d=0),                    # setq r0 -> a block of 4
        rel20(JMP, 0),                          # jmp to the very next slot
        ins(RDLONG, 8, 0x40, i=1),
    ]
    return p


def augs_across_branch():
    """The same for AUGS: the MOV after the branch must not be widened."""
    return [
        aug(0, 0x123),
        rel20(JMP, 0),
        ins(MOV, 6, 0x55, i=1),
    ]


def nop_is_not_ret():
    """An all-zero word is NOP, and its EEEE field is NOT the _RET_ prefix.

    Reading the condition straight out of bits 31:28 makes word 0 a ROR under
    %0000, which returns through an empty stack -- so running off the end of a
    program lands somewhere arbitrary instead of idling through zeros. p2core
    decodes word 0 with cond 15 explicitly for exactly this reason.

    The program simply runs off its own end into unwritten hub.
    """
    return [ins(MOV, 9, 0x77)]


def chained_prefixes():
    """`augs / setq / rdlong` must LOSE the AUGS.

    p2core's clear_prefixes is asymmetric: Q survives any of the four prefix
    ops, but an AUG survives only its OWN kind. Treating a prefix instruction
    as simply adding to the pending set keeps the AUGS alive and widens the
    RDLONG's address by 23 bits.
    """
    p = []
    for k in range(4):
        p.append(ins(MOV, 4, 0x60 + k))
        p.append(ins(WRLONG, 4, 0x40 + 4 * k, i=1, c=0, z=0))
    p += [
        aug(0, 1),                              # AUGS: would make S $200|s
        ins(MOV, 0, 3),
        misc(SETQ_SEL, d=0),                    # ...and this must drop it
        ins(RDLONG, 8, 0x40, i=1),              # block read at $40, not $240
    ]
    return p


def cancelled_augs():
    """A SKIP-cancelled AUGS never took effect, so the MOV is not widened.

    p2core also keeps a cancelled slot's OWN prefix kind, and clears nothing at
    all when the cancelled word does not decode -- which is the whole point of
    SKIP over inline data.
    """
    return [
        ins(MOV, 7, 1),                         # pattern: cancel slot 0 only
        misc(SKIP_SEL, d=7),
        aug(0, 0x123),                          # cancelled
        ins(MOV, 6, 0x55, i=1),                 # must be $55, not $2467055
    ]


PROBES = {
    "rep-cancelled-tail": rep_cancelled_tail,
    "setq-across-branch": setq_across_branch,
    "augs-across-branch": augs_across_branch,
    "cancelled-augs": cancelled_augs,
    "chained-prefixes": chained_prefixes,
    "nop-is-not-ret": nop_is_not_ret,
}


def main():
    name, out = sys.argv[1], sys.argv[2]
    prog = PROBES[name]()
    if name != "nop-is-not-ret":
        prog.append(rel20(JMP, -4))             # park
    open(out, "wb").write(b"".join(struct.pack("<I", w) for w in prog))
    print(len(prog) + 24)                       # run past the end, into the park


if __name__ == "__main__":
    main()
