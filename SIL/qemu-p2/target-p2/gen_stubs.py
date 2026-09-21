#!/usr/bin/env python3
"""Emit stubs for every DecodeTree pattern an engine does not model yet.

One `insn.decode` feeds two dispatchers -- the hub-exec translator's `trans_*`
and the cog-exec interpreter's `iexec_*` -- and each has ~480 patterns to
satisfy at link time. Anything not hand-written stops the CPU rather than
silently doing the wrong thing: during bring-up a missing instruction must be
noticed, not drifted past.

usage: gen_stubs.py <decode.c.inc> <out.c.inc> [--interp]
"""
import re
import sys

# Hand-written in translate.c. Keep in sync or the build breaks loudly with a
# duplicate definition, which is the intended failure mode.
TRANS = {
    "mov", "and", "or", "xor", "not", "add", "sub",
    "sar", "cmp", "cmps", "test", "testn", "neg", "abs",
    "shl", "shr", "rol", "ror", "addx", "subx", "adds", "subs", "fge", "fle",
    "decod", "encod", "ones", "muxc", "muxnc", "muxz", "muxnz",
    "zerox", "signx", "sumc", "sumnc", "sumz", "sumnz", "getbyte", "cmpr",
    "incmod", "decmod", "negc", "negnc", "negz", "negnz", "cmpsub",
    "rcl", "rcr", "bitl", "bith", "testb", "testb_2", "testb_3",
    "testbn", "testbn_2", "testbn_3",
    "jmp", "jmp_2", "jmp_3", "call", "call_2", "ret", "jmprel", "jmprel_2",
    "push", "pop", "djnz", "djz", "djf", "djnf", "tjz", "tjnz",
    "callpa", "callpa_2", "callpb", "callpb_2", "calld", "nop_zero",
    "rdbyte", "rdword", "rdlong", "wrbyte", "wrbyte_2", "wrword", "wrword_2",
    "wrlong", "wrlong_2", "augs", "augd", "setq", "setq_2", "setq2",
    "setq2_2", "getct", "getct_2", "rev", "altd", "alts",
    "wrpin", "wrpin_2", "wxpin", "wxpin_2", "wypin", "wypin_2",
    "rdpin", "rdpin_2", "rqpin", "rqpin_2", "testp", "testp_2", "testp_3",
    "waitx", "waitx_2",
    "dirl", "dirl_2", "dirh", "dirh_2", "fltl", "fltl_2", "flth", "flth_2",
    "drvl", "drvl_2", "drvh", "drvh_2", "outl", "outl_2", "outh", "outh_2",
    "drvc", "drvc_2", "drvnc", "drvnc_2", "drvz", "drvz_2", "drvnz",
    "drvnz_2", "drvnot", "drvnot_2",
    "fges", "fles", "subr", "andn", "movbyts", "bitnot", "bitc", "bitnc",
    "bitz", "bitnz", "wrc", "wrnc", "wrz", "wrnz",
    "wrc_2", "wrnc_2", "wrz_2", "wrnz_2",
    "qmul", "qmul_2", "qdiv", "qdiv_2", "qsqrt", "qsqrt_2", "qrotate",
    "qrotate_2", "getqx", "getqx_2", "getqy", "getqy_2",
    "locknew", "locknew_2", "lockret", "lockret_2", "locktry", "locktry_2",
    "lockrel", "lockrel_2", "cogid", "cogid_2", "cogstop", "cogstop_2",
    "hubset", "hubset_2", "addct1", "addct2", "addct3", "waitct1",
    "rep", "rep_2", "skip", "skip_2", "coginit",
    "modcz", "pollse1", "pollse2", "pollse3", "pollse4", "bitrnd",
}

