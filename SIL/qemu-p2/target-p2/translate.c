/*
 * Parallax Propeller 2 translation.
 * SPDX-License-Identifier: LGPL-2.1-or-later
 *
 * Shape settled by the Phase 0 spikes (docs/dev/p2-qemu-target-plan.md):
 *
 *  - Hub-exec (PC >= $400) is TRANSLATED. Measured: hub RAM takes zero
 *    self-modifying-code invalidations across a whole firmware run, and it is
 *    93% of all instructions.
 *  - Cog-exec (PC < $400) is INTERPRETED via one helper call per RUN of
 *    instructions. Cog RAM is the register file; translating from it would put
 *    registers and code in the same page, and QEMU's SMC trap is per-page and
 *    sticky (+194 ns per register write, ~20x too slow).
 *  - Operands are resolved at TRANSLATE time. ALTx is a prefix the translator
 *    sees, and only the instruction after one needs a runtime-indexed operand:
 *    measured at 0.0999% of instructions, so 99.9% get a constant env offset.
 *  - Pin ops are helpers and never end a translation block.
 */
#include "qemu/osdep.h"
#include "cpu.h"
#include "tcg/tcg-op.h"
#include "exec/helper-proto.h"
#include "exec/helper-gen.h"
#include "exec/translator.h"
#include "exec/translation-block.h"
#include "exec/target_page.h"

#define HELPER_H "helper.h"
#include "exec/helper-info.c.inc"
#undef  HELPER_H

/* How many cog instructions one interpreter call runs. The firmware's measured
 * mean run before the PC leaves cog space is 46.2. */
#define P2_COG_RUN 48

typedef struct DisasContext {
    DisasContextBase base;
    CPUP2State *env;
    /* Set when the previous instruction was an ALTx prefix: this instruction's
     * D/S are runtime values, not encoding constants. 0.0999% of the stream. */
    bool alt_pending;
    /* Set by any instruction that writes the PC itself: it swallows the _RET_
     * prefix, which would otherwise return a second time. */
    bool branched;
} DisasContext;

/* ------------------------------------------------------------- operand access
 *
 * Cog RAM lives in CPUArchState. A register whose index is known at translate
 * time is a constant env offset -- one host load -- which is the case for
 * 99.9% of instructions.
 */
static void p2_ld_cog(TCGv_i32 dst, unsigned idx)
{
    tcg_gen_ld_i32(dst, tcg_env, offsetof(CPUP2State, cog[idx & (P2_COG_LONGS - 1)]));
}

static void p2_st_cog(TCGv_i32 src, unsigned idx)
{
    tcg_gen_st_i32(src, tcg_env, offsetof(CPUP2State, cog[idx & (P2_COG_LONGS - 1)]));
}

/* S operand: an immediate when I is set, else a register. */
static void p2_get_s(TCGv_i32 dst, int i, unsigned s)
{
    if (i) {
        tcg_gen_movi_i32(dst, s);
    } else {
        p2_ld_cog(dst, s);
    }
}

static void p2_set_z(TCGv_i32 r, int z)
{
    if (z) {
        TCGv_i32 t = tcg_temp_new_i32();
        tcg_gen_setcondi_i32(TCG_COND_EQ, t, r, 0);
        tcg_gen_st_i32(t, tcg_env, offsetof(CPUP2State, z));
    }
}

/*
 * WC means different things per instruction, and getting it wrong is silent.
 * AND/OR/XOR set C to the PARITY of the result; MOV/NOT set it to bit 31.
 * (The differential harness caught exactly this: a MOV WC whose source had
 * bit 31 set gave C=1 on p2core and C=0 here.)
 */
static void p2_set_flags_parity(TCGv_i32 r, int c, int z)
{
    p2_set_z(r, z);
    if (c) {
        TCGv_i32 t = tcg_temp_new_i32();
        tcg_gen_ctpop_i32(t, r);
        tcg_gen_andi_i32(t, t, 1);
        tcg_gen_st_i32(t, tcg_env, offsetof(CPUP2State, c));
    }
}

static void p2_set_flags_sign(TCGv_i32 r, int c, int z)
{
    p2_set_z(r, z);
    if (c) {
        TCGv_i32 t = tcg_temp_new_i32();
        tcg_gen_shri_i32(t, r, 31);
        tcg_gen_st_i32(t, tcg_env, offsetof(CPUP2State, c));
    }
}

/* The EEEE field gates every instruction. %1111 is unconditional and %0000 is
 * the _RET_ prefix, which executes and then returns. */
static TCGLabel *p2_gen_cond(DisasContext *ctx, int cond)
{
    TCGv_i32 c, z, sel;
    TCGLabel *skip;

    if (cond == 0xF || cond == 0) {
        return NULL;
    }
    skip = gen_new_label();
    c = tcg_temp_new_i32();
    z = tcg_temp_new_i32();
    sel = tcg_temp_new_i32();
    tcg_gen_ld_i32(c, tcg_env, offsetof(CPUP2State, c));
    tcg_gen_ld_i32(z, tcg_env, offsetof(CPUP2State, z));
    tcg_gen_shli_i32(sel, c, 1);
    tcg_gen_or_i32(sel, sel, z);
    tcg_gen_movi_i32(c, cond);
    tcg_gen_shr_i32(c, c, sel);
    tcg_gen_andi_i32(c, c, 1);
    tcg_gen_brcondi_i32(TCG_COND_EQ, c, 0, skip);
    return skip;
}

static void p2_end_cond(TCGLabel *skip)
{
    if (skip) {
        gen_set_label(skip);
    }
}

/* Every instruction costs its time, even a cancelled one. */
static void p2_gen_clock(void)
{
    TCGv_i64 t = tcg_temp_new_i64();
    tcg_gen_ld_i64(t, tcg_env, offsetof(CPUP2State, clocks));
    tcg_gen_addi_i64(t, t, P2_CLOCKS_PER_INSN);
    tcg_gen_st_i64(t, tcg_env, offsetof(CPUP2State, clocks));
}

/* ------------------------------------------------------------------ decoder */
#include "decode-insn.c.inc"

/* An ALU op with the shape: read D, read S, combine, write D, set flags. */
#define GEN_ALU(NAME, EXPR, FLAGS)                                            \
    static bool trans_##NAME(DisasContext *ctx, arg_ds *a)                    \
    {                                                                         \
        TCGv_i32 d = tcg_temp_new_i32();                                      \
        TCGv_i32 s = tcg_temp_new_i32();                                      \
        TCGLabel *skip = p2_gen_cond(ctx, a->cond);                           \
        p2_ld_cog(d, a->d);                                                   \
        p2_get_s(s, a->i, a->s);                                              \
        EXPR;                                                                 \
        p2_st_cog(d, a->d);                                                   \
        FLAGS(d, a->c, a->z);                                                 \
        p2_end_cond(skip);                                                    \
        return true;                                                          \
    }

GEN_ALU(and, tcg_gen_and_i32(d, d, s), p2_set_flags_parity)
GEN_ALU(or,  tcg_gen_or_i32(d, d, s),  p2_set_flags_parity)
GEN_ALU(xor, tcg_gen_xor_i32(d, d, s), p2_set_flags_parity)
GEN_ALU(mov, tcg_gen_mov_i32(d, s),    p2_set_flags_sign)
GEN_ALU(not, tcg_gen_not_i32(d, s),    p2_set_flags_sign)

