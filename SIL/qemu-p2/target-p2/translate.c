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
    /* Prefixes live at the START of this instruction, from the TB key. */
    uint32_t prefix;
    /* A REP is running over this block, so every instruction has to tick it. */
    bool rep_active;
    /* A SKIP pattern is live, so every instruction has to ask whether it is
     * cancelled before anything else happens -- including before it is
     * decoded. */
    bool skip_active;
    /*
     * "Will this instruction retire?", captured BEFORE the body runs, because
     * the body may change the very flags the EEEE condition is made of. Only
     * materialised when something downstream needs it: a live REP, or a
     * pending ALTx (which only a retiring instruction consumes).
     */
    TCGv_i32 retired;
    /* Set by a prefix instruction: it passes the pending set on rather than
     * consuming it. */
    bool is_prefix;
    /* Which AUG/SETQ bits survive this instruction, by p2core's rule: Q
     * survives any of the four prefixes, aug_s only AUGS, aug_d only AUGD. */
    uint32_t prefix_survives;
} DisasContext;

/* ------------------------------------------------------------- operand access
 *
 * Cog RAM lives in CPUArchState. A register whose index is known at translate
 * time is a constant env offset -- one host load -- which is the case for
 * 99.9% of instructions.
 */
/*
 * Two of the special registers are not storage.
 *
 * INA/INB ($1FE/$1FF) read the pin bus rather than the register file, and
 * DIRA/DIRB/OUTA/OUTB ($1FA..$1FD) publish to it on every write -- which is
 * what makes `mov dira, ##mask` drive pins at all. p2core does both in reg()
 * and set_reg(), so they apply to ANY access, not just to the pin
 * instructions: `test ina, #1 wz` is how a driver samples a pad.
 *
 * The index is a translate-time constant everywhere but the post-ALTx path,
 * which carries the same two checks in its helper.
 */
static void p2_ld_cog(TCGv_i32 dst, unsigned idx)
{
    unsigned i = idx & (P2_COG_LONGS - 1);

    if (i == P2_REG_INA || i == P2_REG_INB) {
        gen_helper_p2_rd_in(dst, tcg_env, tcg_constant_i32(i));
        return;
    }
    tcg_gen_ld_i32(dst, tcg_env, offsetof(CPUP2State, cog[i]));
}

static void p2_st_cog(TCGv_i32 src, unsigned idx)
{
    unsigned i = idx & (P2_COG_LONGS - 1);

    tcg_gen_st_i32(src, tcg_env, offsetof(CPUP2State, cog[i]));
    if (i >= P2_REG_DIRA && i <= P2_REG_OUTA + 1) {
        gen_helper_p2_reg_published(tcg_env, tcg_constant_i32(i), src);
    }
}

/*
 * D operand. A pending ALTD substitutes a RUNTIME register index for the
 * encoded one, so these route through a helper -- but only then: Spike 1a
 * measured post-ALTx instructions at 0.0999% of the firmware's stream, and
 * every other instruction keeps the static offset the translator folded in.
 */
static void p2_ld_d(DisasContext *ctx, TCGv_i32 dst, unsigned d)
{
    if (ctx->prefix & P2_PFX_ALTD) {
        TCGv_i32 idx = tcg_temp_new_i32();
        tcg_gen_ld_i32(idx, tcg_env, offsetof(CPUP2State, alt_d));
        gen_helper_p2_cog_rd(dst, tcg_env, idx);
    } else {
        p2_ld_cog(dst, d);
    }
}

static void p2_st_d(DisasContext *ctx, TCGv_i32 src, unsigned d)
{
    if (ctx->prefix & P2_PFX_ALTD) {
        TCGv_i32 idx = tcg_temp_new_i32();
        tcg_gen_ld_i32(idx, tcg_env, offsetof(CPUP2State, alt_d));
        gen_helper_p2_cog_wr(tcg_env, idx, src);
    } else {
        p2_st_cog(src, d);
    }
}

/*
 * S operand: an immediate when I is set, else a register -- and a pending AUGS
 * widens that immediate from 9 bits to 32. The AUGS case emits a load only
 * because it is in the TB key: with no prefix pending this is still a movi.
 */
static void p2_get_s(DisasContext *ctx, TCGv_i32 dst, int i, unsigned s)
{
    if (ctx->prefix & P2_PFX_ALTS) {
        /* ALTS always substitutes a REGISTER address, so an originally
         * immediate S must not stay immediate. */
        TCGv_i32 idx = tcg_temp_new_i32();
        tcg_gen_ld_i32(idx, tcg_env, offsetof(CPUP2State, alt_s));
        gen_helper_p2_cog_rd(dst, tcg_env, idx);
    } else if (!i) {
        p2_ld_cog(dst, s);
    } else if (ctx->prefix & P2_PFX_AUGS) {
        tcg_gen_ld_i32(dst, tcg_env, offsetof(CPUP2State, aug_s));
        tcg_gen_ori_i32(dst, dst, s);
    } else {
        tcg_gen_movi_i32(dst, s);
    }
}

/*
 * The same for the L-bit forms, whose D field is a literal AUGD widens.
 *
 * ALTD rewrites the D FIELD, and when D is a LITERAL the substituted
 * field IS the value -- p2core substitutes into `ins.d` before deciding
 * whether to read it as a register or take it as a literal. MaDCore's boot
 * does `altd / setq #0 / wrlong ptra++`, where the literal 0 becomes 2 and the
 * WRLONG is a three-long block transfer rather than a single write.
 */
