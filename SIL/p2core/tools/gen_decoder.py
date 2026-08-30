#!/usr/bin/env python3
"""Generate the P2 instruction decoder from PNut-TS's authoritative table.

Source of truth: `vendor/parseUtils.ts`, vendored from
https://github.com/ironsheep/PNut-TS (MIT, (c) Iron Sheep Productions, LLC and
Parallax Inc.). It carries the same 359-row table Chip Gracey's `p2com.asm`
does, so encodings track shipped silicon rather than a frozen doc snapshot.

Each row is
    asmcodeValues.set(eAsmcode.ac_<name>, setAsmcodeValue(v1, v2, eValueType.<form>))
where (parseUtils.ts:1019-1026, transcribed from Chip's x86 macro)
    packed = (v3 << 11) + (v2 << 9) + v1
so v1 is a 9-bit encoding fragment, v2 a 2-bit {WC,WZ} allowed-effects mask, and
v3 the operand form. This is an *assembler* table: where v1 lands in the 32-bit
word depends on the form, which is why decoding needs the six shapes below
rather than one mask.

Output is committed, matching the repo's generate-then-commit convention.
Verified by `tests/decoder_golden.rs` against flexcc's own listing for all
27,627 hub instructions in the real firmware image.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
CRATE = HERE.parent
VENDOR = CRATE / "vendor" / "parseUtils.ts"
OUT = CRATE / "src" / "generated" / "decode.rs"

# ---------------------------------------------------------------- shapes
# S1 REG        EEEE ooooooo CZI DDDDDDDDD SSSSSSSSS   key = instr[27:19]
S1 = {
    "operand_ds", "operand_bitx", "operand_testb", "operand_du", "operand_duii",
    "operand_duiz", "operand_ds3set", "operand_ds3get", "operand_ds2set",
    "operand_ds2get", "operand_ds1set", "operand_ds1get", "operand_dsj",
    "operand_ls", "operand_lsj", "operand_dsp", "operand_lsp", "operand_rep",
    "operand_calld", "operand_loc",
}
# S1 forms whose word is `EEEE ooooooo 0LI ...`: bit 19 is the L
# (D-is-a-literal) bit, not WZ, so the table must wildcard it.
# `operand_rep` belongs here too -- REP takes `D/#,S/#`, and without it REP
# shares opcode 102 with XCONT (which differs only in C) and the gap-fill below
# hands REP's L=1 encodings to XCONT.
L_FORMS = {"operand_ls", "operand_lsj", "operand_lsp", "operand_rep"}
# S2 BRANCH20   EEEE 11011oo RAAAAAAAAAAAAAAAAAAAA    key = instr[27:21]
S2 = {"operand_jmp", "operand_call"}
# S3 AUG        EEEE 1111x nnnnnnnnnnnnnnnnnnnnnnn    key = instr[27:23]
S3 = {"operand_aug"}
# S4 MISC-S     EEEE 1101011 CZL DDDDDDDDD SSSSSSSSS  key = (I << 9) | S
S4 = {"operand_l", "operand_d", "operand_de", "operand_pinop", "operand_testp",
      "operand_getbrk"}
# S5 EVENT-POLL EEEE 1101011 CZ0 0000ddddd 000100100  key = D, S fixed $24
S5 = {"operand_pollwait"}
# S6 EVENT-JMP  EEEE 1011110 00I DDDDDDDDD SSSSSSSSS  key = D
S6 = {"operand_jpoll"}

# 23 rows carry a PNut-internal index rather than an encoding. Only entries
# *derived from evidence* get a decoding; anything else stays absent so it
# traps rather than silently decoding as the wrong instruction.
#
# The misc-block sub-opcode ladder is anchored at four independently known
# points -- $2A PUSH, $2B POP and $30 JMPREL all carry real encodings in
# parseUtils.ts, and RET is verified in the image at program:$009A4 (FD64002D,
# I=1, S=$2D). That brackets $2C and $2D|I=0 as the register-indirect JMP and
# CALL, which every FlexC hubexec call thunk goes through.
VERIFIED_ALIASES = {
    ("s4", (1 << 9) | 0x2D): "ret",   # RET    = CALL D with I=1
    ("s4", 0x2C): "jmp",              # JMP  D   register-indirect
    ("s4", 0x2D): "call",             # CALL D   register-indirect
}

ROW_RE = re.compile(
    r"asmcodeValues\.set\(eAsmcode\.ac_(\w+),\s*"
    r"setAsmcodeValue\((0b[01]+|\w[\w.]*),\s*(0b[01]+),\s*"
    r"eValueType\.(\w+)\)\);"
)


def camel(name: str) -> str:
    return "".join(p.capitalize() for p in name.split("_"))


def parse_rows(src: str):
    rows = []
    for name, v1, v2, form in ROW_RE.findall(src):
        enc = int(v1, 2) if v1.startswith("0b") else None
        rows.append((name, enc, int(v2, 2), form))
    return rows


def build_tables(rows):
    s1, s2, s3, s4, s5, s6 = {}, {}, {}, {}, {}, {}
    testb_by_op, testp_by_s = {}, {}

    for name, v1, v2, form in rows:
        if v1 is None:
            continue
        if form in S1:
            op, czb = v1 >> 2, v1 & 3
            cs = [0, 1] if v2 & 2 else [(czb >> 1) & 1]
            zs = [0, 1] if (v2 & 1 or form in L_FORMS) else [czb & 1]
            for c in cs:
                for z in zs:
                    s1.setdefault((op << 2) | (c << 1) | z, (name, form))
            if form == "operand_testb":
                testb_by_op.setdefault(op, name)
        elif form in S2:
            s2.setdefault(v1 >> 2, (name, form))
        elif form in S3:
            s3.setdefault(v1 >> 4, (name, form))
        elif form in S4:
            if form == "operand_testp":
                # TESTP/TESTPN share their encoding with the pin-write ops
                # (DIRL/DIRH/...). The base table must hold the pin-write form;
                # `decode` promotes it to TESTP when C or Z is set. Letting file
                # order decide via setdefault made TESTP claim $40/$41 and
                # mis-decode every DIRL/DIRH in the image.
                testp_by_s.setdefault(v1, name)
                continue
            if form == "operand_pinop":
                s4[v1] = (name, form)
                s4[(1 << 9) | v1] = (name, form)
            else:
                s4.setdefault(v1, (name, form))
        elif form in S5:
            s5.setdefault(v1, (name, form))
        elif form in S6:
            s6.setdefault(v1, (name, form))

    # Fill any C/Z combination the exact-match pass left empty with that
    # opcode's row. For GETBYTE and friends, REP and the BITx/TESTB pair those
    # bits select an operand *variant* rather than requesting a flag write, so
    # the exact pass leaves real encodings undecoded. Exact entries went in
    # first and are never overwritten, so genuine per-flag rows keep priority.
    for key in sorted(s1):
        op = key >> 2
        for cz in range(4):
            s1.setdefault((op << 2) | cz, s1[key])

    for (kind, key), mnemonic in VERIFIED_ALIASES.items():
        if kind == "s4":
            s4[key] = (mnemonic, "operand_alias")

    return s1, s2, s3, s4, s5, s6, testb_by_op, testp_by_s


def emit_table(name: str, size: int, table: dict) -> str:
    cells = []
    for i in range(size):
        hit = table.get(i)
        cells.append("N" if hit is None else f"S(Op::{camel(hit[0])},Form::{camel(hit[1])})")
    live = len([c for c in cells if c != "N"])
    return (
        f"/// {name} lookup, {live} live of {size}.\n"
        f"static {name}: [Option<(Op, Form)>; {size}] = [{','.join(cells)}];\n\n"
    )


def emit_op_table(name: str, size: int, table: dict) -> str:
    cells = ["None" if table.get(i) is None else f"Some(Op::{camel(table[i])})" for i in range(size)]
    return f"static {name}: [Option<Op>; {size}] = [{','.join(cells)}];\n\n"


def main() -> int:
    if not VENDOR.exists():
        print(f"missing {VENDOR}", file=sys.stderr)
        return 1
    rows = parse_rows(VENDOR.read_text(encoding="utf-8"))
    if len(rows) < 300:
        print(f"only parsed {len(rows)} rows; table format changed?", file=sys.stderr)
        return 1

    s1, s2, s3, s4, s5, s6, testb_by_op, testp_by_s = build_tables(rows)
    mnemonics = sorted({n for n, _, _, _ in rows} | set(VERIFIED_ALIASES.values()))
    forms = sorted({f for _, _, _, f in rows} | {"operand_alias"})

    out = [
        "// @generated by tools/gen_decoder.py from vendor/parseUtils.ts -- DO NOT EDIT.\n"
        "//\n"
        "// Encodings derive from PNut-TS (https://github.com/ironsheep/PNut-TS),\n"
        "// MIT licensed, (c) 2024-2026 Iron Sheep Productions, LLC and Parallax Inc.\n"
        "// Regenerate with `python3 tools/gen_decoder.py`.\n"
        "#![allow(clippy::all)]\n\n"
        "use Form::*;\n"
        "#[allow(unused_imports)]\n"
        "use Op::*;\n\n"
        "// Terse aliases keep the generated tables readable at 512+ entries a line.\n"
        "#[allow(non_upper_case_globals)]\n"
        "const N: Option<(Op, Form)> = None;\n"
        "#[allow(non_snake_case)]\n"
        "const fn S(o: Op, f: Form) -> Option<(Op, Form)> { Some((o, f)) }\n\n"
        "/// Every mnemonic in the PNut-TS table, plus the derived aliases.\n"
        "#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]\npub enum Op {\n"
    ]
    out += [f"    {camel(m)},\n" for m in mnemonics]
    out.append("}\n\nimpl Op {\n    /// Lowercase mnemonic, as flexspin's listing spells it.\n")
    out.append("    pub fn mnemonic(self) -> &'static str {\n        match self {\n")
    out += [f'            Op::{camel(m)} => "{m}",\n' for m in mnemonics]
    out.append("        }\n    }\n}\n\n")
    out.append("/// Operand form -- determines how D/S are read, not just the layout.\n")
    out.append("#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]\npub enum Form {\n")
    out += [f"    {camel(f)},\n" for f in forms]
    out.append("}\n\n")

    out.append(emit_table("S1_REG", 512, s1))
    out.append(emit_table("S2_BRANCH", 128, s2))
    out.append(emit_table("S3_AUG", 32, s3))
    out.append(emit_table("S4_MISC", 1024, s4))
    out.append(emit_table("S5_POLL", 512, s5))
    out.append(emit_table("S6_JPOLL", 512, s6))
    out.append(emit_op_table("TESTB_BY_OP", 128, testb_by_op))
    out.append(emit_op_table("TESTP_BY_S", 512, testp_by_s))

    out.append(r'''
/// One decoded instruction. Field meanings follow the form, not the layout.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Decoded {
    pub op: Op,
    pub form: Form,
    /// EEEE condition field. 0 is the `_RET_` prefix, 15 is unconditional.
    pub cond: u8,
    pub d: u16,
    pub s: u16,
    pub c: bool,
    pub z: bool,
    /// Immediate flag (bit 18). For the misc block this doubles as the L
    /// (D-is-a-literal) bit.
    pub i: bool,
    /// Bit 19. WZ for most instructions; for the S1 L forms it means
    /// "D is a literal" instead.
    pub l: bool,
    /// For AUGS/AUGD and 20-bit branches, the wide literal in the word.
    pub imm: u32,
}

/// Decode one 32-bit instruction word.
///
/// Returns `None` for encodings absent from the table -- callers must trap
/// rather than treat an unknown word as a no-op. Three encodings collide in the
/// source table and are tiebroken here as silicon does:
///
/// 1. `BITL/BITH` vs `TESTB/TESTBN` -- same v1; C==0 && Z==0 selects the
///    D-writing `BITx`, otherwise the flag-writing `TESTB`.
/// 2. `DIRL/DIRH` vs `TESTP/TESTPN` -- same, at S=$40/$41.
/// 3. `WRNZ` vs `MODCZ/MODC/MODZ` at S=$6F -- separated by the I bit.
pub fn decode(word: u32) -> Option<Decoded> {
    let cond = ((word >> 28) & 0xF) as u8;
    let op = ((word >> 21) & 0x7F) as usize;
    let c = (word >> 20) & 1 != 0;
    let z = (word >> 19) & 1 != 0;
    let i = (word >> 18) & 1 != 0;
    let d = ((word >> 9) & 0x1FF) as u16;
    let s = (word & 0x1FF) as u16;

    let mk = |op_: Op, form: Form, imm: u32| {
        Some(Decoded { op: op_, form, cond, d, s, c, z, i, l: z, imm })
    };

    // An all-zero word is NOP on silicon. Without this it decodes as ROR under
    // the `_RET_` condition and returns through an empty stack.
    if word == 0 {
        return Some(Decoded {
            op: Op::Nop, form: OperandNop, cond: 15,
            d: 0, s: 0, c: false, z: false, i: false, l: false, imm: 0,
        });
    }

    // The whole %1111xxx opcode space is AUG; bit 23 picks AUGS from AUGD.
    if op >> 3 == 0b1111 {
        // v1 >> 4 (the generator's key) is instruction bits 27:23 = op >> 2.
        if let Some((o, f)) = S3_AUG[op >> 2] {
            return mk(o, f, word & 0x7F_FFFF);
        }
    }
    // 20-bit relative/absolute branches.
    if (0b1101100..=0b1101111).contains(&op) {
        if let Some((o, f)) = S2_BRANCH[op] {
            return mk(o, f, word & 0xF_FFFF);
        }
    }
    // The misc opcode: the S field is the sub-opcode selector.
    if op == 0b1101011 {
        if s == 0x24 {
            if let Some((o, f)) = S5_POLL[d as usize] {
                return mk(o, f, 0);
            }
        }
        let key = ((i as usize) << 9) | s as usize;
        if let Some((o, f)) = S4_MISC[key].or(S4_MISC[s as usize]) {
            if f == OperandPinop && (c || z) {
                if let Some(tp) = TESTP_BY_S[s as usize] {
                    return mk(tp, OperandTestp, 0);
                }
            }
            return mk(o, f, 0);
        }
    }
    // Event-branch block.
    if op == 0b1011110 {
        if let Some((o, f)) = S6_JPOLL[d as usize] {
            return mk(o, f, 0);
        }
    }
    // The main register-form block.
    let key = (op << 2) | ((c as usize) << 1) | z as usize;
    if let Some((o, f)) = S1_REG[key] {
        if f == OperandBitx && (c || z) {
            if let Some(tb) = TESTB_BY_OP[op] {
                return mk(tb, OperandTestb, 0);
            }
        }
        return mk(o, f, 0);
    }
    None
}
''')

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text("".join(out), encoding="utf-8")
    print(f"rows: {len(rows)}  mnemonics: {len(mnemonics)}  forms: {len(forms)}")
    print(f"tables: S1={len(s1)} S2={len(s2)} S3={len(s3)} S4={len(s4)} S5={len(s5)} S6={len(s6)}")
    print(f"wrote {OUT.relative_to(CRATE)} ({OUT.stat().st_size} bytes)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