/* ADD/SUB set C from the carry/borrow, not parity. */
static bool trans_add(DisasContext *ctx, arg_ds *a)
{
    TCGv_i32 d = tcg_temp_new_i32();
    TCGv_i32 s = tcg_temp_new_i32();
    TCGv_i32 r = tcg_temp_new_i32();
    TCGLabel *skip = p2_gen_cond(ctx, a->cond);

    p2_ld_cog(d, a->d);
    p2_get_s(s, a->i, a->s);
    tcg_gen_add_i32(r, d, s);
    if (a->c) {
        TCGv_i32 cf = tcg_temp_new_i32();
        tcg_gen_setcond_i32(TCG_COND_LTU, cf, r, d);
        tcg_gen_st_i32(cf, tcg_env, offsetof(CPUP2State, c));
    }
    if (a->z) {
        TCGv_i32 zf = tcg_temp_new_i32();
        tcg_gen_setcondi_i32(TCG_COND_EQ, zf, r, 0);
        tcg_gen_st_i32(zf, tcg_env, offsetof(CPUP2State, z));
    }
    p2_st_cog(r, a->d);
    p2_end_cond(skip);
    return true;
}

static bool trans_sub(DisasContext *ctx, arg_ds *a)
{
    TCGv_i32 d = tcg_temp_new_i32();
    TCGv_i32 s = tcg_temp_new_i32();
    TCGv_i32 r = tcg_temp_new_i32();
    TCGLabel *skip = p2_gen_cond(ctx, a->cond);

    p2_ld_cog(d, a->d);
    p2_get_s(s, a->i, a->s);
    tcg_gen_sub_i32(r, d, s);
    if (a->c) {
        TCGv_i32 cf = tcg_temp_new_i32();
        tcg_gen_setcond_i32(TCG_COND_LTU, cf, d, s);
        tcg_gen_st_i32(cf, tcg_env, offsetof(CPUP2State, c));
    }
    if (a->z) {
        TCGv_i32 zf = tcg_temp_new_i32();
        tcg_gen_setcondi_i32(TCG_COND_EQ, zf, r, 0);
        tcg_gen_st_i32(zf, tcg_env, offsetof(CPUP2State, z));
    }
    p2_st_cog(r, a->d);
    p2_end_cond(skip);
    return true;
}


/* ---- batch 2: semantics transcribed from p2core's execute(), which is the
 * reference the differential harness checks against. Each WC rule is
 * per-instruction and none of them is guessable. */

/* SAR: C is the last bit shifted out (the bit below the final position). */
static bool trans_sar(DisasContext *ctx, arg_ds *a)
{
    TCGv_i32 d = tcg_temp_new_i32(), sv = tcg_temp_new_i32();
    TCGv_i32 n = tcg_temp_new_i32(), r = tcg_temp_new_i32();
    TCGLabel *skip = p2_gen_cond(ctx, a->cond);

    p2_ld_cog(d, a->d);
    p2_get_s(sv, a->i, a->s);
    tcg_gen_andi_i32(n, sv, 31);
    tcg_gen_sar_i32(r, d, n);
    if (a->c) {
        TCGv_i32 m = tcg_temp_new_i32(), probe = tcg_temp_new_i32();
        /* n == 0 probes D itself, else D >> (n-1). */
        tcg_gen_subi_i32(m, n, 1);
        tcg_gen_movcond_i32(TCG_COND_EQ, m, n, tcg_constant_i32(0),
                            tcg_constant_i32(0), m);
        tcg_gen_sar_i32(probe, d, m);
        tcg_gen_andi_i32(probe, probe, 1);
        tcg_gen_st_i32(probe, tcg_env, offsetof(CPUP2State, c));
    }
    p2_st_cog(r, a->d);
    p2_set_z(r, a->z);
    p2_end_cond(skip);
    return true;
}

/* CMP/CMPS/TEST/TESTN set flags only -- D is not written. */
static bool trans_cmp(DisasContext *ctx, arg_ds *a)
{
    TCGv_i32 d = tcg_temp_new_i32(), sv = tcg_temp_new_i32(), r = tcg_temp_new_i32();
    TCGLabel *skip = p2_gen_cond(ctx, a->cond);

    p2_ld_cog(d, a->d);
    p2_get_s(sv, a->i, a->s);
    tcg_gen_sub_i32(r, d, sv);
    if (a->c) {
        TCGv_i32 cf = tcg_temp_new_i32();
        tcg_gen_setcond_i32(TCG_COND_LTU, cf, d, sv);   /* borrow */
        tcg_gen_st_i32(cf, tcg_env, offsetof(CPUP2State, c));
    }
    p2_set_z(r, a->z);
    p2_end_cond(skip);
    return true;
}

static bool trans_cmps(DisasContext *ctx, arg_ds *a)
{
    TCGv_i32 d = tcg_temp_new_i32(), sv = tcg_temp_new_i32(), r = tcg_temp_new_i32();
    TCGLabel *skip = p2_gen_cond(ctx, a->cond);

    p2_ld_cog(d, a->d);
    p2_get_s(sv, a->i, a->s);
    tcg_gen_sub_i32(r, d, sv);
    if (a->c) {
        TCGv_i32 cf = tcg_temp_new_i32();
        tcg_gen_setcond_i32(TCG_COND_LT, cf, d, sv);    /* SIGNED compare */
        tcg_gen_st_i32(cf, tcg_env, offsetof(CPUP2State, c));
    }
    p2_set_z(r, a->z);
    p2_end_cond(skip);
    return true;
}

#define GEN_TEST(NAME, EXPR)                                                  \
    static bool trans_##NAME(DisasContext *ctx, arg_ds *a)                    \
    {                                                                         \
        TCGv_i32 d = tcg_temp_new_i32(), sv = tcg_temp_new_i32();             \
        TCGv_i32 r = tcg_temp_new_i32();                                      \
        TCGLabel *skip = p2_gen_cond(ctx, a->cond);                           \
        p2_ld_cog(d, a->d);                                                   \
        p2_get_s(sv, a->i, a->s);                                             \
        EXPR;                                                                 \
        p2_set_flags_parity(r, a->c, a->z);                                   \
        p2_end_cond(skip);                                                    \
        return true;                                                          \
    }

GEN_TEST(test,  tcg_gen_and_i32(r, d, sv))
GEN_TEST(testn, tcg_gen_andc_i32(r, d, sv))

/* NEG: C is the sign of the RESULT. ABS: C is the sign of the INPUT. */
GEN_ALU(neg, tcg_gen_neg_i32(d, s), p2_set_flags_sign)

static bool trans_abs(DisasContext *ctx, arg_ds *a)
{
    TCGv_i32 sv = tcg_temp_new_i32(), r = tcg_temp_new_i32();
    TCGLabel *skip = p2_gen_cond(ctx, a->cond);

    p2_get_s(sv, a->i, a->s);
    tcg_gen_abs_i32(r, sv);
    if (a->c) {
        TCGv_i32 cf = tcg_temp_new_i32();
        tcg_gen_shri_i32(cf, sv, 31);                   /* sign of the INPUT */
        tcg_gen_st_i32(cf, tcg_env, offsetof(CPUP2State, c));
    }
    p2_st_cog(r, a->d);
    p2_set_z(r, a->z);
    p2_end_cond(skip);
    return true;
}


/* ---- batch 3 ------------------------------------------------------------
 * Shifts: C is the last bit shifted OUT, probed at n-1 (and at n==0 the probe
 * is D itself, which is why every one of these needs a movcond rather than a
 * plain shift). Semantics transcribed from p2core's execute().
 */
