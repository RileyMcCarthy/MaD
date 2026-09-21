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
    "fges": 0x1A, "fles": 0x1B, "subr": 0x16, "andn": 0x29,
    "bitnot": 0x27, "bitc": 0x22, "bitnc": 0x23, "bitz": 0x24, "bitnz": 0x25,
    "bitrnd": 0x26,
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
ADDR_REG = 30          # reserved: holds a hub address the ALU mix cannot ruin
REG_PTRA, REG_PTRB = 0x1F8, 0x1F9
# Hub ops target the low 512 bytes, which are zero and, crucially, nowhere near
# the program at $1000: a stray WRLONG into the instruction stream would be
# self-modifying code, which is a real feature to test but not this test.
SCRATCH = 256
LOAD_ADDR = 0x1000     # where difftest.sh and p2state.rs place the program


def misc(sel, d=0, l=0, cond=0xF, c=0, z=0):
    return (cond << 28) | (MISC << 21) | (c << 20) | (z << 19) | (l << 18) \
        | (d << 9) | sel


def rel20(op, disp, cond=0xF):
    """JMP/CALL #rel -- a signed BYTE displacement from the next PC."""
    return (cond << 28) | (op << 21) | (1 << 20) | (disp & 0xFFFFF)


# Hub ops. For the WR forms bit 20 selects the size and bit 19 is the L bit,
# so C/Z are selectors here and must never be randomised.
MEM_LD = {"rdbyte": 0x56, "rdword": 0x57, "rdlong": 0x58}
S_GETCT, S_REV, S_SETQ, S_SETQ2 = 0x1A, 0x69, 0x28, 0x29
S_WAITX, S_TESTP = 0x1F, 0x40
S_WRFLAG = {"wrc": 0x6C, "wrnc": 0x6D, "wrz": 0x6E, "wrnz": 0x6F}
# CORDIC, locks, cog identity and the CT1 deadline. Bit 19 is D's L bit in the
# Q block and bits 20:19 are the CT1/CT2/CT3 selector for ADDCT, so none of
# these C/Z values may be randomised.
OP_QMUL, OP_QSQRT, OP_QROTATE, OP_ADDCT = 0x68, 0x69, 0x6A, 0x53
S_GETQX, S_GETQY = 0x18, 0x19
S_LOCKNEW, S_LOCKRET, S_LOCKTRY, S_LOCKREL = 0x04, 0x05, 0x06, 0x07
S_COGID, S_COGSTOP, S_HUBSET = 0x01, 0x03, 0x00
S_SKIP, S_MODCZ, S_GETCT2 = 0x31, 0x6F, 0x1A
S_POLLSE = [0x04, 0x05, 0x06, 0x07]   # the @dsel block, selected by D
OP_REP = 0x66      # bit 20 selects REP; bit 19 is D's L bit, not WZ
S_WAITCT1 = 0x11   # the @dsel poll/wait block: D selects, S is $24
OP_MOVBYTS = 0x4F   # C and Z are SELECTORS here (both 1), not flag requests
# The pin instructions. WRPIN/WXPIN/WYPIN take the PIN from S and the VALUE
# from D -- the opposite way round from most two-operand instructions -- and
# bit 19 is D's L bit, not WZ.
OP_WRPIN, OP_WYPIN, OP_RDPIN = 0x60, 0x61, 0x54
# The DIR/OUT/FLT/DRV family, by misc sub-op. $40/$41 with C or Z set is not a
# DIRL/DIRH at all but a TESTP, so those two must be generated with C=Z=0.
PINOPS = {"dirl": 0x40, "dirh": 0x41, "outl": 0x48, "outh": 0x49,
          "fltl": 0x50, "flth": 0x51, "drvl": 0x58, "drvh": 0x59,
          "drvc": 0x5A, "drvnc": 0x5B, "drvz": 0x5C, "drvnz": 0x5D,
          "drvnot": 0x5F}
REG_DIRA, REG_INA = 0x1FA, 0x1FE
OP_ALTD, OP_ALTS = 0x4C, 0x4C   # bits [20:19] select: 01 = ALTD, 10 = ALTS


def aug(d, imm23, cond=0xF):
    """AUGS (d=0) / AUGD (d=1): the top 23 bits of a 32-bit literal."""
    return (cond << 28) | ((0b11110 | d) << 23) | (imm23 & 0x7FFFFF)