static void p2_get_d_literal(DisasContext *ctx, TCGv_i32 dst, unsigned d)
{
    if (ctx->prefix & P2_PFX_ALTD) {
        tcg_gen_ld_i32(dst, tcg_env, offsetof(CPUP2State, alt_d));
        if (ctx->prefix & P2_PFX_AUGD) {
            TCGv_i32 t = tcg_temp_new_i32();

            tcg_gen_ld_i32(t, tcg_env, offsetof(CPUP2State, aug_d));
            tcg_gen_or_i32(dst, dst, t);
        }
    } else if (ctx->prefix & P2_PFX_AUGD) {
        tcg_gen_ld_i32(dst, tcg_env, offsetof(CPUP2State, aug_d));
        tcg_gen_ori_i32(dst, dst, d);
    } else {
        tcg_gen_movi_i32(dst, d);
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
static void p2_gen_cond_value(TCGv_i32 out, int cond)
{
    TCGv_i32 c, z, sel;

    if (cond == 0xF || cond == 0) {
        tcg_gen_movi_i32(out, 1);
        return;
    }
    c = tcg_temp_new_i32();
    z = tcg_temp_new_i32();
    sel = tcg_temp_new_i32();
    tcg_gen_ld_i32(c, tcg_env, offsetof(CPUP2State, c));
    tcg_gen_ld_i32(z, tcg_env, offsetof(CPUP2State, z));
    tcg_gen_shli_i32(sel, c, 1);
    tcg_gen_or_i32(sel, sel, z);
    tcg_gen_movi_i32(c, cond);
    tcg_gen_shr_i32(c, c, sel);
    tcg_gen_andi_i32(out, c, 1);
}

static TCGLabel *p2_gen_cond(DisasContext *ctx, int cond)
{
    TCGv_i32 t;
    TCGLabel *skip;

    if (cond == 0xF || cond == 0) {
        return NULL;
    }
    skip = gen_new_label();
    t = tcg_temp_new_i32();
    p2_gen_cond_value(t, cond);
    tcg_gen_brcondi_i32(TCG_COND_EQ, t, 0, skip);
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

/*
 * In the misc block bit 18 is the L bit, so it says whether D is a register or
 * a 9-bit literal -- which AUGD may then widen.
 */
static void p2_get_misc_d(DisasContext *ctx, TCGv_i32 dst, arg_misc *a)
{
    if (a->i) {
        p2_get_d_literal(ctx, dst, a->d);
    } else {
        p2_ld_d(ctx, dst, a->d);
    }
}


/* An ALU op with the shape: read D, read S, combine, write D, set flags. */
#define GEN_ALU(NAME, EXPR, FLAGS)                                            \
    static bool trans_##NAME(DisasContext *ctx, arg_ds *a)                    \
    {                                                                         \
        TCGv_i32 d = tcg_temp_new_i32();                                      \
        TCGv_i32 s = tcg_temp_new_i32();                                      \
        TCGLabel *skip = p2_gen_cond(ctx, a->cond);                           \
        p2_ld_d(ctx, d, a->d);                                                   \
        p2_get_s(ctx, s, a->i, a->s);                                              \
        EXPR;                                                                 \
        p2_st_d(ctx, d, a->d);                                                   \
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

    p2_ld_d(ctx, d, a->d);
    p2_get_s(ctx, s, a->i, a->s);
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
    p2_st_d(ctx, r, a->d);
    p2_end_cond(skip);
    return true;
}

static bool trans_sub(DisasContext *ctx, arg_ds *a)
{
    TCGv_i32 d = tcg_temp_new_i32();
    TCGv_i32 s = tcg_temp_new_i32();
    TCGv_i32 r = tcg_temp_new_i32();
    TCGLabel *skip = p2_gen_cond(ctx, a->cond);

    p2_ld_d(ctx, d, a->d);
    p2_get_s(ctx, s, a->i, a->s);
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
    p2_st_d(ctx, r, a->d);
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

    p2_ld_d(ctx, d, a->d);
    p2_get_s(ctx, sv, a->i, a->s);
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
    p2_st_d(ctx, r, a->d);
    p2_set_z(r, a->z);
    p2_end_cond(skip);
    return true;
}

/* CMP/CMPS/TEST/TESTN set flags only -- D is not written. */
static bool trans_cmp(DisasContext *ctx, arg_ds *a)
{
    TCGv_i32 d = tcg_temp_new_i32(), sv = tcg_temp_new_i32(), r = tcg_temp_new_i32();
    TCGLabel *skip = p2_gen_cond(ctx, a->cond);

    p2_ld_d(ctx, d, a->d);
    p2_get_s(ctx, sv, a->i, a->s);
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

    p2_ld_d(ctx, d, a->d);
    p2_get_s(ctx, sv, a->i, a->s);
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
        p2_ld_d(ctx, d, a->d);                                                   \
        p2_get_s(ctx, sv, a->i, a->s);                                             \
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

    p2_get_s(ctx, sv, a->i, a->s);
    tcg_gen_abs_i32(r, sv);
    if (a->c) {
        TCGv_i32 cf = tcg_temp_new_i32();
        tcg_gen_shri_i32(cf, sv, 31);                   /* sign of the INPUT */
        tcg_gen_st_i32(cf, tcg_env, offsetof(CPUP2State, c));
    }
    p2_st_d(ctx, r, a->d);
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
        p2_ld_d(ctx, d, a->d);                                                   \
        p2_get_s(ctx, sv, a->i, a->s);                                             \
        tcg_gen_andi_i32(n, sv, 31);                                          \
        OP(r, d, n);                                                          \
        if (a->c) { p2_shift_cout(d, n, LEFT); }                              \
        p2_st_d(ctx, r, a->d);                                                   \
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
        p2_ld_d(ctx, d, a->d);                                                   \
        p2_get_s(ctx, sv, a->i, a->s);                                             \
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
        p2_st_d(ctx, r, a->d);                                                   \
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
        p2_ld_d(ctx, d, a->d);                                                   \
        p2_get_s(ctx, sv, a->i, a->s);                                             \
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
        p2_st_d(ctx, r, a->d);                                                   \
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
        p2_ld_d(ctx, d, a->d);                                                   \
        p2_get_s(ctx, sv, a->i, a->s);                                             \
        tcg_gen_movcond_i32(COND, r, d, sv, sv, d);                           \
        if (a->c) {                                                           \
            TCGv_i32 cf = tcg_temp_new_i32();                                 \
            tcg_gen_setcond_i32(COND, cf, d, sv);                             \
            tcg_gen_st_i32(cf, tcg_env, offsetof(CPUP2State, c));             \
        }                                                                     \
        p2_st_d(ctx, r, a->d);                                                   \
        p2_set_z(r, a->z);                                                    \
        p2_end_cond(skip);                                                    \
        return true;                                                          \
    }

GEN_CLAMP(fge, TCG_COND_LTU)
GEN_CLAMP(fle, TCG_COND_GTU)
/*
 * FGES/FLES are the signed twins, and silicon says WC follows suit:
 * swp_fges_f353c1e1 (D=$80000000, S=1) returns D=1 C=1 where the unsigned FGE
 * on the same operands returns D=$80000000 C=0.
 */
GEN_CLAMP(fges, TCG_COND_LT)
GEN_CLAMP(fles, TCG_COND_GT)

/* DECOD has no C rule at all; ENCOD's C is "S was non-zero". */
static bool trans_decod(DisasContext *ctx, arg_ds *a)
{
    TCGv_i32 sv = tcg_temp_new_i32(), r = tcg_temp_new_i32();
    TCGLabel *skip = p2_gen_cond(ctx, a->cond);

    p2_get_s(ctx, sv, a->i, a->s);
    tcg_gen_andi_i32(r, sv, 31);
    tcg_gen_shl_i32(r, tcg_constant_i32(1), r);
    p2_st_d(ctx, r, a->d);
    p2_set_z(r, a->z);
    p2_end_cond(skip);
    return true;
}

static bool trans_encod(DisasContext *ctx, arg_ds *a)
{
    TCGv_i32 sv = tcg_temp_new_i32(), r = tcg_temp_new_i32();
    TCGLabel *skip = p2_gen_cond(ctx, a->cond);

    p2_get_s(ctx, sv, a->i, a->s);
    tcg_gen_clzi_i32(r, sv, 32);            /* 32 when S == 0 */
    tcg_gen_umin_i32(r, r, tcg_constant_i32(31));
    tcg_gen_sub_i32(r, tcg_constant_i32(31), r);
    if (a->c) {
        TCGv_i32 cf = tcg_temp_new_i32();
        tcg_gen_setcondi_i32(TCG_COND_NE, cf, sv, 0);
        tcg_gen_st_i32(cf, tcg_env, offsetof(CPUP2State, c));
    }
    p2_st_d(ctx, r, a->d);
    p2_set_z(r, a->z);
    p2_end_cond(skip);
    return true;
}

static bool trans_ones(DisasContext *ctx, arg_ds *a)
{
    TCGv_i32 sv = tcg_temp_new_i32(), r = tcg_temp_new_i32();
    TCGLabel *skip = p2_gen_cond(ctx, a->cond);

    p2_get_s(ctx, sv, a->i, a->s);
    tcg_gen_ctpop_i32(r, sv);
    p2_st_d(ctx, r, a->d);
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
        p2_ld_d(ctx, d, a->d);                                                   \
        p2_get_s(ctx, sv, a->i, a->s);                                             \
        tcg_gen_ld_i32(m, tcg_env, offsetof(CPUP2State, FIELD));              \
        if (INVERT) { tcg_gen_xori_i32(m, m, 1); }                            \
        tcg_gen_neg_i32(m, m);                  /* 1 -> ~0, 0 -> 0 */         \
        tcg_gen_andc_i32(r, d, sv);                                           \
        tcg_gen_and_i32(m, m, sv);                                            \
        tcg_gen_or_i32(r, r, m);                                              \
        p2_st_d(ctx, r, a->d);                                                   \
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

    p2_ld_d(ctx, d, a->d);
    p2_get_s(ctx, sv, a->i, a->s);
    tcg_gen_andi_i32(n, sv, 31);
    /* mask = (1 << (n+1)) - 1, and all-ones when n == 31 (no shift by 32). */
    tcg_gen_addi_i32(m, n, 1);
    tcg_gen_shl_i32(m, tcg_constant_i32(1), m);
    tcg_gen_subi_i32(m, m, 1);
    tcg_gen_movcond_i32(TCG_COND_EQ, m, n, tcg_constant_i32(31),
                        tcg_constant_i32(-1), m);
    tcg_gen_and_i32(r, d, m);
    p2_st_d(ctx, r, a->d);
    p2_set_z(r, a->z);
    p2_end_cond(skip);
    return true;
}

static bool trans_signx(DisasContext *ctx, arg_ds *a)
{
    TCGv_i32 d = tcg_temp_new_i32(), sv = tcg_temp_new_i32();
    TCGv_i32 sh = tcg_temp_new_i32(), r = tcg_temp_new_i32();
    TCGLabel *skip = p2_gen_cond(ctx, a->cond);

    p2_ld_d(ctx, d, a->d);
    p2_get_s(ctx, sv, a->i, a->s);
    tcg_gen_andi_i32(sh, sv, 31);
    tcg_gen_sub_i32(sh, tcg_constant_i32(31), sh);
    tcg_gen_shl_i32(r, d, sh);
    tcg_gen_sar_i32(r, r, sh);
    if (a->c) {
        TCGv_i32 cf = tcg_temp_new_i32();
        tcg_gen_shri_i32(cf, r, 31);
        tcg_gen_st_i32(cf, tcg_env, offsetof(CPUP2State, c));
    }
    p2_st_d(ctx, r, a->d);
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
        p2_ld_d(ctx, d, a->d);                                                   \
        p2_get_s(ctx, sv, a->i, a->s);                                             \
        tcg_gen_ld_i32(take, tcg_env, offsetof(CPUP2State, FIELD));           \
        if (INVERT) { tcg_gen_xori_i32(take, take, 1); }                      \
        /* effective addend: S, or -S when the flag says subtract */          \
        tcg_gen_neg_i32(neg, sv);                                             \
        tcg_gen_movcond_i32(TCG_COND_NE, eff, take, tcg_constant_i32(0),      \
                            neg, sv);                                         \
        tcg_gen_add_i32(r, d, eff);                                           \
        if (a->c) {                                                           \
            /*                                                                \
             * C is the sign of the TRUE result, so the widening has to        \
             * happen before the negation, not after it. Sign-extending the    \
             * 32-bit `eff` instead gets S = $80000000 wrong: its 32-bit       \
             * negation is still $80000000, so `d + eff` in 64 bits subtracts  \
             * where `d - s` adds. (Caught by the differential harness at      \
             * seed 5 once the smart-pin groups reshuffled the operand mix.)   \
             */                                                               \
            TCGv_i32 cf = tcg_temp_new_i32();                                 \
            TCGv_i64 wn = tcg_temp_new_i64(), wt = tcg_temp_new_i64();        \
            tcg_gen_ext_i32_i64(wd, d);                                       \
            tcg_gen_ext_i32_i64(ws, sv);                                      \
            tcg_gen_neg_i64(wn, ws);                                          \
            tcg_gen_extu_i32_i64(wt, take);                                   \
            tcg_gen_movcond_i64(TCG_COND_NE, ws, wt, tcg_constant_i64(0),     \
                                wn, ws);                                      \
            tcg_gen_add_i64(wd, wd, ws);                                      \
            tcg_gen_setcondi_i64(TCG_COND_LT, wd, wd, 0);                     \
            tcg_gen_extrl_i64_i32(cf, wd);                                    \
            tcg_gen_st_i32(cf, tcg_env, offsetof(CPUP2State, c));             \
        }                                                                     \
        p2_st_d(ctx, r, a->d);                                                   \
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

    p2_get_s(ctx, sv, a->i, a->s);
    tcg_gen_shri_i32(r, sv, n * 8);
    tcg_gen_andi_i32(r, r, 0xFF);
    p2_st_d(ctx, r, a->d);
    p2_end_cond(skip);
    return true;
}

/* CMPR is the reversed compare: S - D, flags only. */
static bool trans_cmpr(DisasContext *ctx, arg_ds *a)
{
    TCGv_i32 d = tcg_temp_new_i32(), sv = tcg_temp_new_i32(), r = tcg_temp_new_i32();
    TCGLabel *skip = p2_gen_cond(ctx, a->cond);

    p2_ld_d(ctx, d, a->d);
    p2_get_s(ctx, sv, a->i, a->s);
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

    p2_ld_d(ctx, d, a->d);
    p2_get_s(ctx, sv, a->i, a->s);
    tcg_gen_addi_i32(inc, d, 1);
    tcg_gen_movcond_i32(TCG_COND_EQ, r, d, sv, tcg_constant_i32(0), inc);
    if (a->c) {
        TCGv_i32 cf = tcg_temp_new_i32();
        tcg_gen_setcond_i32(TCG_COND_EQ, cf, d, sv);
        tcg_gen_st_i32(cf, tcg_env, offsetof(CPUP2State, c));
    }
    p2_st_d(ctx, r, a->d);
    p2_set_z(r, a->z);
    p2_end_cond(skip);
    return true;
}

static bool trans_decmod(DisasContext *ctx, arg_ds *a)
{
    TCGv_i32 d = tcg_temp_new_i32(), sv = tcg_temp_new_i32();
    TCGv_i32 r = tcg_temp_new_i32(), dec = tcg_temp_new_i32();
    TCGLabel *skip = p2_gen_cond(ctx, a->cond);

    p2_ld_d(ctx, d, a->d);
    p2_get_s(ctx, sv, a->i, a->s);
    tcg_gen_subi_i32(dec, d, 1);
    tcg_gen_movcond_i32(TCG_COND_EQ, r, d, tcg_constant_i32(0), sv, dec);
    if (a->c) {
        TCGv_i32 cf = tcg_temp_new_i32();
        tcg_gen_setcondi_i32(TCG_COND_EQ, cf, d, 0);
        tcg_gen_st_i32(cf, tcg_env, offsetof(CPUP2State, c));
    }
    p2_st_d(ctx, r, a->d);
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
        p2_get_s(ctx, sv, a->i, a->s);                                             \
        tcg_gen_ld_i32(take, tcg_env, offsetof(CPUP2State, FIELD));           \
        if (INVERT) { tcg_gen_xori_i32(take, take, 1); }                      \
        tcg_gen_neg_i32(neg, sv);                                             \
        tcg_gen_movcond_i32(TCG_COND_NE, r, take, tcg_constant_i32(0),        \
                            neg, sv);                                         \
        p2_st_d(ctx, r, a->d);                                                   \
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

    p2_ld_d(ctx, d, a->d);
    p2_get_s(ctx, sv, a->i, a->s);
    tcg_gen_sub_i32(diff, d, sv);
    tcg_gen_setcond_i32(TCG_COND_GEU, fits, d, sv);
    tcg_gen_movcond_i32(TCG_COND_NE, r, fits, tcg_constant_i32(0), diff, d);
    if (a->c) {
        tcg_gen_st_i32(fits, tcg_env, offsetof(CPUP2State, c));
    }
    p2_st_d(ctx, r, a->d);
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
        p2_ld_d(ctx, d, a->d);                                                   \
        p2_get_s(ctx, sv, a->i, a->s);                                             \
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
        p2_st_d(ctx, r, a->d);                                                   \
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
 * The BITx family: BITL/BITH/BITNOT/BITC/BITNC/BITZ/BITNZ.
 *
 * C and Z are not flag requests here, they choose the whole shape:
 *   C == Z  -- write the span into D, and under WCZ also report the ORIGINAL
 *              D[S[4:0]] in BOTH flags;
 *   C != Z  -- D is untouched and this is a TESTB/TESTBN-style accumulate into
 *              whichever single flag is selected.
 * (BITL/BITH never reach the second shape: the decoder promotes their WC/WZ/
 * WCZ encodings to TESTB/TESTBN outright.)
 *
 * P2-EVAL settled the accumulate being an accumulate rather than a toggle:
 * `bitnot_f4ebc1e1` (WZ only, D=$80000000) came back d=$80000000 z=1 and
 * `bitnot_f4efc001_b` (WZ only, D=$00000002) came back d=$00000002 z=0 -- a
 * toggle would have moved D in opposite directions in those two.
 *
 * Both C and Z are decode-time constants, so every choice below is made while
 * translating; nothing is selected at run time.
 */
typedef enum {
    P2_BIT_H, P2_BIT_L, P2_BIT_NOT, P2_BIT_C, P2_BIT_NC, P2_BIT_Z, P2_BIT_NZ,
} P2BitKind;

static bool p2_gen_bitx(DisasContext *ctx, arg_ds *a, P2BitKind kind)
{
    TCGv_i32 d = tcg_temp_new_i32(), sv = tcg_temp_new_i32();
    TCGv_i32 base = tcg_temp_new_i32(), bit = tcg_temp_new_i32();
    TCGLabel *skip = p2_gen_cond(ctx, a->cond);

    p2_ld_d(ctx, d, a->d);
    p2_get_s(ctx, sv, a->i, a->s);
    tcg_gen_andi_i32(base, sv, 31);
    tcg_gen_shr_i32(bit, d, base);
    tcg_gen_andi_i32(bit, bit, 1);

    if (a->c != a->z) {
        /* The accumulate form: D is left alone. */
        int flag = a->c ? offsetof(CPUP2State, c) : offsetof(CPUP2State, z);
        TCGv_i32 t = tcg_temp_new_i32(), cur = tcg_temp_new_i32();

        tcg_gen_mov_i32(t, bit);
        if (kind != P2_BIT_L && kind != P2_BIT_C && kind != P2_BIT_Z) {
            tcg_gen_xori_i32(t, t, 1);
        }
        tcg_gen_ld_i32(cur, tcg_env, flag);
        switch (kind) {
        case P2_BIT_L:
        case P2_BIT_H:
            tcg_gen_mov_i32(cur, t);
            break;
        case P2_BIT_C:
        case P2_BIT_NC:
            tcg_gen_and_i32(cur, cur, t);
            break;
        case P2_BIT_Z:
        case P2_BIT_NZ:
            tcg_gen_or_i32(cur, cur, t);
            break;
        default:                        /* BITNOT */
            tcg_gen_xor_i32(cur, cur, t);
            break;
        }
        tcg_gen_st_i32(cur, tcg_env, flag);
    } else {
        TCGv_i32 mask = tcg_temp_new_i32();

        p2_span_mask(mask, sv);
        switch (kind) {
        case P2_BIT_H:
            tcg_gen_or_i32(d, d, mask);
            break;
        case P2_BIT_L:
            tcg_gen_andc_i32(d, d, mask);
            break;
        case P2_BIT_NOT:
            tcg_gen_xor_i32(d, d, mask);
            break;
        default: {
            /* BITC/BITNC set the span when C matches, BITZ/BITNZ when Z does;
             * otherwise they clear it. */
            int flag = (kind == P2_BIT_C || kind == P2_BIT_NC)
                       ? offsetof(CPUP2State, c) : offsetof(CPUP2State, z);
            int want = (kind == P2_BIT_C || kind == P2_BIT_Z);
            TCGv_i32 fl = tcg_temp_new_i32();
            TCGv_i32 set = tcg_temp_new_i32(), clr = tcg_temp_new_i32();

            tcg_gen_ld_i32(fl, tcg_env, flag);
            tcg_gen_or_i32(set, d, mask);
            tcg_gen_andc_i32(clr, d, mask);
            tcg_gen_movcond_i32(TCG_COND_EQ, d, fl, tcg_constant_i32(want),
                                set, clr);
            break;
        }
        }
        p2_st_d(ctx, d, a->d);
        if (a->c && a->z) {
            tcg_gen_st_i32(bit, tcg_env, offsetof(CPUP2State, c));
            tcg_gen_st_i32(bit, tcg_env, offsetof(CPUP2State, z));
        }
    }
    p2_end_cond(skip);
    return true;
}

#define GEN_BITX(NAME, KIND)                                                  \
    static bool trans_##NAME(DisasContext *ctx, arg_ds *a)                    \
    {                                                                         \
        return p2_gen_bitx(ctx, a, KIND);                                     \
    }

GEN_BITX(bith,   P2_BIT_H)
GEN_BITX(bitl,   P2_BIT_L)
GEN_BITX(bitnot, P2_BIT_NOT)
GEN_BITX(bitc,   P2_BIT_C)
GEN_BITX(bitnc,  P2_BIT_NC)
GEN_BITX(bitz,   P2_BIT_Z)
GEN_BITX(bitnz,  P2_BIT_NZ)

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

    p2_ld_d(ctx, d, a->d);
    p2_get_s(ctx, sv, a->i, a->s);
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
        p2_st_d(ctx, d, a->d);
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
/*
 * Leave the translation block. A live REP is ticked on the way out: it tests
 * the PC the instruction just produced, so it has to see the branch target as
 * much as the fall-through.
 */
static void p2_gen_exit(DisasContext *ctx)
{
    if (ctx->rep_active) {
        /*
         * p2core reaches tick_rep only at the very END of a step, which the
         * EEEE-false path and the SKIP-cancelled path both return before. So a
         * REP block whose last slot is cancelled runs the instruction AFTER
         * the block and wraps from there -- one extra instruction and two
         * extra clocks per iteration. Ticking unconditionally here skipped it.
         */
        TCGLabel *no_tick = gen_new_label();

        tcg_gen_brcondi_i32(TCG_COND_EQ, ctx->retired, 0, no_tick);
        gen_helper_p2_tick_rep(tcg_env);
        gen_set_label(no_tick);
    }
    tcg_gen_exit_tb(NULL, 0);
}

/*
 * Every pending prefix is consumed by an instruction that RETIRES -- and a
 * branch leaves the block from inside its own body, so the generic clear
 * further down would be emitted after the exit and never run. That left a SETQ
 * live into the next block, which is how the firmware's own `SETQ / COGINIT`
 * idiom turned the following RDLONG into a block transfer.
 *
 * ALTD/ALTS go with them: p2core takes those in the operand resolution, which
 * sits AFTER the condition check, so they are consumed by any instruction that
 * retires -- a prefix instruction included, which is what makes
 * `altd / setq / wrlong` substitute into the SETQ and not the WRLONG.
 */
static void p2_gen_consume_prefix(DisasContext *ctx)
{
    if (ctx->prefix) {
        tcg_gen_st_i32(tcg_constant_i32(0), tcg_env,
                       offsetof(CPUP2State, prefix));
    }
}

static void p2_gen_goto(DisasContext *ctx, TCGv_i32 target)
{
    p2_gen_consume_prefix(ctx);
    tcg_gen_st_i32(target, tcg_env, offsetof(CPUP2State, pc));
    p2_gen_exit(ctx);
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
    p2_gen_consume_prefix(ctx);
    gen_helper_p2_pop(t, tcg_env);
    tcg_gen_st_i32(t, tcg_env, offsetof(CPUP2State, pc));
    p2_gen_exit(ctx);
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

    p2_ld_d(ctx, d, a->d);
    gen_helper_p2_push(tcg_env, d);
    p2_end_cond(skip);
    return true;
}

static bool trans_pop(DisasContext *ctx, arg_misc *a)
{
    TCGv_i32 t = tcg_temp_new_i32();
    TCGLabel *skip = p2_gen_cond(ctx, a->cond);

    gen_helper_p2_pop(t, tcg_env);
    p2_st_d(ctx, t, a->d);
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
        p2_ld_d(ctx, d, a->d);                                                   \
        tcg_gen_subi_i32(d, d, 1);                                            \
        p2_st_d(ctx, d, a->d);                                                   \
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
        p2_ld_d(ctx, d, a->d);                                                   \
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
            p2_ld_d(ctx, d, a->d);                                               \
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

    p2_st_d(ctx, tcg_constant_i32(ctx->base.pc_next), a->d);
    p2_get_s(ctx, t, a->i, a->s);
    p2_gen_goto(ctx, t);
    p2_end_branch(ctx, skip);
    return true;
}


/* ---- batch 8: hub memory ------------------------------------------------- */

/*
 * A hub instruction's immediate S can be a PTRA/PTRB expression rather than an
 * address: %1_S_U_P_IIIII, where bit 7 picks the pointer, bit 6 writes it back,
 * bit 5 selects PRE (clear) or POST (set) modify, and the signed 5-bit index is
 * scaled by the transfer size. Everything but the pointer's value is known at
 * translate time.
 *
 * (Bit 5 clear = PRE was verified against the kernel: `ptra++` encodes S=$161
 * with bit 5 set, `--ptra` encodes S=$15F with it clear.)
 */
static void p2_hub_addr(DisasContext *ctx, TCGv_i32 dst, arg_ds *a, int scale)
{
    unsigned s = a->s;
    unsigned reg;
    int32_t idx;
    TCGv_i32 mod;

    if (!a->i) {
        p2_ld_cog(dst, s);
        return;
    }
    if (!(s & 0x100) || (ctx->prefix & P2_PFX_AUGS)) {
        p2_get_s(ctx, dst, 1, s);
        return;
    }
    reg = (s & 0x80) ? P2_REG_PTRB : P2_REG_PTRA;
    idx = (((int32_t)(s & 0x1F)) << 27 >> 27) * scale;
    mod = tcg_temp_new_i32();

    p2_ld_cog(dst, reg);
    tcg_gen_addi_i32(mod, dst, idx);
    if (!(s & 0x20)) {              /* PRE-modify: the access uses the new value */
        tcg_gen_mov_i32(dst, mod);
    }
    if (s & 0x40) {                 /* ...and U writes the pointer back */
        p2_st_cog(mod, reg);
    }
}

/* Hub access costs nine clocks on top of the instruction's own two -- and only
 * when the instruction is not cancelled, which is why this sits inside the
 * EEEE-gated body rather than beside p2_gen_clock(). */
static void p2_gen_hub_clock(void)
{
    TCGv_i64 t = tcg_temp_new_i64();
    tcg_gen_ld_i64(t, tcg_env, offsetof(CPUP2State, clocks));
    tcg_gen_addi_i64(t, t, P2_CLOCKS_HUB_ACCESS);
    tcg_gen_st_i64(t, tcg_env, offsetof(CPUP2State, clocks));
}

/*
 * RDBYTE/RDWORD/RDLONG zero-extend into D. WC takes the MSB of the TRANSFER,
 * not of the zero-extended register -- silicon read $9C9C with WC and set C,
 * read $489C and cleared it, and bit 31 is clear in both.
 */
#define GEN_HUB_LD(NAME, MEMOP, SCALE)                                        \
    static bool trans_##NAME(DisasContext *ctx, arg_ds *a)                    \
    {                                                                         \
        TCGv_i32 addr = tcg_temp_new_i32(), v = tcg_temp_new_i32();           \
        TCGLabel *skip = p2_gen_cond(ctx, a->cond);                           \
        p2_hub_addr(ctx, addr, a, SCALE);                                     \
        p2_gen_hub_clock();                                                   \
        tcg_gen_andi_i32(addr, addr, P2_HUB_MASK);                            \
        tcg_gen_qemu_ld_i32(v, addr, 0, MEMOP);                               \
        p2_st_d(ctx, v, a->d);                                                   \
        p2_set_z(v, a->z);                                                    \
        if (a->c) {                                                           \
            TCGv_i32 t = tcg_temp_new_i32();                                  \
            tcg_gen_shri_i32(t, v, SCALE * 8 - 1);                            \
            tcg_gen_andi_i32(t, t, 1);                                        \
            tcg_gen_st_i32(t, tcg_env, offsetof(CPUP2State, c));              \
        }                                                                     \
        p2_end_cond(skip);                                                    \
        return true;                                                          \
    }

GEN_HUB_LD(rdbyte, MO_UB,   1)
GEN_HUB_LD(rdword, MO_TEUW, 2)
GEN_HUB_LD(rdlong_one, MO_TEUL, 4)

/*
 * SETQ (or SETQ2) turns RDLONG into a block transfer, which writes no flags
 * and whose PTR expression advances by the whole block -- so the count, a
 * register, has to be known before the address can be formed. The helper does
 * all of it. With no SETQ pending this is the plain load, unchanged.
 */
static bool trans_rdlong(DisasContext *ctx, arg_ds *a)
{
    TCGLabel *skip;

    if (!(ctx->prefix & (P2_PFX_SETQ | P2_PFX_SETQ2))) {
        return trans_rdlong_one(ctx, a);
    }
    skip = p2_gen_cond(ctx, a->cond);
    gen_helper_p2_block_rdlong(tcg_env, tcg_constant_i32(a->s),
                               tcg_constant_i32(a->i), tcg_constant_i32(a->d));
    p2_end_cond(skip);
    return true;
}

/* WRBYTE/WRWORD/WRLONG write D and touch no flags; bit 19 is the L bit here,
 * not WZ, so the decoder has already split the two D forms into patterns. */
#define GEN_HUB_ST(NAME, MEMOP, SCALE, LITERAL)                               \
    static bool trans_##NAME(DisasContext *ctx, arg_ds *a)                    \
    {                                                                         \
        TCGv_i32 addr = tcg_temp_new_i32(), v = tcg_temp_new_i32();           \
        TCGLabel *skip = p2_gen_cond(ctx, a->cond);                           \
        if (LITERAL) {                                                        \
            p2_get_d_literal(ctx, v, a->d);                                   \
        } else {                                                              \
            p2_ld_d(ctx, v, a->d);                                               \
        }                                                                     \
        p2_hub_addr(ctx, addr, a, SCALE);                                     \
        p2_gen_hub_clock();                                                   \
        tcg_gen_andi_i32(addr, addr, P2_HUB_MASK);                            \
        tcg_gen_qemu_st_i32(v, addr, 0, MEMOP);                               \
        p2_end_cond(skip);                                                    \
        return true;                                                          \
    }

GEN_HUB_ST(wrbyte,   MO_UB,   1, 0)
GEN_HUB_ST(wrbyte_2, MO_UB,   1, 1)
GEN_HUB_ST(wrword,   MO_TEUW, 2, 0)
GEN_HUB_ST(wrword_2, MO_TEUW, 2, 1)
GEN_HUB_ST(wrlong_one,   MO_TEUL, 4, 0)
GEN_HUB_ST(wrlong_2_one, MO_TEUL, 4, 1)

#define GEN_BLOCK_ST(NAME, LITERAL)                                           \
    static bool trans_##NAME(DisasContext *ctx, arg_ds *a)                    \
    {                                                                         \
        TCGLabel *skip;                                                       \
        if (!(ctx->prefix & P2_PFX_SETQ)) {                                   \
            return trans_##NAME##_one(ctx, a);                                \
        }                                                                     \
        skip = p2_gen_cond(ctx, a->cond);                                     \
        gen_helper_p2_block_wrlong(tcg_env, tcg_constant_i32(a->s),           \
                                   tcg_constant_i32(a->i),                    \
                                   tcg_constant_i32(((LITERAL) << 16) | a->d)); \
        p2_end_cond(skip);                                                    \
        return true;                                                          \
    }

GEN_BLOCK_ST(wrlong,   0)
GEN_BLOCK_ST(wrlong_2, 1)


/* ---- batch 9: prefixes, GETCT, REV --------------------------------------- */

/*
 * AUGS/AUGD carry the top 23 bits of a 32-bit literal for the NEXT
 * instruction, and they CAN be conditional -- MaDCore's own image has an
 * `if_nc augs` 200k instructions into its boot, which is what disproved the
 * earlier assumption that flexspin never emits one.
 *
 * Whether the prefix ends up pending is then a runtime answer, and the TB key
 * cannot hold both. So a conditional prefix writes env->prefix itself, on both
 * paths, and ends the block: the next one is keyed from what actually
 * happened. Note the not-taken path is not a no-op -- a cancelled instruction
 * still CONSUMES pending prefixes, by the same kind-aware rule.
 */
#define GEN_PREFIX_TAIL(BIT, KEEPMASK)                                        \
    do {                                                                      \
        uint32_t keep = ctx->prefix & (KEEPMASK);                             \
        (void)0;                                                              \
        if (a->cond != 0xF && a->cond != 0) {                                 \
            ctx->prefix = keep;             /* the epilogue must not store */ \
            ctx->is_prefix = true;                                            \
            if (ctx->base.is_jmp == DISAS_NEXT) {                             \
                ctx->base.is_jmp = DISAS_TOO_MANY;                            \
            }                                                                 \
        } else {                                                              \
            ctx->prefix = keep | (BIT);                                       \
            ctx->is_prefix = true;                                            \
        }                                                                     \
    } while (0)

#define GEN_AUG(NAME, FIELD, BIT)                                             \
    static bool trans_##NAME(DisasContext *ctx, arg_aug *a)                   \
    {                                                                         \
        uint32_t mask = P2_PFX_SETQ | P2_PFX_SETQ2 | (BIT);                   \
        uint32_t keep = ctx->prefix & mask;                                   \
        uint32_t kept_cancelled = ctx->prefix                                 \
                                  & (mask | P2_PFX_ALTD | P2_PFX_ALTS);       \
        TCGLabel *skip;                                                       \
        ctx->prefix_survives = P2_PFX_SETQ | P2_PFX_SETQ2 | (BIT);            \
        if (a->cond != 0xF && a->cond != 0) {                                 \
            /* the not-taken path consumes by the same rule, but keeps ALTx */ \
            tcg_gen_st_i32(tcg_constant_i32(kept_cancelled), tcg_env,         \
                           offsetof(CPUP2State, prefix));                     \
        }                                                                     \
        skip = p2_gen_cond(ctx, a->cond);                                     \
        tcg_gen_st_i32(tcg_constant_i32(a->imm << 9), tcg_env,                \
                       offsetof(CPUP2State, FIELD));                          \
        if (a->cond != 0xF && a->cond != 0) {                                 \
            tcg_gen_st_i32(tcg_constant_i32(keep | (BIT)), tcg_env,           \
                           offsetof(CPUP2State, prefix));                     \
        }                                                                     \
        p2_end_cond(skip);                                                    \
        GEN_PREFIX_TAIL(BIT, mask);                                           \
        return true;                                                          \
    }

GEN_AUG(augs, aug_s, P2_PFX_AUGS)
GEN_AUG(augd, aug_d, P2_PFX_AUGD)

/*
 * SETQ arms the next RDLONG/WRLONG/COGINIT with a block count. SETQ2 is the
 * same prefix aimed at LUT RAM instead of the register file -- folding the two
 * together let the boot ROM's LUT load overwrite the cog registers it had just
 * copied into place.
 */
#define GEN_SETQ(NAME, BIT)                                                   \
    static bool trans_##NAME(DisasContext *ctx, arg_misc *a)                  \
    {                                                                         \
        uint32_t mask = P2_PFX_SETQ | P2_PFX_SETQ2;                           \
        uint32_t keep = ctx->prefix & mask;                                   \
        uint32_t kept_cancelled = ctx->prefix                                 \
                                  & (mask | P2_PFX_ALTD | P2_PFX_ALTS);       \
        TCGv_i32 d = tcg_temp_new_i32();                                      \
        TCGLabel *skip;                                                       \
        ctx->prefix_survives = P2_PFX_SETQ | P2_PFX_SETQ2;                    \
        if (a->cond != 0xF && a->cond != 0) {                                 \
            tcg_gen_st_i32(tcg_constant_i32(kept_cancelled), tcg_env,         \
                           offsetof(CPUP2State, prefix));                     \
        }                                                                     \
        skip = p2_gen_cond(ctx, a->cond);                                     \
        p2_get_misc_d(ctx, d, a);                                             \
        tcg_gen_st_i32(d, tcg_env, offsetof(CPUP2State, setq));               \
        if (a->cond != 0xF && a->cond != 0) {                                 \
            tcg_gen_st_i32(tcg_constant_i32(keep | (BIT)), tcg_env,           \
                           offsetof(CPUP2State, prefix));                     \
        }                                                                     \
        p2_end_cond(skip);                                                    \
        GEN_PREFIX_TAIL(BIT, mask);                                           \
        return true;                                                          \
    }

GEN_SETQ(setq,    P2_PFX_SETQ)
GEN_SETQ(setq_2,  P2_PFX_SETQ)
GEN_SETQ(setq2,   P2_PFX_SETQ2)
GEN_SETQ(setq2_2, P2_PFX_SETQ2)

/* GETCT reads this cog's own clock; WC selects the high half, which is how
 * `__system___getus` assembles a 64-bit time from two reads. */
static bool trans_getct(DisasContext *ctx, arg_misc *a)
{
    TCGv_i64 t = tcg_temp_new_i64();
    TCGv_i32 v = tcg_temp_new_i32();
    TCGLabel *skip = p2_gen_cond(ctx, a->cond);

    tcg_gen_ld_i64(t, tcg_env, offsetof(CPUP2State, clocks));
    if (a->c) {
        tcg_gen_shri_i64(t, t, 32);
    }
    tcg_gen_extrl_i64_i32(v, t);
    p2_st_d(ctx, v, a->d);
    p2_end_cond(skip);
    return true;
}

/* REV reverses all 32 bits of D in place. */
static bool trans_rev(DisasContext *ctx, arg_misc *a)
{
    TCGv_i32 d = tcg_temp_new_i32();
    TCGLabel *skip = p2_gen_cond(ctx, a->cond);

    p2_ld_d(ctx, d, a->d);
    /* bswap gets the bytes; the bits inside each byte still need reversing. */
    tcg_gen_bswap32_i32(d, d);
    {
        TCGv_i32 t = tcg_temp_new_i32();
        tcg_gen_shri_i32(t, d, 4);
        tcg_gen_andi_i32(t, t, 0x0F0F0F0F);
        tcg_gen_andi_i32(d, d, 0x0F0F0F0F);
        tcg_gen_shli_i32(d, d, 4);
        tcg_gen_or_i32(d, d, t);
        tcg_gen_shri_i32(t, d, 2);
        tcg_gen_andi_i32(t, t, 0x33333333);
        tcg_gen_andi_i32(d, d, 0x33333333);
        tcg_gen_shli_i32(d, d, 2);
        tcg_gen_or_i32(d, d, t);
        tcg_gen_shri_i32(t, d, 1);
        tcg_gen_andi_i32(t, t, 0x55555555);
        tcg_gen_andi_i32(d, d, 0x55555555);
        tcg_gen_shli_i32(d, d, 1);
        tcg_gen_or_i32(d, d, t);
    }
    p2_st_d(ctx, d, a->d);
    p2_end_cond(skip);
    return true;
}


/* ---- batch 10: ALTD/ALTS ------------------------------------------------- */

/*
 * The S operand of ALTD/ALTS is two fields, not one addend: S[8:0] is the
 * offset added to D to form the substituted field, and S[17:9] is a SIGNED
 * increment written back to the D register.
 *
 * flexspin's FCACHE depends on that second half. Its `ret_instr_`
 * (`_ret_ cmp inb,#0` = $0207FE00) is chosen so that as ALTD's S it offsets by
 * zero and post-decrements PA -- its own source calls it "a return instruction
 * that also works as an ALTD post-decrement". Without the writeback the
 * following `setq pa` loads one long too many and overwrites the terminator
 * ALTD had just placed.
 */
#define GEN_ALTX(NAME, FIELD, BIT)                                            \
    static bool trans_##NAME(DisasContext *ctx, arg_ds *a)                    \
    {                                                                         \
        uint32_t mask = 0;                                                    \
        uint32_t keep = ctx->prefix & mask;                                   \
        uint32_t kept_cancelled = ctx->prefix                                 \
                                  & (P2_PFX_ALTD | P2_PFX_ALTS);              \
        TCGv_i32 d = tcg_temp_new_i32(), sv = tcg_temp_new_i32();             \
        TCGv_i32 t = tcg_temp_new_i32();                                      \
        TCGLabel *skip;                                                       \
        if (a->cond != 0xF && a->cond != 0) {                                 \
            tcg_gen_st_i32(tcg_constant_i32(kept_cancelled), tcg_env,         \
                           offsetof(CPUP2State, prefix));                     \
        }                                                                     \
        skip = p2_gen_cond(ctx, a->cond);                                     \
        p2_ld_d(ctx, d, a->d);                                                \
        p2_get_s(ctx, sv, a->i, a->s);                                        \
        tcg_gen_add_i32(t, d, sv);                                            \
        tcg_gen_andi_i32(t, t, 0x1FF);                                        \
        tcg_gen_st_i32(t, tcg_env, offsetof(CPUP2State, FIELD));              \
        /* S[17:9], sign-extended, post-increments the D register. */         \
        tcg_gen_shri_i32(t, sv, 9);                                           \
        tcg_gen_andi_i32(t, t, 0x1FF);                                        \
        tcg_gen_shli_i32(t, t, 23);                                           \
        tcg_gen_sari_i32(t, t, 23);                                           \
        tcg_gen_add_i32(t, d, t);                                             \
        p2_st_d(ctx, t, a->d);                                                \
        if (a->cond != 0xF && a->cond != 0) {                                 \
            tcg_gen_st_i32(tcg_constant_i32(keep | (BIT)), tcg_env,           \
                           offsetof(CPUP2State, prefix));                     \
        }                                                                     \
        p2_end_cond(skip);                                                    \
        GEN_PREFIX_TAIL(BIT, mask);                                           \
        return true;                                                          \
    }

GEN_ALTX(altd, alt_d, P2_PFX_ALTD)
GEN_ALTX(alts, alt_s, P2_PFX_ALTS)


/* ---- batch 11: smart pins ------------------------------------------------ */

/*
 * WRPIN/WXPIN/WYPIN take the PIN from S and the VALUE from D -- the opposite
 * way round from most two-operand instructions, and silent if swapped. Bit 19
 * is D's L bit here, not WZ, so the decoder has already split the two forms
 * into separate patterns.
 */
#define GEN_PINCFG(NAME, HELPER, LITERAL)                                     \
    static bool trans_##NAME(DisasContext *ctx, arg_ds *a)                    \
    {                                                                         \
        TCGv_i32 pin = tcg_temp_new_i32(), v = tcg_temp_new_i32();            \
        TCGLabel *skip = p2_gen_cond(ctx, a->cond);                           \
        p2_get_s(ctx, pin, a->i, a->s);                                       \
        if (LITERAL) {                                                        \
            p2_get_d_literal(ctx, v, a->d);                                   \
        } else {                                                              \
            p2_ld_d(ctx, v, a->d);                                            \
        }                                                                     \
        gen_helper_##HELPER(tcg_env, pin, v);                                 \
        p2_end_cond(skip);                                                    \
        return true;                                                          \
    }

GEN_PINCFG(wrpin,   p2_wrpin, 0)
GEN_PINCFG(wrpin_2, p2_wrpin, 1)
GEN_PINCFG(wxpin,   p2_wxpin, 0)
GEN_PINCFG(wxpin_2, p2_wxpin, 1)
GEN_PINCFG(wypin,   p2_wypin, 0)
GEN_PINCFG(wypin_2, p2_wypin, 1)

/*
 * RDPIN/RQPIN read a pin's result into D. Bit 19 selects which of the two this
 * is and bit 20 is the real WC, so the C write is a pattern constant.
 *
 * C means BUSY, not ready: `__system___txraw` spins on `rdpin #62 wc` /
 * `if_b jmp`, so a C stuck at 1 hangs the guest. The value and the busy bit
 * come back packed in one 64-bit result because RDPIN consumes the pin's IN
 * flag and so cannot be called twice.
 */
static bool p2_gen_rdpin(DisasContext *ctx, arg_ds *a)
{
    TCGv_i32 pin = tcg_temp_new_i32(), v = tcg_temp_new_i32();
    TCGv_i64 packed = tcg_temp_new_i64();
    TCGLabel *skip = p2_gen_cond(ctx, a->cond);

    p2_get_s(ctx, pin, a->i, a->s);
    gen_helper_p2_rdpin(packed, tcg_env, pin);
    tcg_gen_extrl_i64_i32(v, packed);
    p2_st_d(ctx, v, a->d);
    if (a->c) {
        tcg_gen_shri_i64(packed, packed, 32);
        tcg_gen_extrl_i64_i32(v, packed);
        tcg_gen_st_i32(v, tcg_env, offsetof(CPUP2State, c));
    }
    p2_end_cond(skip);
    return true;
}

#define GEN_RDPIN(NAME)                                                       \
    static bool trans_##NAME(DisasContext *ctx, arg_ds *a)                    \
    {                                                                         \
        return p2_gen_rdpin(ctx, a);                                          \
    }

GEN_RDPIN(rdpin)
GEN_RDPIN(rdpin_2)
GEN_RDPIN(rqpin)
GEN_RDPIN(rqpin_2)

/*
 * TESTP samples a pin's IN flag into C and/or Z. The pin comes from D, not S.
 * C and Z are fixed by the encoding -- indeed a DIRL/DIRH encoding WITH C or Z
 * set is not a DIRL at all, it is a TESTP, which is why these patterns sit
 * ahead of the pin-op block in the decoder.
 */
static bool p2_gen_testp(DisasContext *ctx, arg_misc *a)
{
    TCGv_i32 pin = tcg_temp_new_i32(), v = tcg_temp_new_i32();
    TCGLabel *skip = p2_gen_cond(ctx, a->cond);

    p2_get_misc_d(ctx, pin, a);
    gen_helper_p2_testp(v, tcg_env, pin);
    if (a->c) {
        tcg_gen_st_i32(v, tcg_env, offsetof(CPUP2State, c));
    }
    if (a->z) {
        tcg_gen_st_i32(v, tcg_env, offsetof(CPUP2State, z));
    }
    p2_end_cond(skip);
    return true;
}

#define GEN_TESTP(NAME)                                                       \
    static bool trans_##NAME(DisasContext *ctx, arg_misc *a)                  \
    {                                                                         \
        return p2_gen_testp(ctx, a);                                          \
    }

GEN_TESTP(testp)
GEN_TESTP(testp_2)
GEN_TESTP(testp_3)

/*
 * The DIR/OUT/FLT/DRV family. Which register pair a pin lands in is a runtime
 * choice, and the two writes must be ordered so the pad is never briefly
 * driven at the wrong level, so the whole family is one helper. WC/WZ on these
 * encodings are not flag requests -- on $40/$41 they select TESTP, and
 * elsewhere p2core leaves the flags alone, so they are ignored here too.
 */
#define GEN_PINOP(NAME, OP)                                                   \
    static bool trans_##NAME(DisasContext *ctx, arg_misc *a)                  \
    {                                                                         \
        TCGv_i32 pin = tcg_temp_new_i32();                                    \
        TCGLabel *skip = p2_gen_cond(ctx, a->cond);                           \
        p2_get_misc_d(ctx, pin, a);                                           \
        gen_helper_p2_pinop(tcg_env, pin, tcg_constant_i32(OP));              \
        p2_end_cond(skip);                                                    \
        return true;                                                          \
    }

GEN_PINOP(dirl,     P2_PINOP_DIRL)
GEN_PINOP(dirl_2,   P2_PINOP_DIRL)
GEN_PINOP(dirh,     P2_PINOP_DIRH)
GEN_PINOP(dirh_2,   P2_PINOP_DIRH)
GEN_PINOP(fltl,     P2_PINOP_FLTL)
GEN_PINOP(fltl_2,   P2_PINOP_FLTL)
GEN_PINOP(flth,     P2_PINOP_FLTH)
GEN_PINOP(flth_2,   P2_PINOP_FLTH)
GEN_PINOP(drvl,     P2_PINOP_DRVL)
GEN_PINOP(drvl_2,   P2_PINOP_DRVL)
GEN_PINOP(drvh,     P2_PINOP_DRVH)
GEN_PINOP(drvh_2,   P2_PINOP_DRVH)
GEN_PINOP(outl,     P2_PINOP_OUTL)
GEN_PINOP(outl_2,   P2_PINOP_OUTL)
GEN_PINOP(outh,     P2_PINOP_OUTH)
GEN_PINOP(outh_2,   P2_PINOP_OUTH)
GEN_PINOP(drvc,     P2_PINOP_DRVC)
GEN_PINOP(drvc_2,   P2_PINOP_DRVC)
GEN_PINOP(drvnc,    P2_PINOP_DRVNC)
GEN_PINOP(drvnc_2,  P2_PINOP_DRVNC)
GEN_PINOP(drvz,     P2_PINOP_DRVZ)
GEN_PINOP(drvz_2,   P2_PINOP_DRVZ)
GEN_PINOP(drvnz,    P2_PINOP_DRVNZ)
GEN_PINOP(drvnz_2,  P2_PINOP_DRVNZ)
GEN_PINOP(drvnot,   P2_PINOP_DRVNOT)
GEN_PINOP(drvnot_2, P2_PINOP_DRVNOT)

/*
 * WAITX jumps the clock rather than spinning: the cog is not executing during
 * the wait, which is exactly what an interpreter can model and a
 * HAL-instrumented native backend cannot.
 */
#define GEN_WAITX(NAME)                                                       \
    static bool trans_##NAME(DisasContext *ctx, arg_misc *a)                  \
    {                                                                         \
        TCGv_i32 d = tcg_temp_new_i32();                                      \
        TCGv_i64 t = tcg_temp_new_i64(), n = tcg_temp_new_i64();              \
        TCGLabel *skip = p2_gen_cond(ctx, a->cond);                           \
        p2_get_misc_d(ctx, d, a);                                             \
        tcg_gen_extu_i32_i64(n, d);                                           \
        tcg_gen_ld_i64(t, tcg_env, offsetof(CPUP2State, clocks));             \
        tcg_gen_add_i64(t, t, n);                                             \
        tcg_gen_st_i64(t, tcg_env, offsetof(CPUP2State, clocks));             \
        p2_end_cond(skip);                                                    \
        return true;                                                          \
    }

GEN_WAITX(waitx)
GEN_WAITX(waitx_2)


/* ---- batch 12: the simple tail ------------------------------------------- */

/* SUBR is the reverse subtract: D = S - D, and C is its borrow. */
static bool trans_subr(DisasContext *ctx, arg_ds *a)
{
    TCGv_i32 d = tcg_temp_new_i32(), sv = tcg_temp_new_i32();
    TCGv_i32 r = tcg_temp_new_i32();
    TCGLabel *skip = p2_gen_cond(ctx, a->cond);

    p2_ld_d(ctx, d, a->d);
    p2_get_s(ctx, sv, a->i, a->s);
    if (a->c) {
        TCGv_i32 cf = tcg_temp_new_i32();
        tcg_gen_setcond_i32(TCG_COND_LTU, cf, sv, d);
        tcg_gen_st_i32(cf, tcg_env, offsetof(CPUP2State, c));
    }
    tcg_gen_sub_i32(r, sv, d);
    p2_st_d(ctx, r, a->d);
    p2_set_z(r, a->z);
    p2_end_cond(skip);
    return true;
}

GEN_ALU(andn, tcg_gen_andc_i32(d, d, s), p2_set_flags_parity)

/*
 * MOVBYTS rebuilds D from its own bytes, S[1:0] choosing byte 0 of the result,
 * S[3:2] byte 1 and so on. It writes NO flags -- C and Z are the selector bits
 * that pick this instruction out of op $4F in the first place.
 */
static bool trans_movbyts(DisasContext *ctx, arg_ds *a)
{
    TCGv_i32 d = tcg_temp_new_i32(), sv = tcg_temp_new_i32();
    TCGv_i32 r = tcg_temp_new_i32(), off = tcg_temp_new_i32();
    TCGv_i32 b = tcg_temp_new_i32();
    TCGLabel *skip = p2_gen_cond(ctx, a->cond);
    int i;

    p2_ld_d(ctx, d, a->d);
    p2_get_s(ctx, sv, a->i, a->s);
    tcg_gen_movi_i32(r, 0);
    for (i = 0; i < 4; i++) {
        tcg_gen_shri_i32(off, sv, 2 * i);
        tcg_gen_andi_i32(off, off, 3);
        tcg_gen_shli_i32(off, off, 3);      /* byte index -> bit offset */
        tcg_gen_shr_i32(b, d, off);
        tcg_gen_andi_i32(b, b, 0xFF);
        tcg_gen_shli_i32(b, b, 8 * i);
        tcg_gen_or_i32(r, r, b);
    }
    p2_st_d(ctx, r, a->d);
    p2_end_cond(skip);
    return true;
}

/*
 * WRC/WRNC/WRZ/WRNZ put a flag (or its complement) into D as 0 or 1 and touch
 * NO flags of their own: with WZ set, silicon left Z clear on WRC's 0 result,
 * where a Z = (result == 0) would have set it.
 *
 * Bit 18 is the misc block's L bit, and with D taken as a literal silicon
 * performs no register write at all -- so the _2 forms are genuinely nothing.
 */
#define GEN_WRFLAG(NAME, FIELD, INVERT, LITERAL)                              \
    static bool trans_##NAME(DisasContext *ctx, arg_misc *a)                  \
    {                                                                         \
        TCGv_i32 v;                                                           \
        TCGLabel *skip;                                                       \
        if (LITERAL) {                                                        \
            return true;                                                      \
        }                                                                     \
        v = tcg_temp_new_i32();                                               \
        skip = p2_gen_cond(ctx, a->cond);                                     \
        tcg_gen_ld_i32(v, tcg_env, offsetof(CPUP2State, FIELD));              \
        if (INVERT) { tcg_gen_xori_i32(v, v, 1); }                            \
        p2_st_d(ctx, v, a->d);                                                \
        p2_end_cond(skip);                                                    \
        return true;                                                          \
    }

GEN_WRFLAG(wrc,    c, 0, 0)
GEN_WRFLAG(wrnc,   c, 1, 0)
GEN_WRFLAG(wrz,    z, 0, 0)
GEN_WRFLAG(wrnz,   z, 1, 0)
GEN_WRFLAG(wrc_2,  c, 0, 1)
GEN_WRFLAG(wrnc_2, c, 1, 1)
GEN_WRFLAG(wrz_2,  z, 0, 1)
GEN_WRFLAG(wrnz_2, z, 1, 1)


/* ---- batch 13: CORDIC, locks, cog identity, the CT1 deadline ------------- */

/*
 * QMUL/QDIV/QSQRT/QROTATE write the result queue; GETQX/GETQY read it back.
 * Bit 19 is D's L bit in this block (Form::OperandLs in p2core), not WZ, so
 * the decoder has already split the two D forms into separate patterns.
 */
#define GEN_QOP2(NAME, LITERAL, BODY)                                         \
    static bool trans_##NAME(DisasContext *ctx, arg_ds *a)                    \
    {                                                                         \
        TCGv_i32 d = tcg_temp_new_i32(), sv = tcg_temp_new_i32();             \
        TCGLabel *skip = p2_gen_cond(ctx, a->cond);                           \
        if (LITERAL) {                                                        \
            p2_get_d_literal(ctx, d, a->d);                                   \
        } else {                                                              \
            p2_ld_d(ctx, d, a->d);                                            \
        }                                                                     \
        p2_get_s(ctx, sv, a->i, a->s);                                        \
        BODY;                                                                 \
        p2_end_cond(skip);                                                    \
        return true;                                                          \
    }

/* QMUL is a plain 32x32 -> 64 multiply: low half into QX, high into QY. */
#define P2_QMUL_BODY                                                          \
    do {                                                                      \
        TCGv_i32 lo = tcg_temp_new_i32(), hi = tcg_temp_new_i32();            \
        tcg_gen_mulu2_i32(lo, hi, d, sv);                                     \
        tcg_gen_st_i32(lo, tcg_env, offsetof(CPUP2State, qx));                \
        tcg_gen_st_i32(hi, tcg_env, offsetof(CPUP2State, qy));                \
    } while (0)

GEN_QOP2(qmul,   0, P2_QMUL_BODY)
GEN_QOP2(qmul_2, 1, P2_QMUL_BODY)

/* QDIV's dividend is 64-bit when a SETQ supplied the high half, which the TB
 * key already tells us -- so the helper is told statically whether to use it. */
#define P2_QDIV_BODY                                                          \
    gen_helper_p2_qdiv(tcg_env, d, sv,                                        \
                       tcg_constant_i32(!!(ctx->prefix & P2_PFX_SETQ)))

GEN_QOP2(qdiv,   0, P2_QDIV_BODY)
GEN_QOP2(qdiv_2, 1, P2_QDIV_BODY)
GEN_QOP2(qrotate,   0, gen_helper_p2_qrotate(tcg_env, d, sv))
GEN_QOP2(qrotate_2, 1, gen_helper_p2_qrotate(tcg_env, d, sv))
GEN_QOP2(qsqrt,   0, gen_helper_p2_qsqrt(tcg_env, d))
GEN_QOP2(qsqrt_2, 1, gen_helper_p2_qsqrt(tcg_env, d))

#define GEN_GETQ(NAME, FIELD)                                                 \
    static bool trans_##NAME(DisasContext *ctx, arg_misc *a)                  \
    {                                                                         \
        TCGv_i32 v = tcg_temp_new_i32();                                      \
        TCGLabel *skip = p2_gen_cond(ctx, a->cond);                           \
        tcg_gen_ld_i32(v, tcg_env, offsetof(CPUP2State, FIELD));              \
        p2_st_d(ctx, v, a->d);                                                \
        p2_set_z(v, a->z);                                                    \
        p2_end_cond(skip);                                                    \
        return true;                                                          \
    }

GEN_GETQ(getqx,   qx)
GEN_GETQ(getqx_2, qx)
GEN_GETQ(getqy,   qy)
GEN_GETQ(getqy_2, qy)

/*
 * The lock pool. LOCKNEW allocates, LOCKRET frees, LOCKTRY takes (succeeding
 * if the lock is free OR already this cog's) and LOCKREL drops it. Note the
 * asymmetry p2core records from silicon: LOCKNEW writes C only when it
 * SUCCEEDS -- on exhaustion it writes 15 into D and leaves C alone.
 */
#define GEN_LOCKNEW(NAME)                                                     \
    static bool trans_##NAME(DisasContext *ctx, arg_misc *a)                  \
    {                                                                         \
        TCGv_i32 v = tcg_temp_new_i32();                                      \
        TCGLabel *skip = p2_gen_cond(ctx, a->cond);                           \
        gen_helper_p2_locknew(v, tcg_env, tcg_constant_i32(a->c));            \
        p2_st_d(ctx, v, a->d);                                                \
        p2_end_cond(skip);                                                    \
        return true;                                                          \
    }

GEN_LOCKNEW(locknew)
GEN_LOCKNEW(locknew_2)

/* LOCKRET/LOCKREL take the lock id from D and write no result. LOCKREL's C,
 * when asked for, is always clear. */
#define GEN_LOCKOP(NAME, HELPER, CLEARS_C)                                    \
    static bool trans_##NAME(DisasContext *ctx, arg_misc *a)                  \
    {                                                                         \
        TCGv_i32 d = tcg_temp_new_i32();                                      \
        TCGLabel *skip = p2_gen_cond(ctx, a->cond);                           \
        p2_get_misc_d(ctx, d, a);                                             \
        gen_helper_##HELPER(tcg_env, d);                                      \
        if (CLEARS_C && a->c) {                                               \
            tcg_gen_st_i32(tcg_constant_i32(0), tcg_env,                      \
                           offsetof(CPUP2State, c));                          \
        }                                                                     \
        p2_end_cond(skip);                                                    \
        return true;                                                          \
    }

GEN_LOCKOP(lockret,   p2_lockret, 0)
GEN_LOCKOP(lockret_2, p2_lockret, 0)
GEN_LOCKOP(lockrel,   p2_lockrel, 1)
GEN_LOCKOP(lockrel_2, p2_lockrel, 1)

#define GEN_LOCKTRY(NAME)                                                     \
    static bool trans_##NAME(DisasContext *ctx, arg_misc *a)                  \
    {                                                                         \
        TCGv_i32 d = tcg_temp_new_i32(), got = tcg_temp_new_i32();            \
        TCGLabel *skip = p2_gen_cond(ctx, a->cond);                           \
        p2_get_misc_d(ctx, d, a);                                             \
        gen_helper_p2_locktry(got, tcg_env, d);                               \
        if (a->c) {                                                           \
            tcg_gen_st_i32(got, tcg_env, offsetof(CPUP2State, c));            \
        }                                                                     \
        p2_end_cond(skip);                                                    \
        return true;                                                          \
    }

GEN_LOCKTRY(locktry)
GEN_LOCKTRY(locktry_2)

/* COGID reports which cog this is; its C, when asked for, is always clear. */
#define GEN_COGID(NAME)                                                       \
    static bool trans_##NAME(DisasContext *ctx, arg_misc *a)                  \
    {                                                                         \
        TCGv_i32 v = tcg_temp_new_i32();                                      \
        TCGLabel *skip = p2_gen_cond(ctx, a->cond);                           \
        tcg_gen_ld_i32(v, tcg_env, offsetof(CPUP2State, cogid));              \
        p2_st_d(ctx, v, a->d);                                                \
        if (a->c) {                                                           \
            tcg_gen_st_i32(tcg_constant_i32(0), tcg_env,                      \
                           offsetof(CPUP2State, c));                          \
        }                                                                     \
        p2_end_cond(skip);                                                    \
        return true;                                                          \
    }

GEN_COGID(cogid)
GEN_COGID(cogid_2)

#define GEN_COGSTOP(NAME)                                                     \
    static bool trans_##NAME(DisasContext *ctx, arg_misc *a)                  \
    {                                                                         \
        TCGv_i32 d = tcg_temp_new_i32();                                      \
        TCGLabel *skip = p2_gen_cond(ctx, a->cond);                           \
        p2_get_misc_d(ctx, d, a);                                             \
        /* Stopping THIS cog does not return, so the PC must already be the   \
         * one the cog would resume at if it were restarted. */               \
        tcg_gen_st_i32(tcg_constant_i32(ctx->base.pc_next), tcg_env,          \
                       offsetof(CPUP2State, pc));                             \
        gen_helper_p2_cogstop(tcg_env, d);                                    \
        p2_end_cond(skip);                                                    \
        return true;                                                          \
    }

GEN_COGSTOP(cogstop)
GEN_COGSTOP(cogstop_2)

/*
 * HUBSET records a clock mode and nothing else: the PLL is not modelled and
 * clkfreq() reads hub $14 on demand, which is where the firmware puts it.
 */
static bool trans_hubset(DisasContext *ctx, arg_misc *a)
{
    return true;
}

static bool trans_hubset_2(DisasContext *ctx, arg_misc *a)
{
    return true;
}

/*
 * ADDCT1/2/3 arm a deadline: D + S goes BOTH into the deadline register and
 * back into D. Silicon: $80000000 + 1 leaves d=$80000001, with C and Z
 * unchanged in all eight probe cases -- bits 20:19 are the CT1/CT2/CT3
 * selector, not WC/WZ, so the decoder has already spent them and the flags
 * must not be touched.
 *
 * Only CT1 is modelled, as in p2core, so 2 and 3 alias onto it.
 */
#define GEN_ADDCT(NAME)                                                       \
    static bool trans_##NAME(DisasContext *ctx, arg_ds *a)                    \
    {                                                                         \
        TCGv_i32 d = tcg_temp_new_i32(), sv = tcg_temp_new_i32();             \
        TCGLabel *skip = p2_gen_cond(ctx, a->cond);                           \
        p2_ld_d(ctx, d, a->d);                                                \
        p2_get_s(ctx, sv, a->i, a->s);                                        \
        tcg_gen_add_i32(d, d, sv);                                            \
        p2_st_d(ctx, d, a->d);                                                \
        tcg_gen_st_i32(d, tcg_env, offsetof(CPUP2State, ct1));                \
        p2_end_cond(skip);                                                    \
        return true;                                                          \
    }

GEN_ADDCT(addct1)
GEN_ADDCT(addct2)
GEN_ADDCT(addct3)

/*
 * WAITCT1 jumps the clock to the deadline rather than spinning, against the
 * same counter GETCT reads -- this cog's own clock. The comparison is a
 * WRAPPING one: the deadline is a 32-bit value and the clock is 64-bit, so a
 * target already in the past (delta <= 0 as a signed 32-bit) waits not at all.
 */
static bool trans_waitct1(DisasContext *ctx, arg_dsel *a)
{
    TCGv_i64 clk = tcg_temp_new_i64(), add = tcg_temp_new_i64();
    TCGv_i32 now = tcg_temp_new_i32(), target = tcg_temp_new_i32();
    TCGv_i32 delta = tcg_temp_new_i32();
    TCGLabel *skip = p2_gen_cond(ctx, a->cond);

    tcg_gen_ld_i64(clk, tcg_env, offsetof(CPUP2State, clocks));
    tcg_gen_extrl_i64_i32(now, clk);
    tcg_gen_ld_i32(target, tcg_env, offsetof(CPUP2State, ct1));
    tcg_gen_sub_i32(delta, target, now);
    /* Only a strictly positive signed delta is a wait. */
    tcg_gen_movcond_i32(TCG_COND_GT, delta, delta, tcg_constant_i32(0),
                        delta, tcg_constant_i32(0));
    tcg_gen_extu_i32_i64(add, delta);
    tcg_gen_add_i64(clk, clk, add);
    tcg_gen_st_i64(clk, tcg_env, offsetof(CPUP2State, clocks));
    p2_end_cond(skip);
    return true;
}


/* ---- batch 14: REP, SKIP, COGINIT ---------------------------------------- */

/*
 * REP arms a hardware loop over the NEXT D instructions, run S times. Bit 19
 * is D's L bit here (Form::OperandRep), not WZ.
 *
 * From this instruction on, every instruction in the block has to be followed
 * by a check of "has the PC left the block yet", which is why "a REP is live"
 * is part of the translation-block key: blocks translated outside one pay
 * nothing at all.
 */
#define GEN_REP(NAME, LITERAL)                                                \
    static bool trans_##NAME(DisasContext *ctx, arg_ds *a)                    \
    {                                                                         \
        TCGv_i32 len = tcg_temp_new_i32(), cnt = tcg_temp_new_i32();          \
        TCGLabel *skip = p2_gen_cond(ctx, a->cond);                           \
        if (LITERAL) {                                                        \
            p2_get_d_literal(ctx, len, a->d);                                 \
        } else {                                                              \
            p2_ld_d(ctx, len, a->d);                                          \
        }                                                                     \
        p2_get_s(ctx, cnt, a->i, a->s);                                       \
        gen_helper_p2_rep(tcg_env, len, cnt,                                  \
                          tcg_constant_i32(ctx->base.pc_next));               \
        p2_end_cond(skip);                                                    \
        ctx->rep_active = true;                                               \
        return true;                                                          \
    }

GEN_REP(rep,   0)
GEN_REP(rep_2, 1)

/*
 * SKIP loads a 32-bit cancellation pattern, LSB first, one bit per following
 * instruction. Like REP it changes what the instruction stream means, so it
 * travels in the TB key.
 */
#define GEN_SKIP(NAME, LITERAL)                                               \
    static bool trans_##NAME(DisasContext *ctx, arg_misc *a)                  \
    {                                                                         \
        TCGv_i32 d = tcg_temp_new_i32();                                      \
        TCGLabel *skip = p2_gen_cond(ctx, a->cond);                           \
        if (LITERAL) {                                                        \
            p2_get_d_literal(ctx, d, a->d);                                   \
        } else {                                                              \
            p2_ld_d(ctx, d, a->d);                                            \
        }                                                                     \
        gen_helper_p2_skip_arm(tcg_env, d);                                   \
        p2_end_cond(skip);                                                    \
        ctx->skip_active = true;                                              \
        return true;                                                          \
    }

GEN_SKIP(skip,   0)
GEN_SKIP(skip_2, 1)

/*
 * COGINIT starts another cog -- or restarts this one, which is why the PC is
 * committed before the helper runs and the block always ends here: if the
 * target is this cog, the helper has just replaced the PC we would otherwise
 * fall through to.
 */
static bool trans_coginit(DisasContext *ctx, arg_ds *a)
{
    TCGv_i32 d = tcg_temp_new_i32(), sv = tcg_temp_new_i32();
    TCGLabel *skip = p2_gen_cond(ctx, a->cond);

    /* Bit 19 is D's L bit in this encoding (Form::OperandLs), not WZ. */
    if (a->z) {
        p2_get_d_literal(ctx, d, a->d);
    } else {
        p2_ld_d(ctx, d, a->d);
    }
    p2_get_s(ctx, sv, a->i, a->s);
    tcg_gen_st_i32(tcg_constant_i32(ctx->base.pc_next), tcg_env,
                   offsetof(CPUP2State, pc));
    gen_helper_p2_coginit(tcg_env, d, sv,
                          tcg_constant_i32(!!(ctx->prefix & P2_PFX_SETQ)),
                          tcg_constant_i32(a->c));
    p2_gen_consume_prefix(ctx);
    p2_gen_exit(ctx);
    ctx->branched = true;
    p2_end_branch(ctx, skip);
    return true;
}


/* ---- batch 15: the four p2core implements and this target still refused ---- */

/* GETCT's I=1 encoding reaches the same arm in p2core (the misc decode falls
 * back to the S-only table entry), and still writes cog register #D. */
static bool trans_getct_2(DisasContext *ctx, arg_misc *a)
{
    return trans_getct(ctx, a);
}

/*
 * MODCZ rewrites the flags from a 4+4-bit truth table in D, indexed by the
 * CURRENT {C,Z}: C = cccc[{C,Z}], Z = zzzz[{C,Z}], with D[7:4] = cccc and
 * D[3:0] = zzzz. `modcz _set,0 wc` is D=$F0 with WC only, and C becomes 1
 * whatever the terminating non-hex digit left behind -- so both flags must be
 * read before either is written.
 *
 * D is a literal by construction here (p2core special-cases S=$6F with I=1
 * ahead of the misc table), widened by any pending AUGD.
 */
static bool trans_modcz(DisasContext *ctx, arg_misc *a)
{
    TCGv_i32 d = tcg_temp_new_i32(), c = tcg_temp_new_i32();
    TCGv_i32 z = tcg_temp_new_i32(), idx = tcg_temp_new_i32();
    TCGv_i32 t = tcg_temp_new_i32();
    TCGLabel *skip = p2_gen_cond(ctx, a->cond);

    p2_get_d_literal(ctx, d, a->d);
    tcg_gen_ld_i32(c, tcg_env, offsetof(CPUP2State, c));
    tcg_gen_ld_i32(z, tcg_env, offsetof(CPUP2State, z));
    tcg_gen_shli_i32(idx, c, 1);
    tcg_gen_or_i32(idx, idx, z);
    if (a->c) {
        tcg_gen_shri_i32(t, d, 4);
        tcg_gen_andi_i32(t, t, 0xF);
        tcg_gen_shr_i32(t, t, idx);
        tcg_gen_andi_i32(t, t, 1);
        tcg_gen_st_i32(t, tcg_env, offsetof(CPUP2State, c));
    }
    if (a->z) {
        tcg_gen_andi_i32(t, d, 0xF);
        tcg_gen_shr_i32(t, t, idx);
        tcg_gen_andi_i32(t, t, 1);
        tcg_gen_st_i32(t, tcg_env, offsetof(CPUP2State, z));
    }
    p2_end_cond(skip);
    return true;
}

/*
 * POLLSE1-4 are poll-and-clear on an event p2core never raises, so both flags
 * report not-set. Do NOT copy this shape to POLLCT1-3: the CT deadline IS
 * modelled and observable, so a POLLCT that always reported not-set would
 * contradict WAITCT1 -- those stay refused.
 */
#define GEN_POLLSE(NAME)                                                      \
    static bool trans_##NAME(DisasContext *ctx, arg_dsel *a)                  \
    {                                                                         \
        TCGLabel *skip = p2_gen_cond(ctx, a->cond);                           \
        if (a->c) {                                                           \
            tcg_gen_st_i32(tcg_constant_i32(0), tcg_env,                      \
                           offsetof(CPUP2State, c));                          \
        }                                                                     \
        if (a->z) {                                                           \
            tcg_gen_st_i32(tcg_constant_i32(0), tcg_env,                      \
                           offsetof(CPUP2State, z));                          \
        }                                                                     \
        p2_end_cond(skip);                                                    \
        return true;                                                          \
    }

GEN_POLLSE(pollse1)
GEN_POLLSE(pollse2)
GEN_POLLSE(pollse3)
GEN_POLLSE(pollse4)

/*
 * BITRND is the TESTB+XOR twin of BITNOT, and the difference is easy to miss:
 * its C != Z accumulate XORs the UN-inverted D[S[4:0]], where BITNOT XORs the
 * inverted one. C == Z writes pseudo-random bits across the span and, under
 * WCZ, reports the ORIGINAL base bit in both flags -- not the bit just
 * written.
 */
static bool trans_bitrnd(DisasContext *ctx, arg_ds *a)
{
    TCGv_i32 d = tcg_temp_new_i32(), sv = tcg_temp_new_i32();
    TCGv_i32 base = tcg_temp_new_i32(), prior = tcg_temp_new_i32();
    TCGLabel *skip = p2_gen_cond(ctx, a->cond);

    p2_ld_d(ctx, d, a->d);
    p2_get_s(ctx, sv, a->i, a->s);
    tcg_gen_andi_i32(base, sv, 31);
    tcg_gen_shr_i32(prior, d, base);
    tcg_gen_andi_i32(prior, prior, 1);

    if (a->c != a->z) {
        int flag = a->c ? offsetof(CPUP2State, c) : offsetof(CPUP2State, z);
        TCGv_i32 cur = tcg_temp_new_i32();

        tcg_gen_ld_i32(cur, tcg_env, flag);
        tcg_gen_xor_i32(cur, cur, prior);
        tcg_gen_st_i32(cur, tcg_env, flag);
    } else {
        TCGv_i32 r = tcg_temp_new_i32();

        gen_helper_p2_bitrnd(r, tcg_env, d, sv, base);
        p2_st_d(ctx, r, a->d);
        if (a->c) {
            tcg_gen_st_i32(prior, tcg_env, offsetof(CPUP2State, c));
        }
        if (a->z) {
            tcg_gen_st_i32(prior, tcg_env, offsetof(CPUP2State, z));
        }
    }
    p2_end_cond(skip);
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
    /* Which prefixes are live is part of the TB key, so a block translated
     * with a pending AUGS is never reused where none is pending. */
    ctx->prefix = dcbase->tb->flags & P2_PFX_MASK;
    ctx->rep_active = (dcbase->tb->flags & P2_TB_REP) != 0;
    ctx->skip_active = (dcbase->tb->flags & P2_TB_SKIP) != 0;
}

static void p2_tr_tb_start(DisasContextBase *db, CPUState *cs) { }

static void p2_tr_insn_start(DisasContextBase *dcbase, CPUState *cs)
{
    tcg_gen_insn_start(dcbase->pc_next);
}

static void p2_tr_translate_insn(DisasContextBase *dcbase, CPUState *cs)
{
    DisasContext *ctx = container_of(dcbase, DisasContext, base);
    uint32_t insn, entry_prefix, alt;
    int cond;
    bool decoded;
    TCGLabel *cancelled = NULL;

    if (dcbase->pc_next < P2_HUB_BASE) {
        /*
         * Cog space: hand a whole run to the interpreter (Spike 0b). The
         * helper sets env->pc itself, but pc_next must still advance -- a TB
         * of size 0 trips setjmp_gen_code's assert.
         */
        gen_helper_p2_interp_cog(tcg_env, tcg_constant_i32(P2_COG_RUN));
        dcbase->pc_next += 4;
        /*
         * The helper leaves env->pc wherever the run ended, so this block must
         * exit explicitly. DISAS_NORETURN alone is not enough: it tells
         * tb_stop the block already left, and the generated code would then
         * fall through into QEMU's own exit-request label and report
         * TB_EXIT_REQUESTED with nothing having requested it -- which asserts
         * in cpu_loop_exec_tb the moment icount is off.
         */
        tcg_gen_exit_tb(NULL, 0);
        dcbase->is_jmp = DISAS_NORETURN;
        return;
    }

    insn = translator_ldl(ctx->env, dcbase, dcbase->pc_next);
    dcbase->pc_next += 4;
    p2_gen_clock();
    ctx->branched = false;
    ctx->is_prefix = false;
    ctx->prefix_survives = 0;
    entry_prefix = ctx->prefix;
    alt = entry_prefix & (P2_PFX_ALTD | P2_PFX_ALTS);
    /* An all-zero word is NOP, and its EEEE field is NOT the _RET_ prefix:
     * p2core decodes it with cond 15 explicitly, because otherwise it is a ROR
     * under %0000 and returns through an empty stack. */
    cond = insn ? (int)((insn >> 28) & 0xF) : 0xF;

    /* Capture the EEEE outcome before the body can move C or Z. */
    ctx->retired = tcg_constant_i32(1);
    if (ctx->rep_active || alt || ctx->skip_active) {
        TCGv_i32 t = tcg_temp_new_i32();

        p2_gen_cond_value(t, cond);
        ctx->retired = t;
    }

    /*
     * A SKIP pattern cancels whole instruction slots, and a cancelled slot is
     * never decoded on silicon -- compilers put inline DATA in one. So the
     * gate goes ahead of everything, the unimplemented trap included: the
     * cancelled path must not care that the word is not an instruction.
     */
    if (ctx->skip_active) {
        TCGv_i32 cancel = tcg_temp_new_i32();

        cancelled = gen_new_label();
        gen_helper_p2_skip_take(cancel, tcg_env);
        tcg_gen_brcondi_i32(TCG_COND_NE, cancel, 0, cancelled);
    }

    decoded = decode_p2(ctx, insn);
    if (!decoded) {
        p2_unimpl(ctx);
    } else if (!ctx->branched) {
        /* _RET_ on a non-branching instruction: it ran, now return. */
        p2_gen_ret_prefix(ctx, cond);
    }

    /*
     * Prefix bookkeeping, on the path where this instruction was not
     * cancelled. AUGS/AUGD/SETQ/SETQ2 are consumed by ANY instruction that
     * reached this point -- p2core clears them even when EEEE cancelled the
     * instruction. ALTD/ALTS are different: they are consumed only when the
     * instruction RETIRES, so they survive a condition-false slot.
     */
    if (ctx->is_prefix) {
        if (ctx->prefix != entry_prefix) {
            tcg_gen_st_i32(tcg_constant_i32(ctx->prefix), tcg_env,
                           offsetof(CPUP2State, prefix));
        }
    } else if (alt) {
        TCGv_i32 v = tcg_temp_new_i32();

        tcg_gen_movcond_i32(TCG_COND_NE, v, ctx->retired, tcg_constant_i32(0),
                            tcg_constant_i32(0), tcg_constant_i32(alt));
        tcg_gen_st_i32(v, tcg_env, offsetof(CPUP2State, prefix));
        ctx->prefix = 0;
        /*
         * Whether the ALTx survived is a RUNTIME answer, and the TB key cannot
         * hold both. End the block so the next one is keyed from env->prefix.
         */
        if (cond != 0xF && cond != 0 && dcbase->is_jmp == DISAS_NEXT) {
            dcbase->is_jmp = DISAS_TOO_MANY;
        }
    } else if (entry_prefix) {
        tcg_gen_st_i32(tcg_constant_i32(0), tcg_env,
                       offsetof(CPUP2State, prefix));
        ctx->prefix = 0;
    }

    if (cancelled) {
        /*
         * The cancelled path. It has retired nothing, and p2core clears
         * prefixes here only if the word DECODES -- by the same rule as any
         * instruction, so a cancelled SETQ/AUGS keeps its own kind. A word
         * that does not decode is data and clears nothing at all.
         */
        uint32_t keep = entry_prefix;

        if (dcbase->is_jmp != DISAS_NORETURN) {
            tcg_gen_st_i32(tcg_constant_i32(dcbase->pc_next), tcg_env,
                           offsetof(CPUP2State, pc));
            p2_gen_exit(ctx);
        }
        gen_set_label(cancelled);
        tcg_gen_movi_i32(ctx->retired, 0);
        if (decoded) {
            keep &= P2_PFX_ALTD | P2_PFX_ALTS | ctx->prefix_survives;
        }
        if (keep != entry_prefix) {
            tcg_gen_st_i32(tcg_constant_i32(keep), tcg_env,
                           offsetof(CPUP2State, prefix));
        }
        tcg_gen_st_i32(tcg_constant_i32(dcbase->pc_next), tcg_env,
                       offsetof(CPUP2State, pc));
        p2_gen_exit(ctx);
        dcbase->is_jmp = DISAS_NORETURN;
        return;
    }

    /*
     * A live REP has to be ticked after EVERY instruction, so each one ends
     * its block. That is slow, and it is confined to REP blocks: they are tiny
     * counted loops, and any block not inside one is keyed differently and
     * emits none of this.
     */
    if (ctx->rep_active && dcbase->is_jmp == DISAS_NEXT) {
        dcbase->is_jmp = DISAS_TOO_MANY;
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
        p2_gen_exit(ctx);
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