static void p2_shift_cout(TCGv_i32 d, TCGv_i32 n, int left)
{
    TCGv_i32 m = tcg_temp_new_i32(), probe = tcg_temp_new_i32();

    tcg_gen_subi_i32(m, n, 1);
    tcg_gen_movcond_i32(TCG_COND_EQ, m, n, tcg_constant_i32(0),
                        tcg_constant_i32(0), m);
    if (left) {
        tcg_gen_shl_i32(probe, d, m);
        tcg_gen_shri_i32(probe, probe, 31);
    } else {
        tcg_gen_shr_i32(probe, d, m);
        tcg_gen_andi_i32(probe, probe, 1);
    }
    tcg_gen_st_i32(probe, tcg_env, offsetof(CPUP2State, c));
}

#define GEN_SHIFT(NAME, OP, LEFT)                                             \
    static bool trans_##NAME(DisasContext *ctx, arg_ds *a)                    \
    {                                                                         \
        TCGv_i32 d = tcg_temp_new_i32(), sv = tcg_temp_new_i32();             \
        TCGv_i32 n = tcg_temp_new_i32(), r = tcg_temp_new_i32();              \
        TCGLabel *skip = p2_gen_cond(ctx, a->cond);                           \
        p2_ld_cog(d, a->d);                                                   \
        p2_get_s(sv, a->i, a->s);                                             \
        tcg_gen_andi_i32(n, sv, 31);                                          \
        OP(r, d, n);                                                          \
        if (a->c) { p2_shift_cout(d, n, LEFT); }                              \
        p2_st_cog(r, a->d);                                                   \
        p2_set_z(r, a->z);                                                    \
        p2_end_cond(skip);                                                    \
        return true;                                                          \
    }

GEN_SHIFT(shl, tcg_gen_shl_i32,  1)
GEN_SHIFT(shr, tcg_gen_shr_i32,  0)
GEN_SHIFT(rol, tcg_gen_rotl_i32, 1)
GEN_SHIFT(ror, tcg_gen_rotr_i32, 0)

/*
 * ADDX/SUBX chain through C, and their Z is STICKY: z = z && (r == 0), which
 * is what makes a multi-long add report zero only if every long was zero.
 */
#define GEN_XCHAIN(NAME, ADD)                                                 \
    static bool trans_##NAME(DisasContext *ctx, arg_ds *a)                    \
    {                                                                         \
        TCGv_i32 d = tcg_temp_new_i32(), sv = tcg_temp_new_i32();             \
        TCGv_i32 r = tcg_temp_new_i32(), cin = tcg_temp_new_i32();            \
        TCGv_i32 c1 = tcg_temp_new_i32(), c2 = tcg_temp_new_i32();            \
        TCGv_i32 t = tcg_temp_new_i32();                                      \
        TCGLabel *skip = p2_gen_cond(ctx, a->cond);                           \
        p2_ld_cog(d, a->d);                                                   \
        p2_get_s(sv, a->i, a->s);                                             \
        tcg_gen_ld_i32(cin, tcg_env, offsetof(CPUP2State, c));                \
        if (ADD) {                                                            \
            tcg_gen_add_i32(t, d, sv);                                        \
            tcg_gen_setcond_i32(TCG_COND_LTU, c1, t, d);                      \
            tcg_gen_add_i32(r, t, cin);                                       \
            tcg_gen_setcond_i32(TCG_COND_LTU, c2, r, t);                      \
        } else {                                                              \
            tcg_gen_sub_i32(t, d, sv);                                        \
            tcg_gen_setcond_i32(TCG_COND_LTU, c1, d, sv);                     \
            tcg_gen_sub_i32(r, t, cin);                                       \
            tcg_gen_setcond_i32(TCG_COND_LTU, c2, t, cin);                    \
        }                                                                     \
        if (a->c) {                                                           \
            tcg_gen_or_i32(c1, c1, c2);                                       \
            tcg_gen_st_i32(c1, tcg_env, offsetof(CPUP2State, c));             \
        }                                                                     \
        if (a->z) {                                                           \
            TCGv_i32 zf = tcg_temp_new_i32(), old = tcg_temp_new_i32();       \
            tcg_gen_ld_i32(old, tcg_env, offsetof(CPUP2State, z));            \
            tcg_gen_setcondi_i32(TCG_COND_EQ, zf, r, 0);                      \
            tcg_gen_and_i32(zf, zf, old);            /* sticky */             \
            tcg_gen_st_i32(zf, tcg_env, offsetof(CPUP2State, z));             \
        }                                                                     \
        p2_st_cog(r, a->d);                                                   \
        p2_end_cond(skip);                                                    \
        return true;                                                          \
    }

GEN_XCHAIN(addx, 1)
GEN_XCHAIN(subx, 0)

/* ADDS/SUBS: C is the sign of the TRUE 33-bit result, not the wrapped one. */
#define GEN_SIGNED(NAME, ADD)                                                 \
    static bool trans_##NAME(DisasContext *ctx, arg_ds *a)                    \
    {                                                                         \
        TCGv_i32 d = tcg_temp_new_i32(), sv = tcg_temp_new_i32();             \
        TCGv_i32 r = tcg_temp_new_i32();                                      \
        TCGv_i64 wd = tcg_temp_new_i64(), ws = tcg_temp_new_i64();            \
        TCGLabel *skip = p2_gen_cond(ctx, a->cond);                           \
        p2_ld_cog(d, a->d);                                                   \
        p2_get_s(sv, a->i, a->s);                                             \
        if (ADD) { tcg_gen_add_i32(r, d, sv); }                               \
        else     { tcg_gen_sub_i32(r, d, sv); }                               \
        if (a->c) {                                                           \
            TCGv_i32 cf = tcg_temp_new_i32();                                 \
            tcg_gen_ext_i32_i64(wd, d);                                       \
            tcg_gen_ext_i32_i64(ws, sv);                                      \
            if (ADD) { tcg_gen_add_i64(wd, wd, ws); }                         \
            else     { tcg_gen_sub_i64(wd, wd, ws); }                         \
            tcg_gen_setcondi_i64(TCG_COND_LT, wd, wd, 0);                     \
            tcg_gen_extrl_i64_i32(cf, wd);                                    \
            tcg_gen_st_i32(cf, tcg_env, offsetof(CPUP2State, c));             \
        }                                                                     \
        p2_st_cog(r, a->d);                                                   \
        p2_set_z(r, a->z);                                                    \
        p2_end_cond(skip);                                                    \
        return true;                                                          \
    }

GEN_SIGNED(adds, 1)
GEN_SIGNED(subs, 0)

/* FGE/FLE clamp, and C reports whether the clamp fired. */
#define GEN_CLAMP(NAME, COND)                                                 \
    static bool trans_##NAME(DisasContext *ctx, arg_ds *a)                    \
    {                                                                         \
        TCGv_i32 d = tcg_temp_new_i32(), sv = tcg_temp_new_i32();             \
        TCGv_i32 r = tcg_temp_new_i32();                                      \
        TCGLabel *skip = p2_gen_cond(ctx, a->cond);                           \
        p2_ld_cog(d, a->d);                                                   \
        p2_get_s(sv, a->i, a->s);                                             \
        tcg_gen_movcond_i32(COND, r, d, sv, sv, d);                           \
        if (a->c) {                                                           \
            TCGv_i32 cf = tcg_temp_new_i32();                                 \
            tcg_gen_setcond_i32(COND, cf, d, sv);                             \
            tcg_gen_st_i32(cf, tcg_env, offsetof(CPUP2State, c));             \
        }                                                                     \
        p2_st_cog(r, a->d);                                                   \
        p2_set_z(r, a->z);                                                    \
        p2_end_cond(skip);                                                    \
        return true;                                                          \
    }

GEN_CLAMP(fge, TCG_COND_LTU)
GEN_CLAMP(fle, TCG_COND_GTU)

