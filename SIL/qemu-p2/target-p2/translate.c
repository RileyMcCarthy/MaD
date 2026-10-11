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

    if (!decode_p2(ctx, insn)) {
        p2_unimpl(ctx);
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