# Hand-written in interp.c. A subset: only cog-exec reaches it, and what the
# firmware runs there is 41 mnemonics (p2core/examples/ophist.rs with
# P2CORE_COG_ONLY=1). The harness covers more than the firmware uses.
INTERP = {
    "mov", "not", "and", "andn", "or", "xor",
    "muxc", "muxnc", "muxz", "muxnz", "zerox", "signx",
    "decod", "movbyts", "getbyte", "encod", "ones", "rev",
    "add", "sub", "subr", "cmp", "cmpr", "cmps",
    "cmpsub", "test", "testn", "neg", "abs", "negc",
    "negnc", "negz", "negnz", "addx", "subx", "adds",
    "subs", "sumc", "sumnc", "sumz", "sumnz", "fge",
    "fle", "fges", "fles", "incmod", "decmod", "shl",
    "shr", "sar", "rol", "ror", "rcl", "rcr",
    "bith", "bitl", "bitnot", "bitc", "bitnc", "bitz",
    "bitnz", "bitrnd", "testb", "testb_2", "testb_3", "testbn",
    "testbn_2", "testbn_3", "jmp", "jmp_2", "jmp_3", "call",
    "call_2", "ret", "jmprel", "jmprel_2", "push", "pop",
    "djnz", "djz", "djf", "djnf", "tjz", "tjnz",
    "callpa", "callpa_2", "callpb", "callpb_2", "calld", "nop_zero",
    "rdbyte", "rdword", "rdlong", "wrbyte", "wrbyte_2", "wrword",
    "wrword_2", "wrlong", "wrlong_2", "augs", "augd", "setq",
    "setq_2", "setq2", "setq2_2", "altd", "alts", "wrpin",
    "wrpin_2", "wxpin", "wxpin_2", "wypin", "wypin_2", "rdpin",
    "rdpin_2", "rqpin", "rqpin_2", "testp", "testp_2", "testp_3",
    "dirl", "dirl_2", "dirh", "dirh_2", "fltl", "fltl_2",
    "flth", "flth_2", "drvl", "drvl_2", "drvh", "drvh_2",
    "outl", "outl_2", "outh", "outh_2", "drvc", "drvc_2",
    "drvnc", "drvnc_2", "drvz", "drvz_2", "drvnz", "drvnz_2",
    "drvnot", "drvnot_2", "waitx", "waitx_2", "cogstop", "cogstop_2",
    "lockret", "lockret_2", "skip", "skip_2", "hubset", "hubset_2",
    "lockrel", "lockrel_2", "locktry", "locktry_2", "locknew", "locknew_2",
    "cogid", "cogid_2", "getct", "getct_2", "getqx", "getqx_2",
    "getqy", "getqy_2", "qmul", "qmul_2", "qdiv", "qdiv_2",
    "qsqrt", "qsqrt_2", "qrotate", "qrotate_2", "addct1", "addct2",
    "addct3", "waitct1", "pollse1", "pollse2", "pollse3", "pollse4",
    "modcz", "wrc", "wrnc", "wrz", "wrnz", "wrc_2",
    "wrnc_2", "wrz_2", "wrnz_2", "rep", "rep_2", "coginit",
}

decode_c = open(sys.argv[1]).read()
interp = "--interp" in sys.argv
prefix = "iexec" if interp else "trans"
impl = INTERP if interp else TRANS
scope = "" if interp else "static "
body = "    return ip_unimpl(ctx);" if interp else "    return p2_unimpl(ctx);"

names = re.findall(r"^%sbool %s_(\w+)\(DisasContext \*ctx, arg_(\w+) \*a\);"
                   % (scope, prefix), decode_c, re.M)
out = ["/* @generated by gen_stubs.py -- DO NOT EDIT. */", ""]
n = 0
for name, arg in names:
    if name in impl:
        continue
    out.append("%sbool %s_%s(DisasContext *ctx, arg_%s *a)\n{\n%s\n}"
               % (scope, prefix, name, arg, body))
    n += 1
open(sys.argv[2], "w").write("\n".join(out) + "\n")
print("%s: %d stubs, %d hand-implemented" % (prefix, n, len(impl)),
      file=sys.stderr)