/* DECOD has no C rule at all; ENCOD's C is "S was non-zero". */
static bool trans_decod(DisasContext *ctx, arg_ds *a)
{
    TCGv_i32 sv = tcg_temp_new_i32(), r = tcg_temp_new_i32();
    TCGLabel *skip = p2_gen_cond(ctx, a->cond);

    p2_get_s(sv, a->i, a->s);
    tcg_gen_andi_i32(r, sv, 31);
    tcg_gen_shl_i32(r, tcg_constant_i32(1), r);
    p2_st_cog(r, a->d);
    p2_set_z(r, a->z);
    p2_end_cond(skip);
    return true;
}

static bool trans_encod(DisasContext *ctx, arg_ds *a)
{
    TCGv_i32 sv = tcg_temp_new_i32(), r = tcg_temp_new_i32();
    TCGLabel *skip = p2_gen_cond(ctx, a->cond);

    p2_get_s(sv, a->i, a->s);
    tcg_gen_clzi_i32(r, sv, 32);            /* 32 when S == 0 */
    tcg_gen_umin_i32(r, r, tcg_constant_i32(31));
    tcg_gen_sub_i32(r, tcg_constant_i32(31), r);
    if (a->c) {
        TCGv_i32 cf = tcg_temp_new_i32();
        tcg_gen_setcondi_i32(TCG_COND_NE, cf, sv, 0);
        tcg_gen_st_i32(cf, tcg_env, offsetof(CPUP2State, c));
    }
    p2_st_cog(r, a->d);
    p2_set_z(r, a->z);
    p2_end_cond(skip);
    return true;
}

static bool trans_ones(DisasContext *ctx, arg_ds *a)
{
    TCGv_i32 sv = tcg_temp_new_i32(), r = tcg_temp_new_i32();
    TCGLabel *skip = p2_gen_cond(ctx, a->cond);

    p2_get_s(sv, a->i, a->s);
    tcg_gen_ctpop_i32(r, sv);
    p2_st_cog(r, a->d);
    /*
     * C is the LOW BIT of the count, not its parity. The count is already a
     * population count, so `r & 1` and `parity(r)` differ for e.g. r = 5.
     */
    if (a->c) {
        TCGv_i32 cf = tcg_temp_new_i32();
        tcg_gen_andi_i32(cf, r, 1);
        tcg_gen_st_i32(cf, tcg_env, offsetof(CPUP2State, c));
    }
    p2_set_z(r, a->z);
    p2_end_cond(skip);
    return true;
}

/* MUXx: replace the bits S selects with all-ones or all-zeros per the flag. */
#define GEN_MUX(NAME, FIELD, INVERT)                                          \
    static bool trans_##NAME(DisasContext *ctx, arg_ds *a)                    \
    {                                                                         \
        TCGv_i32 d = tcg_temp_new_i32(), sv = tcg_temp_new_i32();             \
        TCGv_i32 r = tcg_temp_new_i32(), m = tcg_temp_new_i32();              \
        TCGLabel *skip = p2_gen_cond(ctx, a->cond);                           \
        p2_ld_cog(d, a->d);                                                   \
        p2_get_s(sv, a->i, a->s);                                             \
        tcg_gen_ld_i32(m, tcg_env, offsetof(CPUP2State, FIELD));              \
        if (INVERT) { tcg_gen_xori_i32(m, m, 1); }                            \
        tcg_gen_neg_i32(m, m);                  /* 1 -> ~0, 0 -> 0 */         \
        tcg_gen_andc_i32(r, d, sv);                                           \
        tcg_gen_and_i32(m, m, sv);                                            \
        tcg_gen_or_i32(r, r, m);                                              \
        p2_st_cog(r, a->d);                                                   \
        p2_set_flags_parity(r, a->c, a->z);                                   \
        p2_end_cond(skip);                                                    \
        return true;                                                          \
    }

GEN_MUX(muxc,  c, 0)
GEN_MUX(muxnc, c, 1)
GEN_MUX(muxz,  z, 0)
GEN_MUX(muxnz, z, 1)


/* ---- batch 4 ------------------------------------------------------------ */

/* ZEROX keeps bits 0..S, and has NO C rule at all. SIGNX sign-extends from
 * bit S and sets C to the resulting sign. */
static bool trans_zerox(DisasContext *ctx, arg_ds *a)
{
    TCGv_i32 d = tcg_temp_new_i32(), sv = tcg_temp_new_i32();
    TCGv_i32 n = tcg_temp_new_i32(), m = tcg_temp_new_i32(), r = tcg_temp_new_i32();
    TCGLabel *skip = p2_gen_cond(ctx, a->cond);

    p2_ld_cog(d, a->d);
    p2_get_s(sv, a->i, a->s);
    tcg_gen_andi_i32(n, sv, 31);
    /* mask = (1 << (n+1)) - 1, and all-ones when n == 31 (no shift by 32). */
    tcg_gen_addi_i32(m, n, 1);
    tcg_gen_shl_i32(m, tcg_constant_i32(1), m);
    tcg_gen_subi_i32(m, m, 1);
    tcg_gen_movcond_i32(TCG_COND_EQ, m, n, tcg_constant_i32(31),
                        tcg_constant_i32(-1), m);
    tcg_gen_and_i32(r, d, m);
    p2_st_cog(r, a->d);
    p2_set_z(r, a->z);
    p2_end_cond(skip);
    return true;
}

static bool trans_signx(DisasContext *ctx, arg_ds *a)
{
    TCGv_i32 d = tcg_temp_new_i32(), sv = tcg_temp_new_i32();
    TCGv_i32 sh = tcg_temp_new_i32(), r = tcg_temp_new_i32();
    TCGLabel *skip = p2_gen_cond(ctx, a->cond);

    p2_ld_cog(d, a->d);
    p2_get_s(sv, a->i, a->s);
    tcg_gen_andi_i32(sh, sv, 31);
    tcg_gen_sub_i32(sh, tcg_constant_i32(31), sh);
    tcg_gen_shl_i32(r, d, sh);
    tcg_gen_sar_i32(r, r, sh);
    if (a->c) {
        TCGv_i32 cf = tcg_temp_new_i32();
        tcg_gen_shri_i32(cf, r, 31);
        tcg_gen_st_i32(cf, tcg_env, offsetof(CPUP2State, c));
    }
    p2_st_cog(r, a->d);
    p2_set_z(r, a->z);
    p2_end_cond(skip);
    return true;
}

/*
 * SUMx adds or SUBTRACTS S depending on a flag, and C is the sign of the TRUE
 * 33-bit result -- the same rule as ADDS/SUBS, not a carry-out.
 */
#define GEN_SUM(NAME, FIELD, INVERT)                                          \
    static bool trans_##NAME(DisasContext *ctx, arg_ds *a)                    \
    {                                                                         \
        TCGv_i32 d = tcg_temp_new_i32(), sv = tcg_temp_new_i32();             \
        TCGv_i32 take = tcg_temp_new_i32(), r = tcg_temp_new_i32();           \
        TCGv_i32 neg = tcg_temp_new_i32(), eff = tcg_temp_new_i32();          \
        TCGv_i64 wd = tcg_temp_new_i64(), ws = tcg_temp_new_i64();            \
        TCGLabel *skip = p2_gen_cond(ctx, a->cond);                           \
        p2_ld_cog(d, a->d);                                                   \
        p2_get_s(sv, a->i, a->s);                                             \
        tcg_gen_ld_i32(take, tcg_env, offsetof(CPUP2State, FIELD));           \
        if (INVERT) { tcg_gen_xori_i32(take, take, 1); }                      \
        /* effective addend: S, or -S when the flag says subtract */          \
        tcg_gen_neg_i32(neg, sv);                                             \
        tcg_gen_movcond_i32(TCG_COND_NE, eff, take, tcg_constant_i32(0),      \
                            neg, sv);                                         \
        tcg_gen_add_i32(r, d, eff);                                           \
        if (a->c) {                                                           \
            TCGv_i32 cf = tcg_temp_new_i32();                                 \
            tcg_gen_ext_i32_i64(wd, d);                                       \
            tcg_gen_ext_i32_i64(ws, eff);                                     \
            tcg_gen_add_i64(wd, wd, ws);                                      \
            tcg_gen_setcondi_i64(TCG_COND_LT, wd, wd, 0);                     \
            tcg_gen_extrl_i64_i32(cf, wd);                                    \
            tcg_gen_st_i32(cf, tcg_env, offsetof(CPUP2State, c));             \
        }                                                                     \
        p2_st_cog(r, a->d);                                                   \
        p2_set_z(r, a->z);                                                    \
        p2_end_cond(skip);                                                    \
        return true;                                                          \
    }