MEM_ST = {"wrbyte": (0x62, 0, 0), "wrword": (0x62, 1, 0), "wrlong": (0x63, 0, 0)}


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
    ap.add_argument("--mem", type=float, default=0.0,
                    help="fraction of body slots that become hub, prefix,"
                         " block-transfer or ALTx groups")
    ap.add_argument("--pins", type=float, default=0.0,
                    help="fraction of body slots that become smart-pin groups")
    a = ap.parse_args()

    names = [o for o in a.ops.split(",") if o]
    unknown = [o for o in names if o not in OPS]
    if unknown:
        sys.exit("unknown ops (add their real encoding to OPS): %s" % unknown)

    rng = random.Random(a.seed)
    # The reserved registers stay out of the random ALU mix so that loops
    # terminate and addresses stay inside the scratch window.
    dmax = 32
    if a.mem or a.pins:
        dmax = ADDR_REG
    elif a.cf:
        dmax = LOOP_REG

    def rcond():
        """A real EEEE condition. %1111 is unconditional and %0000 is _RET_,
        which pops the stack -- neither is what these tests want."""
        return rng.randrange(1, 15)

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
    # Seed the register file. MOV's S is a 9-bit immediate, so 0..511 -- which
    # on its own never reaches a sign boundary, and the operands that break a
    # 64-bit flag computation all live there. So half the registers are shifted
    # up afterwards, and two are pinned to $80000000 and $FFFFFFFF: SUMNZ's C
    # bug survived 14 seeds precisely because $80000000 never turned up as S.
    for r in range(32):
        prog.append(ins(OPS["mov"], r, rng.randrange(512)))
    for r in range(32):
        if rng.randrange(2):
            prog.append(ins(OPS["shl"], r, rng.randrange(32)))
    lo, hi = rng.sample(range(dmax if (a.mem or a.pins or a.cf) else 32), 2)
    prog.append(ins(OPS["mov"], lo, 1))
    prog.append(ins(OPS["shl"], lo, 31))          # $80000000
    prog.append(ins(OPS["neg"], hi, 1))           # $FFFFFFFF

    def hub_pair():
        """A store followed by a load of the same address: a write is only
        observable in the trace once something reads it back."""
        out = []
        addr = rng.randrange(SCRATCH)
        sname, (sop, sc, sl) = rng.choice(list(MEM_ST.items()))
        lname = rng.choice(list(MEM_LD))
        size = {"wrbyte": 1, "wrword": 2, "wrlong": 4}[sname]
        addr -= addr % size
        val = rng.randrange(dmax)
        if rng.randrange(3) == 0:            # PTRA/PTRB expression form
            ptr = rng.choice([REG_PTRA, REG_PTRB])
            out.append(ins(OPS["mov"], ptr, SCRATCH // 2))
            expr = 0x100 | (0x80 if ptr == REG_PTRB else 0) \
                | (rng.randrange(2) << 6) | (rng.randrange(2) << 5) \
                | rng.randrange(8)
            out.append(ins(sop, val, expr, i=1, c=sc, z=sl))
            out.append(ins(MEM_LD[lname], rng.randrange(dmax), expr, i=1,
                           c=rng.randrange(2), z=rng.randrange(2)))
        elif rng.randrange(2):               # immediate address
            out.append(ins(sop, val, addr, i=1, c=sc, z=sl))
            out.append(ins(MEM_LD[lname], rng.randrange(dmax), addr, i=1,
                           c=rng.randrange(2), z=rng.randrange(2)))
        else:                                # address through a register
            out.append(ins(OPS["mov"], ADDR_REG, addr))
            out.append(ins(sop, val, ADDR_REG, i=0, c=sc, z=sl))
            out.append(ins(MEM_LD[lname], rng.randrange(dmax), ADDR_REG, i=0,
                           c=rng.randrange(2), z=rng.randrange(2)))
        return out

    def prefix_group():
        """AUGS/AUGD widen the NEXT instruction's 9-bit literal to 32 bits."""
        out = []
        if rng.randrange(2):
            hi = rng.randrange(1 << 23)
            out.append(aug(0, hi))
            out.append(ins(OPS[rng.choice(["mov", "add", "xor"])],
                           rng.randrange(dmax), rng.randrange(512), i=1,
                           c=rng.randrange(2), z=rng.randrange(2)))
        else:
            # AUGD reaches the L-form stores: the VALUE is the widened D and
            # the address stays the ordinary 9-bit S.
            addr = 4 * rng.randrange(SCRATCH // 4)
            out.append(aug(1, rng.randrange(1 << 23)))
            out.append(ins(0x63, rng.randrange(512), addr, i=1, c=0, z=1))
            out.append(ins(MEM_LD["rdlong"], rng.randrange(dmax), addr, i=1,
                           c=rng.randrange(2), z=rng.randrange(2)))
        return out

    def block_group():
        """SETQ + RDLONG/WRLONG: a block transfer, not a single access.

        The destination span has to stay clear of the reserved registers, so
        the count and base are chosen together."""
        out = []
        n = rng.randrange(1, 6)
        base = rng.randrange(ADDR_REG - n)
        cnt = ADDR_REG - 1                    # scratch for the count itself
        addr = 4 * rng.randrange(SCRATCH // 8)
        out.append(ins(OPS["mov"], cnt, n))
        if rng.randrange(2):                  # block READ into the registers
            out.append(misc(S_SETQ, d=cnt))
            out.append(ins(0x58, base, addr, i=1))
        else:                                 # block WRITE, copy or fill
            if rng.randrange(2):
                out.append(misc(S_SETQ, d=cnt))
                out.append(ins(0x63, base, addr, i=1, c=0, z=0))   # copy
            else:
                out.append(misc(S_SETQ, d=cnt))
                out.append(ins(0x63, rng.randrange(512), addr, i=1, c=0, z=1))
            for k in range(min(n + 1, 3)):    # read it back to make it visible
                out.append(ins(0x58, rng.randrange(ADDR_REG), addr + 4 * k,
                               i=1))
        return out

    def tail_group():
        """CORDIC, the lock pool, COGID/COGSTOP/HUBSET and the CT1 deadline.

        The CORDIC result queue is not in the trace, so every Q op is followed
        by the GETQX/GETQY that makes it visible. Likewise a lock is only
        observable through a later LOCKTRY's C."""
        out = []
        k = rng.randrange(5)
        if k == 0:                              # QMUL / QDIV (+ a SETQ half)
            d, sreg = rng.randrange(dmax), rng.randrange(dmax)
            if rng.randrange(2):                # QDIV, sometimes 64-bit
                if rng.randrange(2):
                    out.append(misc(S_SETQ, d=rng.randrange(dmax)))
                out.append(ins(OP_QMUL, d, sreg, i=rng.randrange(2), c=1, z=0))
            else:
                out.append(ins(OP_QMUL, d, sreg, i=rng.randrange(2), c=0, z=0))
            out.append(misc(S_GETQX, d=rng.randrange(dmax), z=rng.randrange(2)))
            out.append(misc(S_GETQY, d=rng.randrange(dmax), z=rng.randrange(2)))
        elif k == 1:                            # QSQRT / QROTATE
            d = rng.randrange(dmax)
            if rng.randrange(2):
                out.append(ins(OP_QSQRT, d, rng.randrange(dmax), i=0, c=1, z=0))
            else:
                out.append(ins(OP_QROTATE, d, rng.randrange(dmax), i=0,
                               c=0, z=0))
            out.append(misc(S_GETQX, d=rng.randrange(dmax), z=rng.randrange(2)))
            out.append(misc(S_GETQY, d=rng.randrange(dmax), z=rng.randrange(2)))
        elif k == 2:                            # the lock pool
            lock = rng.randrange(16)
            sel = rng.choice([S_LOCKNEW, S_LOCKRET, S_LOCKTRY, S_LOCKREL])
            if sel == S_LOCKNEW:
                out.append(misc(sel, d=rng.randrange(dmax), c=rng.randrange(2)))
            else:
                out.append(misc(sel, d=lock, l=1, c=rng.randrange(2)))
            # ...and make the pool's state visible.
            out.append(misc(S_LOCKTRY, d=lock, l=1, c=1))
        elif k == 3:                            # COGID / COGSTOP / HUBSET
            r = rng.randrange(3)
            if r == 0:
                out.append(misc(S_COGID, d=rng.randrange(dmax),
                                c=rng.randrange(2)))
                # MODCZ rewrites both flags from a truth table in D; GETCT's
                # literal form still writes cog register #D; POLLSE reports
                # not-set on an event this model never raises.
                out.append(misc(S_MODCZ, d=rng.randrange(256), l=1,
                                c=rng.randrange(2), z=rng.randrange(2)))
                out.append(misc(S_GETCT2, d=rng.randrange(dmax), l=1,
                                c=rng.randrange(2), z=rng.randrange(2)))
                out.append((0xF << 28) | (MISC << 21)
                           | (rng.randrange(2) << 20) | (rng.randrange(2) << 19)
                           | (rng.choice(S_POLLSE) << 9) | 0x24)
            elif r == 1:
                # Never cog 0: stopping the cog under test ends the trace.
                out.append(misc(S_COGSTOP, d=1 + rng.randrange(7), l=1))
            else:
                out.append(misc(S_HUBSET, d=rng.randrange(512), l=1))
        else:                                   # ADDCT1/2/3 then WAITCT1
            cz = rng.randrange(3)               # 00/01/10 pick CT1/CT2/CT3
            out.append(ins(OP_ADDCT, rng.randrange(dmax), rng.randrange(64),
                           i=1, c=cz >> 1, z=cz & 1))
            out.append((0xF << 28) | (MISC << 21) | (S_WAITCT1 << 9) | 0x24)
        return out

    def rep_skip_group():
        """REP and SKIP -- runtime state that changes what the instruction
        stream MEANS. Both are generated over straight-line bodies so the
        program still provably terminates: REP's count is small and bounded,
        and SKIP's pattern only ever covers the slots emitted right after it
        (the remaining bits of the 32 are zero, so later instructions run)."""
        out = []
        if rng.randrange(2):
            n = rng.randrange(1, 4)
            out.append(ins(OP_REP, n, rng.randrange(2, 5), i=1, c=1, z=1))
            # Some slots conditional: a REP block whose LAST slot is cancelled
            # does not wrap there -- it runs the instruction after the block and
            # wraps from that one. Ticking the loop unconditionally missed it.
            out += [alu(cond=rcond() if rng.randrange(2) else 0xF)
                    for _ in range(n)]
        else:
            n = rng.randrange(2, 6)
            r = rng.randrange(dmax)
            out.append(ins(OPS["mov"], r, rng.randrange(1 << n)))
            out.append(misc(S_SKIP, d=r))
            out += [alu(cond=rcond() if rng.randrange(3) == 0 else 0xF)
                    for _ in range(n)]
        return out

    def prefix_edge_group():
        """The places a pending prefix is easy to lose or to keep too long."""
        out = []
        k = rng.randrange(3)
        addr = 4 * rng.randrange(SCRATCH // 8)
        if k == 0:
            # A prefix must not survive a BRANCH. The branch leaves the block
            # from inside its own body, so a clear emitted after the body would
            # never run -- and a leaked SETQ turns this RDLONG into a block
            # transfer.
            out.append(ins(OPS["mov"], rng.randrange(dmax), rng.randrange(8)))
            out.append(misc(S_SETQ, d=rng.randrange(dmax)))
            out.append(rel20(0x6C, 0))                 # jmp to the next slot
            out.append(ins(MEM_LD["rdlong"], rng.randrange(dmax - 4), addr,
                           i=1))
        elif k == 1:
            # ...and neither must an AUGS.
            out.append(aug(0, rng.randrange(1 << 23)))
            out.append(rel20(0x6C, 0))
            out.append(ins(OPS["mov"], rng.randrange(dmax), rng.randrange(512),
                           i=1))
        else:
            # A CANCELLED prefix never took effect, so the instruction after it
            # must not be widened. Pattern bit 0 = 1 cancels the AUGS.
            r = rng.randrange(dmax)
            out.append(ins(OPS["mov"], r, 1))
            out.append(misc(S_SKIP, d=r))
            out.append(aug(0, rng.randrange(1 << 23)))
            out.append(ins(OPS["mov"], rng.randrange(dmax), rng.randrange(512),
                           i=1))
        return out

    def altx_group():
        """ALTD/ALTS substitute a RUNTIME register index into the next
        instruction, and S[17:9] post-increments the index register."""
        out = []
        idx = rng.randrange(ADDR_REG - 2)
        sreg = idx + 1
        base = rng.randrange(24)
        off = rng.randrange(3)
        inc = rng.choice([0, 1, 0x1FF])       # 0, +1, -1 (9-bit signed)
        out.append(ins(OPS["mov"], idx, base))
        out.append(ins(OPS["mov"], sreg, inc))
        out.append(ins(OPS["shl"], sreg, 9))
        out.append(ins(OPS["or"], sreg, off))
        if rng.randrange(2):                  # ALTD: the next D is substituted
            out.append(ins(OP_ALTD, idx, sreg, i=0, c=0, z=1))
            # Sometimes conditional: an ALTx is consumed only by an instruction
            # that RETIRES, so a condition-false consumer passes it on to the
            # next one.
            out.append(ins(OPS["mov"], 0, rng.randrange(512),
                           cond=rcond() if rng.randrange(3) == 0 else 0xF))
        else:                                 # ALTS: the next S is substituted
            out.append(ins(OP_ALTS, idx, sreg, i=0, c=1, z=0))
            out.append(ins(OPS["add"], rng.randrange(ADDR_REG), 0, i=1,
                           cond=rcond() if rng.randrange(3) == 0 else 0xF))
        out.append(alu())
        return out

    def pin_group():
        """Smart pins. The bring-up bus on both sides is deterministic, so any
        sequence is diffable: WRPIN/WXPIN set per-pin state that TESTP reads
        back, RDPIN consumes the IN flag, and the drive ops land in
        DIRA/DIRB/OUTA/OUTB -- which the trace carries."""
        out = []
        pin = rng.randrange(64)
        k = rng.randrange(7)
        if k == 0:                       # WRPIN #cfg, #pin -- D is a literal
            out.append(ins(OP_WRPIN, rng.randrange(512), pin, i=1, c=0, z=1))
        elif k == 1:                     # WXPIN / WYPIN with D a register
            r = rng.randrange(dmax)
            op, c = rng.choice([(OP_WRPIN, 1), (OP_WYPIN, 0)])
            out.append(ins(OPS["mov"], r, rng.randrange(512)))
            out.append(ins(op, r, pin, i=1, c=c, z=0))
        elif k == 2:                     # RDPIN / RQPIN (bit 19 picks which)
            out.append(ins(OP_RDPIN, rng.randrange(dmax), pin, i=1,
                           c=rng.randrange(2), z=rng.randrange(2)))
        elif k == 3:                     # TESTP -- the pin comes from D
            cz = rng.choice([1, 2, 3])
            out.append(misc(S_TESTP, d=pin, l=1, c=cz >> 1, z=cz & 1))
        elif k == 4:                     # a pin drive
            sel = PINOPS[rng.choice(list(PINOPS))]
            cz = 0 if sel in (0x40, 0x41) else rng.randrange(4)
            out.append(misc(sel, d=pin, l=1, c=cz >> 1, z=cz & 1))
        elif k == 5:                     # read INA / INB as an operand
            out.append(ins(OPS["mov"], rng.randrange(dmax),
                           REG_INA + rng.randrange(2), i=0))
        else:                            # publish DIRx/OUTx, then burn clocks
            out.append(ins(OPS["mov"], REG_DIRA + rng.randrange(4),
                           rng.randrange(512)))
            out.append(misc(S_WAITX, d=rng.randrange(64), l=1))
        return out

    kinds, n_cf = ["jmpf", "call", "loop", "tjz", "pushpop", "jmpd"], 0
    n_mem = n_pin = 0
    while len(prog) - sub < a.n:
        if a.pins and rng.random() < a.pins:
            prog += pin_group()
            n_pin += 1
        elif a.mem and rng.random() < a.mem:
            r = rng.randrange(9)
            if r == 0:
                prog += prefix_group()
            elif r == 1:
                prog.append(misc(rng.choice([S_GETCT, S_REV]),
                                 d=rng.randrange(dmax),
                                 c=rng.randrange(2), z=rng.randrange(2)))
            elif r == 2:
                prog += block_group()
            elif r == 3:
                prog += altx_group()
            elif r == 4:
                prog += tail_group()
            elif r == 5:
                prog += rep_skip_group()
            elif r == 6:
                prog += prefix_edge_group()
            else:
                prog += hub_pair()
            n_mem += 1
        elif a.cf and rng.random() < a.cf:
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
                # is only 9 bits, so it is built as (addr >> 9) << 9 | low --
                # which covers any program this harness can generate.
                r = rng.randrange(dmax)
                base = len(prog)
                prog += [0, 0, 0]                     # patched below
                prog.append(misc(S_JMPD, d=r))
                prog.append(alu())                    # jumped over
                addr = LOAD_ADDR + 4 * (base + 5)
                assert addr < (1 << 18), "program outgrew a two-field literal"
                prog[base] = ins(OPS["mov"], r, addr >> 9)
                prog[base + 1] = ins(OPS["shl"], r, 9)
                prog[base + 2] = ins(OPS["or"], r, addr & 511)
        else:
            prog.append(alu())

    open(a.out, "wb").write(b"".join(struct.pack("<I", w) for w in prog))
    print("%d instructions (%d seed + %d body; %d control-flow, %d hub/prefix,"
          " %d smart-pin sites) over %s"
          % (len(prog), 32, len(prog) - sub - 32, n_cf, n_mem, n_pin,
             ",".join(names)), file=sys.stderr)
    print(len(prog))


if __name__ == "__main__":
    main()