GEN_SUM(sumc,  c, 0)
GEN_SUM(sumnc, c, 1)
GEN_SUM(sumz,  z, 0)
GEN_SUM(sumnz, z, 1)

/* GETBYTE: C and Z are the byte SELECTOR (n = (C<<1)|Z), not flag effects,
 * so nothing is written to C or Z. */
static bool trans_getbyte(DisasContext *ctx, arg_ds *a)
{
    TCGv_i32 sv = tcg_temp_new_i32(), r = tcg_temp_new_i32();
    TCGLabel *skip = p2_gen_cond(ctx, a->cond);
    unsigned n = ((unsigned)a->c << 1) | (unsigned)a->z;

    p2_get_s(sv, a->i, a->s);
    tcg_gen_shri_i32(r, sv, n * 8);
    tcg_gen_andi_i32(r, r, 0xFF);
    p2_st_cog(r, a->d);
    p2_end_cond(skip);
    return true;
}

/* CMPR is the reversed compare: S - D, flags only. */
static bool trans_cmpr(DisasContext *ctx, arg_ds *a)
{
    TCGv_i32 d = tcg_temp_new_i32(), sv = tcg_temp_new_i32(), r = tcg_temp_new_i32();
    TCGLabel *skip = p2_gen_cond(ctx, a->cond);

    p2_ld_cog(d, a->d);
    p2_get_s(sv, a->i, a->s);
    tcg_gen_sub_i32(r, sv, d);
    if (a->c) {
        TCGv_i32 cf = tcg_temp_new_i32();
        tcg_gen_setcond_i32(TCG_COND_LTU, cf, sv, d);
        tcg_gen_st_i32(cf, tcg_env, offsetof(CPUP2State, c));
    }
    p2_set_z(r, a->z);
    p2_end_cond(skip);
    return true;
}

/* INCMOD/DECMOD count within [0, S] and C reports the wrap. */
static bool trans_incmod(DisasContext *ctx, arg_ds *a)
{
    TCGv_i32 d = tcg_temp_new_i32(), sv = tcg_temp_new_i32();
    TCGv_i32 r = tcg_temp_new_i32(), inc = tcg_temp_new_i32();
    TCGLabel *skip = p2_gen_cond(ctx, a->cond);

    p2_ld_cog(d, a->d);
    p2_get_s(sv, a->i, a->s);
    tcg_gen_addi_i32(inc, d, 1);
    tcg_gen_movcond_i32(TCG_COND_EQ, r, d, sv, tcg_constant_i32(0), inc);
    if (a->c) {
        TCGv_i32 cf = tcg_temp_new_i32();
        tcg_gen_setcond_i32(TCG_COND_EQ, cf, d, sv);
        tcg_gen_st_i32(cf, tcg_env, offsetof(CPUP2State, c));
    }
    p2_st_cog(r, a->d);
    p2_set_z(r, a->z);
    p2_end_cond(skip);
    return true;
}

static bool trans_decmod(DisasContext *ctx, arg_ds *a)
{
    TCGv_i32 d = tcg_temp_new_i32(), sv = tcg_temp_new_i32();
    TCGv_i32 r = tcg_temp_new_i32(), dec = tcg_temp_new_i32();
    TCGLabel *skip = p2_gen_cond(ctx, a->cond);

    p2_ld_cog(d, a->d);
    p2_get_s(sv, a->i, a->s);
    tcg_gen_subi_i32(dec, d, 1);
    tcg_gen_movcond_i32(TCG_COND_EQ, r, d, tcg_constant_i32(0), sv, dec);
    if (a->c) {
        TCGv_i32 cf = tcg_temp_new_i32();
        tcg_gen_setcondi_i32(TCG_COND_EQ, cf, d, 0);
        tcg_gen_st_i32(cf, tcg_env, offsetof(CPUP2State, c));
    }
    p2_st_cog(r, a->d);
    p2_set_z(r, a->z);
    p2_end_cond(skip);
    return true;
}


/* ---- batch 5 ------------------------------------------------------------ */

/* NEGx negates S only when the flag says so; C is the sign of the RESULT. */
#define GEN_NEGX(NAME, FIELD, INVERT)                                         \
    static bool trans_##NAME(DisasContext *ctx, arg_ds *a)                    \
    {                                                                         \
        TCGv_i32 sv = tcg_temp_new_i32(), take = tcg_temp_new_i32();          \
        TCGv_i32 neg = tcg_temp_new_i32(), r = tcg_temp_new_i32();            \
        TCGLabel *skip = p2_gen_cond(ctx, a->cond);                           \
        p2_get_s(sv, a->i, a->s);                                             \
        tcg_gen_ld_i32(take, tcg_env, offsetof(CPUP2State, FIELD));           \
        if (INVERT) { tcg_gen_xori_i32(take, take, 1); }                      \
        tcg_gen_neg_i32(neg, sv);                                             \
        tcg_gen_movcond_i32(TCG_COND_NE, r, take, tcg_constant_i32(0),        \
                            neg, sv);                                         \
        p2_st_cog(r, a->d);                                                   \
        p2_set_flags_sign(r, a->c, a->z);                                     \
        p2_end_cond(skip);                                                    \
        return true;                                                          \
    }

GEN_NEGX(negc,  c, 0)
GEN_NEGX(negnc, c, 1)
GEN_NEGX(negz,  z, 0)
GEN_NEGX(negnz, z, 1)

/*
 * CMPSUB subtracts only if it fits, and C reports whether it did. Note Z comes
 * from the SUBTRACTION (D - S), not from the value actually written -- so a
 * non-fitting CMPSUB can leave D unchanged while still reporting Z.
 */
static bool trans_cmpsub(DisasContext *ctx, arg_ds *a)
{
    TCGv_i32 d = tcg_temp_new_i32(), sv = tcg_temp_new_i32();
    TCGv_i32 diff = tcg_temp_new_i32(), r = tcg_temp_new_i32();
    TCGv_i32 fits = tcg_temp_new_i32();
    TCGLabel *skip = p2_gen_cond(ctx, a->cond);

    p2_ld_cog(d, a->d);
    p2_get_s(sv, a->i, a->s);
    tcg_gen_sub_i32(diff, d, sv);
    tcg_gen_setcond_i32(TCG_COND_GEU, fits, d, sv);
    tcg_gen_movcond_i32(TCG_COND_NE, r, fits, tcg_constant_i32(0), diff, d);
    if (a->c) {
        tcg_gen_st_i32(fits, tcg_env, offsetof(CPUP2State, c));
    }
    p2_st_cog(r, a->d);
    p2_set_z(diff, a->z);            /* Z from D - S, not from the result */
    p2_end_cond(skip);
    return true;
}


/* ---- batch 6: rotate-through-carry and the bit-span family ---------------- */

/*
 * The BITx span: S[4:0] is the base bit and S[9:5]+1 the count, and the span
 * wraps at bit 31 -- so the mask is a rotate, not a shift. The count reaches
 * 32, which is why the run of ones is built in 64 bits before it is narrowed.
 */
static void p2_span_mask(TCGv_i32 mask, TCGv_i32 sv)
{
    TCGv_i32 base = tcg_temp_new_i32(), cnt = tcg_temp_new_i32();
    TCGv_i64 w = tcg_temp_new_i64(), c64 = tcg_temp_new_i64();

    tcg_gen_andi_i32(base, sv, 31);
    tcg_gen_shri_i32(cnt, sv, 5);
    tcg_gen_andi_i32(cnt, cnt, 31);
    tcg_gen_addi_i32(cnt, cnt, 1);
    tcg_gen_extu_i32_i64(c64, cnt);
    tcg_gen_movi_i64(w, 1);
    tcg_gen_shl_i64(w, w, c64);
    tcg_gen_subi_i64(w, w, 1);
    tcg_gen_extrl_i64_i32(mask, w);
    tcg_gen_rotl_i32(mask, mask, base);
}

/*
 * RCL/RCR rotate C *through* D: the vacated bits all fill with copies of the
 * incoming C, and C takes the last bit shifted out. The boot ROM assembles
 * pin samples with RCL x,#1, so this is on the SPI receive path.
 *
 * At n == 0 the fill is (1 << 0) - 1 = 0, so the result degenerates to D on
 * its own; only the C output needs the n == 0 special case.
 */
#define GEN_RCX(NAME, LEFT)                                                   \
    static bool trans_##NAME(DisasContext *ctx, arg_ds *a)                    \
    {                                                                         \
        TCGv_i32 d = tcg_temp_new_i32(), sv = tcg_temp_new_i32();             \
        TCGv_i32 n = tcg_temp_new_i32(), cf = tcg_temp_new_i32();             \
        TCGv_i32 fill = tcg_temp_new_i32(), r = tcg_temp_new_i32();           \
        TCGv_i32 out = tcg_temp_new_i32(), t = tcg_temp_new_i32();            \
        TCGv_i32 zero = tcg_constant_i32(0);                                  \
        TCGLabel *skip = p2_gen_cond(ctx, a->cond);                           \
                                                                              \
        p2_ld_cog(d, a->d);                                                   \
        p2_get_s(sv, a->i, a->s);                                             \
        tcg_gen_andi_i32(n, sv, 31);                                          \
        tcg_gen_ld_i32(cf, tcg_env, offsetof(CPUP2State, c));                 \
        tcg_gen_shl_i32(fill, tcg_constant_i32(1), n);                        \
        tcg_gen_subi_i32(fill, fill, 1);                                      \
        tcg_gen_movcond_i32(TCG_COND_NE, fill, cf, zero, fill, zero);         \
        tcg_gen_sub_i32(t, tcg_constant_i32(32), n);                          \
        tcg_gen_andi_i32(t, t, 31);                                           \
        if (LEFT) {                                                           \
            tcg_gen_shl_i32(r, d, n);                                         \
            tcg_gen_or_i32(r, r, fill);                                       \
            tcg_gen_shr_i32(out, d, t);      /* bit 32-n, the last one out */ \
        } else {                                                              \
            tcg_gen_shr_i32(r, d, n);                                         \
            tcg_gen_shl_i32(t, fill, t);                                      \
            tcg_gen_or_i32(r, r, t);                                          \
            tcg_gen_subi_i32(t, n, 1);                                        \
            tcg_gen_andi_i32(t, t, 31);                                       \
            tcg_gen_shr_i32(out, d, t);                                       \
        }                                                                     \
        tcg_gen_andi_i32(out, out, 1);                                        \
        tcg_gen_movcond_i32(TCG_COND_EQ, out, n, zero, cf, out);              \
        p2_st_cog(r, a->d);                                                   \
        p2_set_z(r, a->z);                                                    \
        if (a->c) {                                                           \
            tcg_gen_st_i32(out, tcg_env, offsetof(CPUP2State, c));            \
        }                                                                     \
        p2_end_cond(skip);                                                    \
        return true;                                                          \
    }

GEN_RCX(rcl, 1)
GEN_RCX(rcr, 0)

/*
 * BITL/BITH clear or set the span. Their WC/WZ/WCZ encodings are promoted to
 * TESTB/TESTBN by the decoder, so only the flag-less form can reach here; a
 * flagged one would be a decoder bug, and refusing it halts rather than
 * quietly writing the wrong thing.
 */
static bool p2_gen_bitspan(DisasContext *ctx, arg_ds *a, bool set)
{
    TCGv_i32 d = tcg_temp_new_i32(), sv = tcg_temp_new_i32();
    TCGv_i32 mask = tcg_temp_new_i32();
    TCGLabel *skip;

    if (a->c || a->z) {
        return false;
    }
    skip = p2_gen_cond(ctx, a->cond);
    p2_ld_cog(d, a->d);
    p2_get_s(sv, a->i, a->s);
    p2_span_mask(mask, sv);
    if (set) {
        tcg_gen_or_i32(d, d, mask);
    } else {
        tcg_gen_andc_i32(d, d, mask);
    }
    p2_st_cog(d, a->d);
    p2_end_cond(skip);
    return true;
}

static bool trans_bitl(DisasContext *ctx, arg_ds *a)
{
    return p2_gen_bitspan(ctx, a, false);
}

static bool trans_bith(DisasContext *ctx, arg_ds *a)
{
    return p2_gen_bitspan(ctx, a, true);
}

/*
 * TESTB/TESTBN report D[S[4:0]] into C and/or Z -- except under WCZ, which is
 * not a test at all but the bit-write form: TESTB clears the span, TESTBN sets
 * it, and BOTH flags take the ORIGINAL bit, un-inverted. (P2-EVAL confirmed
 * this: TESTBN D,S WCZ with D=80000000 returned d=80000002 c=0 z=0.)
 *
 * C and Z are fixed by the encoding, so the shape is chosen at translate time.
 */
static bool p2_gen_testb(DisasContext *ctx, arg_ds *a, bool invert)
{
    TCGv_i32 d = tcg_temp_new_i32(), sv = tcg_temp_new_i32();
    TCGv_i32 base = tcg_temp_new_i32(), bit = tcg_temp_new_i32();
    TCGLabel *skip = p2_gen_cond(ctx, a->cond);

    p2_ld_cog(d, a->d);
    p2_get_s(sv, a->i, a->s);
    tcg_gen_andi_i32(base, sv, 31);
    tcg_gen_shr_i32(bit, d, base);
    tcg_gen_andi_i32(bit, bit, 1);

    if (a->c && a->z) {
        TCGv_i32 mask = tcg_temp_new_i32();
        p2_span_mask(mask, sv);
        if (invert) {
            tcg_gen_or_i32(d, d, mask);
        } else {
            tcg_gen_andc_i32(d, d, mask);
        }
        p2_st_cog(d, a->d);
        tcg_gen_st_i32(bit, tcg_env, offsetof(CPUP2State, c));
        tcg_gen_st_i32(bit, tcg_env, offsetof(CPUP2State, z));
    } else {
        if (invert) {
            tcg_gen_xori_i32(bit, bit, 1);
        }
        if (a->c) {
            tcg_gen_st_i32(bit, tcg_env, offsetof(CPUP2State, c));
        }
        if (a->z) {
            tcg_gen_st_i32(bit, tcg_env, offsetof(CPUP2State, z));
        }
    }
    p2_end_cond(skip);
    return true;
}

#define GEN_TESTB(NAME, INVERT)                                               \
    static bool trans_##NAME(DisasContext *ctx, arg_ds *a)                    \
    {                                                                         \
        return p2_gen_testb(ctx, a, INVERT);                                  \
    }

GEN_TESTB(testb,    false)
GEN_TESTB(testb_2,  false)
GEN_TESTB(testb_3,  false)
GEN_TESTB(testbn,   true)
GEN_TESTB(testbn_2, true)
GEN_TESTB(testbn_3, true)


/* Word 0 is NOP on silicon; the clock is charged before decode, as for any
 * cancelled instruction. */
static bool trans_nop_zero(DisasContext *ctx, arg_nop_zero *a)
{
    return true;
}

/* ---- batch 7: control flow and the hardware stack ------------------------ */

/*
 * Every branch ends the translation block. goto_tb chaining is deliberately
 * not used yet: hub RAM is writable and the cog's own code lives in it, so
 * chaining needs the invalidation story settled first. Spike 0d measured a TB
 * exit at 53.5 ns, which is the standing cost of this decision.
 */
static void p2_gen_goto(DisasContext *ctx, TCGv_i32 target)
{
    tcg_gen_st_i32(target, tcg_env, offsetof(CPUP2State, pc));
    tcg_gen_exit_tb(NULL, 0);
    ctx->branched = true;
}

/* An unconditional branch makes everything after it in this block dead. */
static void p2_end_branch(DisasContext *ctx, TCGLabel *skip)
{
    if (skip) {
        gen_set_label(skip);
    } else {
        ctx->base.is_jmp = DISAS_NORETURN;
    }
}

/*
 * _RET_ (EEEE = %0000) means: run the instruction, then return. A branching
 * instruction that actually branched swallows it -- but DJNZ and friends only
 * branch sometimes, so their not-taken path still has to return. flexspin
 * writes `_ret_ djnz` for exactly that shape.
 */
static void p2_gen_ret_prefix(DisasContext *ctx, int cond)
{
    TCGv_i32 t;

    if (cond != 0) {
        return;
    }
    t = tcg_temp_new_i32();
    gen_helper_p2_pop(t, tcg_env);
    tcg_gen_st_i32(t, tcg_env, offsetof(CPUP2State, pc));
    tcg_gen_exit_tb(NULL, 0);
    ctx->base.is_jmp = DISAS_NORETURN;
}

/*
 * The 20-bit branch form: R selects PC-relative over absolute. The
 * displacement is a BYTE count, and both forms resolve at translate time.
 */
static uint32_t p2_rel20_target(DisasContext *ctx, arg_rel *a)
{
    if (a->r) {
        int32_t disp = ((int32_t)(a->imm << 12)) >> 12;
        return ctx->base.pc_next + disp;
    }
    return a->imm & 0xFFFFF;
}

static bool trans_jmp_3(DisasContext *ctx, arg_rel *a)
{
    TCGLabel *skip = p2_gen_cond(ctx, a->cond);
    p2_gen_goto(ctx, tcg_constant_i32(p2_rel20_target(ctx, a)));
    p2_end_branch(ctx, skip);
    return true;
}

static bool trans_call_2(DisasContext *ctx, arg_rel *a)
{
    TCGLabel *skip = p2_gen_cond(ctx, a->cond);
    gen_helper_p2_push(tcg_env, tcg_constant_i32(ctx->base.pc_next));
    p2_gen_goto(ctx, tcg_constant_i32(p2_rel20_target(ctx, a)));
    p2_end_branch(ctx, skip);
    return true;
}

/*
 * The misc-block forms take their target from D -- a register at L=0 and a
 * 9-bit literal at L=1, which the decoder has already split into two patterns.
 */
#define GEN_JUMPD(NAME, LITERAL, CALL)                                        \
    static bool trans_##NAME(DisasContext *ctx, arg_misc *a)                  \
    {                                                                         \
        TCGv_i32 t = tcg_temp_new_i32();                                      \
        TCGLabel *skip = p2_gen_cond(ctx, a->cond);                           \
        if (LITERAL) {                                                        \
            tcg_gen_movi_i32(t, a->d);                                        \
        } else {                                                              \
            p2_ld_cog(t, a->d);                                               \
        }                                                                     \
        if (CALL) {                                                           \
            gen_helper_p2_push(tcg_env, tcg_constant_i32(ctx->base.pc_next)); \
        }                                                                     \
        p2_gen_goto(ctx, t);                                                  \
        p2_end_branch(ctx, skip);                                             \
        return true;                                                          \
    }

GEN_JUMPD(jmp,    0, 0)
GEN_JUMPD(jmp_2,  1, 0)
GEN_JUMPD(call,   0, 1)

/* RET is the L=1 encoding of CALL: no target field, just a pop. */
static bool trans_ret(DisasContext *ctx, arg_misc *a)
{
    TCGv_i32 t = tcg_temp_new_i32();
    TCGLabel *skip = p2_gen_cond(ctx, a->cond);

    gen_helper_p2_pop(t, tcg_env);
    p2_gen_goto(ctx, t);
    p2_end_branch(ctx, skip);
    return true;
}

/* JMPREL steps D *instructions* from the next PC -- four bytes each in hub. */
#define GEN_JMPREL(NAME, LITERAL)                                             \
    static bool trans_##NAME(DisasContext *ctx, arg_misc *a)                  \
    {                                                                         \
        TCGv_i32 t = tcg_temp_new_i32();                                      \
        TCGLabel *skip = p2_gen_cond(ctx, a->cond);                           \
        if (LITERAL) {                                                        \
            tcg_gen_movi_i32(t, a->d);                                        \
        } else {                                                              \
            p2_ld_cog(t, a->d);                                               \
        }                                                                     \
        tcg_gen_shli_i32(t, t, 2);                                            \
        tcg_gen_addi_i32(t, t, ctx->base.pc_next);                            \
        p2_gen_goto(ctx, t);                                                  \
        p2_end_branch(ctx, skip);                                             \
        return true;                                                          \
    }

GEN_JMPREL(jmprel,   0)
GEN_JMPREL(jmprel_2, 1)

/* PUSH/POP share that same stack -- they are not a hub-memory stack. */
static bool trans_push(DisasContext *ctx, arg_misc *a)
{
    TCGv_i32 d = tcg_temp_new_i32();
    TCGLabel *skip = p2_gen_cond(ctx, a->cond);

    p2_ld_cog(d, a->d);
    gen_helper_p2_push(tcg_env, d);
    p2_end_cond(skip);
    return true;
}

static bool trans_pop(DisasContext *ctx, arg_misc *a)
{
    TCGv_i32 t = tcg_temp_new_i32();
    TCGLabel *skip = p2_gen_cond(ctx, a->cond);

    gen_helper_p2_pop(t, tcg_env);
    p2_st_cog(t, a->d);
    p2_set_z(t, a->z);
    p2_end_cond(skip);
    return true;
}

/*
 * The *sj forms (DJNZ/TJZ/CALLPA/...) take a SIGNED 9-bit offset in
 * INSTRUCTIONS when S is an immediate, and an absolute address when S is a
 * register -- `callpa #n,fcache_load_ptr_` is the register form.
 */
static void p2_rel9_target(DisasContext *ctx, TCGv_i32 dst, arg_ds *a)
{
    if (a->i) {
        int32_t off = ((int32_t)(a->s << 23)) >> 23;
        tcg_gen_movi_i32(dst, ctx->base.pc_next + off * 4);
    } else {
        p2_ld_cog(dst, a->s);
    }
}

/* Decrement D, then branch on what it became. D is written back either way. */
#define GEN_DJX(NAME, SKIPCOND, SKIPVAL)                                      \
    static bool trans_##NAME(DisasContext *ctx, arg_ds *a)                    \
    {                                                                         \
        TCGv_i32 d = tcg_temp_new_i32(), t = tcg_temp_new_i32();              \
        TCGLabel *skip = p2_gen_cond(ctx, a->cond);                           \
        TCGLabel *no = gen_new_label();                                       \
        p2_ld_cog(d, a->d);                                                   \
        tcg_gen_subi_i32(d, d, 1);                                            \
        p2_st_cog(d, a->d);                                                   \
        tcg_gen_brcondi_i32(SKIPCOND, d, SKIPVAL, no);                        \
        p2_rel9_target(ctx, t, a);                                            \
        p2_gen_goto(ctx, t);                                                  \
        gen_set_label(no);                                                    \
        p2_gen_ret_prefix(ctx, a->cond);                                      \
        p2_end_cond(skip);                                                    \
        return true;                                                          \
    }

GEN_DJX(djnz, TCG_COND_EQ, 0)
GEN_DJX(djz,  TCG_COND_NE, 0)
GEN_DJX(djf,  TCG_COND_NE, -1)
GEN_DJX(djnf, TCG_COND_EQ, -1)

/* TJZ/TJNZ test D without touching it. */
#define GEN_TJX(NAME, SKIPCOND)                                               \
    static bool trans_##NAME(DisasContext *ctx, arg_ds *a)                    \
    {                                                                         \
        TCGv_i32 d = tcg_temp_new_i32(), t = tcg_temp_new_i32();              \
        TCGLabel *skip = p2_gen_cond(ctx, a->cond);                           \
        TCGLabel *no = gen_new_label();                                       \
        p2_ld_cog(d, a->d);                                                   \
        tcg_gen_brcondi_i32(SKIPCOND, d, 0, no);                              \
        p2_rel9_target(ctx, t, a);                                            \
        p2_gen_goto(ctx, t);                                                  \
        gen_set_label(no);                                                    \
        p2_gen_ret_prefix(ctx, a->cond);                                      \
        p2_end_cond(skip);                                                    \
        return true;                                                          \
    }

GEN_TJX(tjz,  TCG_COND_NE)
GEN_TJX(tjnz, TCG_COND_EQ)

/* CALLPA/CALLPB stash D in PA or PB, then call the *sj target. */
#define GEN_CALLP(NAME, REG, LITERAL)                                         \
    static bool trans_##NAME(DisasContext *ctx, arg_ds *a)                    \
    {                                                                         \
        TCGv_i32 d = tcg_temp_new_i32(), t = tcg_temp_new_i32();              \
        TCGLabel *skip = p2_gen_cond(ctx, a->cond);                           \
        if (LITERAL) {                                                        \
            tcg_gen_movi_i32(d, a->d);                                        \
        } else {                                                              \
            p2_ld_cog(d, a->d);                                               \
        }                                                                     \
        p2_st_cog(d, REG);                                                    \
        gen_helper_p2_push(tcg_env, tcg_constant_i32(ctx->base.pc_next));     \
        p2_rel9_target(ctx, t, a);                                            \
        p2_gen_goto(ctx, t);                                                  \
        p2_end_branch(ctx, skip);                                             \
        return true;                                                          \
    }

GEN_CALLP(callpa,   P2_REG_PA, 0)
GEN_CALLP(callpa_2, P2_REG_PA, 1)
GEN_CALLP(callpb,   P2_REG_PB, 0)
GEN_CALLP(callpb_2, P2_REG_PB, 1)

/* CALLD D,S: D takes the return address and the jump goes to S. flexspin's
 * RETI1/RESI1 are written this way. */
static bool trans_calld(DisasContext *ctx, arg_ds *a)
{
    TCGv_i32 t = tcg_temp_new_i32();
    TCGLabel *skip = p2_gen_cond(ctx, a->cond);

    p2_st_cog(tcg_constant_i32(ctx->base.pc_next), a->d);
    p2_get_s(t, a->i, a->s);
    p2_gen_goto(ctx, t);
    p2_end_branch(ctx, skip);
    return true;
}

/* Everything the skeleton does not model yet stops the CPU rather than
 * silently doing the wrong thing -- bring-up must notice, not drift. */
static bool p2_unimpl(DisasContext *ctx)
{
    gen_helper_p2_unimpl(tcg_env, tcg_constant_i32(ctx->base.pc_next - 4));
    ctx->base.is_jmp = DISAS_NORETURN;
    return true;
}

#include "trans_stub.c.inc"

/* -------------------------------------------------------------- translator */
static void p2_tr_init_disas_context(DisasContextBase *dcbase, CPUState *cs)
{
    DisasContext *ctx = container_of(dcbase, DisasContext, base);
    ctx->env = cpu_env(cs);
    ctx->alt_pending = false;
}

static void p2_tr_tb_start(DisasContextBase *db, CPUState *cs) { }

static void p2_tr_insn_start(DisasContextBase *dcbase, CPUState *cs)
{
    tcg_gen_insn_start(dcbase->pc_next);
}

static void p2_tr_translate_insn(DisasContextBase *dcbase, CPUState *cs)
{
    DisasContext *ctx = container_of(dcbase, DisasContext, base);
    uint32_t insn;

    if (dcbase->pc_next < P2_HUB_BASE) {
        /*
         * Cog space: hand a whole run to the interpreter (Spike 0b). The
         * helper sets env->pc itself, but pc_next must still advance -- a TB
         * of size 0 trips setjmp_gen_code's assert.
         */
        gen_helper_p2_interp_cog(tcg_env, tcg_constant_i32(P2_COG_RUN));
        dcbase->pc_next += 4;
        dcbase->is_jmp = DISAS_NORETURN;
        return;
    }

    insn = translator_ldl(ctx->env, dcbase, dcbase->pc_next);
    dcbase->pc_next += 4;
    p2_gen_clock();
    ctx->branched = false;

    if (!decode_p2(ctx, insn)) {
        p2_unimpl(ctx);
        return;
    }
    /* _RET_ on a non-branching instruction: it ran, now return. */
    if (!ctx->branched) {
        p2_gen_ret_prefix(ctx, (insn >> 28) & 0xF);
    }
}

static void p2_tr_tb_stop(DisasContextBase *dcbase, CPUState *cs)
{
    DisasContext *ctx = container_of(dcbase, DisasContext, base);

    switch (dcbase->is_jmp) {
    case DISAS_NORETURN:
        break;
    case DISAS_TOO_MANY:
        tcg_gen_st_i32(tcg_constant_i32(dcbase->pc_next), tcg_env,
                       offsetof(CPUP2State, pc));
        tcg_gen_exit_tb(NULL, 0);
        break;
    default:
        g_assert_not_reached();
    }
}

static const TranslatorOps p2_tr_ops = {
    .init_disas_context = p2_tr_init_disas_context,
    .tb_start           = p2_tr_tb_start,
    .insn_start         = p2_tr_insn_start,
    .translate_insn     = p2_tr_translate_insn,
    .tb_stop            = p2_tr_tb_stop,
};

void p2_cpu_translate_code(CPUState *cs, TranslationBlock *tb, int *max_insns,
                           vaddr pc, void *host_pc)
{
    DisasContext ctx = { };
    translator_loop(cs, tb, max_insns, pc, host_pc, &p2_tr_ops, &ctx.base);
}

void p2_cpu_tcg_init(void)
{
    /* Cog RAM is an env array reached by ld/st at computed offsets, not TCG
     * globals: target/avr/helper.c notes a global may be live in a host
     * register across a store, which ALTx-style indexing would break. */
}
