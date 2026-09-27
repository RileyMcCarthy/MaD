/*
 * The cog-exec interpreter.
 * SPDX-License-Identifier: LGPL-2.1-or-later
 *
 * Cog RAM is both the register file and the instruction store, and Spike 0b
 * measured what that costs each way. Making it ordinary guest RAM is dead by
 * 20x: QEMU's store trap is sticky per page, so with 0.62 register writes per
 * instruction every one of them pays ~194 ns forever. JIT-ing cog-exec with
 * cog RAM in env is better but still only ~1.9x, because 536 distinct cog
 * longs get re-translated 880 000 times. Interpreting cog-exec in RUNS is 4.7x
 * and needs no invalidation at all -- and Spike 1b then measured the
 * interpreter itself at under 2% of total cost.
 *
 * So this file exists on purpose. What it must not become is a second opinion
 * about the instruction set:
 *
 *   - the DECODER is generated from the same insn.decode as the translator
 *     (decodetree --translate=iexec), so the two can never disagree about an
 *     encoding;
 *   - everything with real machinery behind it -- the pin bus, the lock pool,
 *     CORDIC, hub block transfers, the hardware stack, COGINIT, REP, SKIP --
 *     calls the SAME helpers the translator calls;
 *   - and the differential harness runs generated programs in cog space, so
 *     this is diffed against p2core instruction by instruction exactly as the
 *     translator is.
 *
 * What is genuinely duplicated is the ALU core, and that is the part the
 * harness covers most densely.
 */
#include "qemu/osdep.h"
#include "cpu.h"
#include "exec/helper-proto.h"
#include "accel/tcg/cpu-ldst.h"
#include "qemu/log.h"
#include "hw/core/cpu.h"
#include "exec/log.h"
#include "pinbus.h"

/*
 * Per-instruction state, mirroring p2core's step_one. The name is forced:
 * decodetree hard-codes `DisasContext *` as the first parameter of every
 * dispatch function.
 */
typedef struct DisasContext {
    CPUP2State *env;
    uint32_t pc;            /* PC of the instruction being executed */
    uint32_t next_pc;
    uint32_t prefix;        /* live at entry; a prefix op rewrites it */
    bool is_prefix;
    bool branched;          /* the instruction wrote the PC itself */
    bool unimpl;
} DisasContext;

static uint32_t ip_fetch(CPUP2State *env, uint32_t pc)
{
    return pc < P2_LUT_BASE ? env->cog[pc] : env->lut[pc - P2_LUT_BASE];
}

/* Cog and LUT step by one; hub steps by four. */
static uint32_t ip_next_pc(uint32_t pc)
{
    return pc < P2_HUB_BASE ? pc + 1 : pc + 4;
}

/* --------------------------------------------------------------- operands */

static uint32_t ip_reg(DisasContext *ctx, unsigned idx)
{
    unsigned i = idx & (P2_COG_LONGS - 1);

    /* INA/INB are the pin bus, not storage. */
    if (i == P2_REG_INA || i == P2_REG_INB) {
        return helper_p2_rd_in(ctx->env, i);
    }
    return ctx->env->cog[i];
}

static void ip_set_reg(DisasContext *ctx, unsigned idx, uint32_t v)
{
    unsigned i = idx & (P2_COG_LONGS - 1);

    ctx->env->cog[i] = v;
    if (i >= P2_REG_DIRA && i <= P2_REG_OUTA + 1) {
        helper_p2_reg_published(ctx->env, i, v);
    }
}

/* D, honouring a pending ALTD. */
static uint32_t ip_d_index(DisasContext *ctx, unsigned d)
{
    return (ctx->prefix & P2_PFX_ALTD) ? ctx->env->alt_d : d;
}

static uint32_t ip_ld_d(DisasContext *ctx, unsigned d)
{
    return ip_reg(ctx, ip_d_index(ctx, d));
}

static void ip_st_d(DisasContext *ctx, unsigned d, uint32_t v)
{
    ip_set_reg(ctx, ip_d_index(ctx, d), v);
}

/*
 * A literal D, widened by a pending AUGD.
 *
 * ALTD rewrites the D FIELD, and when D is a LITERAL the substituted
 * field IS the value -- p2core substitutes into `ins.d` before deciding
 * whether to read it as a register or take it as a literal. MaDCore's boot
 * does `altd / setq #0 / wrlong ptra++`, where the literal 0 becomes 2 and the
 * WRLONG is a three-long block transfer rather than a single write.
 */
static uint32_t ip_d_literal(DisasContext *ctx, unsigned d)
{
    uint32_t v = ip_d_index(ctx, d);

    return (ctx->prefix & P2_PFX_AUGD) ? (ctx->env->aug_d | v) : v;
}

/*
 * S. ALTS substitutes a REGISTER address, so an originally immediate S must
 * not stay immediate; otherwise I picks register or literal, and a pending
 * AUGS widens the literal to 32 bits.
 */
static uint32_t ip_get_s(DisasContext *ctx, int i, unsigned s)
{
    if (ctx->prefix & P2_PFX_ALTS) {
        return ip_reg(ctx, ctx->env->alt_s);
    }
    if (!i) {
        return ip_reg(ctx, s);
    }
    return (ctx->prefix & P2_PFX_AUGS) ? (ctx->env->aug_s | s) : s;
}

/* ------------------------------------------------------------------ flags */

static void ip_wz(DisasContext *ctx, int z, uint32_t r)
{
    if (z) {
        ctx->env->z = (r == 0);
    }
}

static void ip_wc(DisasContext *ctx, int c, bool v)
{
    if (c) {
        ctx->env->c = v;
    }
}

static bool ip_cond_true(DisasContext *ctx, int cond)
{
    /* Bit (C<<1)|Z of EEEE selects the outcome. %0000 never matches by that
     * rule, which is why silicon repurposes it as the _RET_ prefix. */
    if (cond == 0) {
        return true;
    }
    return (cond >> ((ctx->env->c << 1) | ctx->env->z)) & 1;
}

/*
 * What a SKIP-CANCELLED slot leaves behind. p2core clears prefixes on a
 * cancelled slot only if the word DECODES -- a word that does not is data, and
 * SKIP over inline data is the whole point -- and then by the same kind-aware
 * rule as any instruction: Q survives any of the four prefix ops, AUG survives
 * only its own kind, ALTD/ALTS survive everything.
 *
 * The four encodings are the only ones this needs to recognise, and they are
 * fixed sub-ops; see `augs`/`augd`/`setq`/`setq2` in insn.decode. Decodability
 * comes from the shared table via interp_p2, which is why an unrecognised word
 * falls through to "keep everything" rather than being guessed at.
 */
static uint32_t ip_cancelled_survivors(uint32_t w)
{
    uint32_t top = (w >> 23) & 0x1F;
    uint32_t op = (w >> 21) & 0x7F;
    uint32_t sel = w & 0x1FF;

    if (top == 0x1E) {                      /* AUGS */
        return P2_PFX_SETQ | P2_PFX_SETQ2 | P2_PFX_AUGS | P2_PFX_ALTD
               | P2_PFX_ALTS;
    }
    if (top == 0x1F) {                      /* AUGD */
        return P2_PFX_SETQ | P2_PFX_SETQ2 | P2_PFX_AUGD | P2_PFX_ALTD
               | P2_PFX_ALTS;
    }
    if (op == 0x6B && (sel == 0x28 || sel == 0x29)) {    /* SETQ / SETQ2 */
        return P2_PFX_SETQ | P2_PFX_SETQ2 | P2_PFX_ALTD | P2_PFX_ALTS;
    }
    /* Anything else that decodes consumes the AUG/SETQ set but not ALTx. */
    return P2_PFX_ALTD | P2_PFX_ALTS;
}

/* An instruction this interpreter does not model yet: stop, rather than drift. */
static bool ip_unimpl(DisasContext *ctx)
{
    ctx->unimpl = true;
    return true;
}

#include "decode-interp.c.inc"

/* ------------------------------------------------------------ the ALU core
 *
 * WC means different things per instruction and getting it wrong is silent:
 * AND/OR/XOR set C to the PARITY of the result, MOV/NOT to bit 31.
 */
static void ip_parity(DisasContext *ctx, int c, int z, uint32_t r)
{
    ip_wz(ctx, z, r);
    ip_wc(ctx, c, ctpop32(r) & 1);
}

static void ip_sign(DisasContext *ctx, int c, int z, uint32_t r)
{
    ip_wz(ctx, z, r);
    ip_wc(ctx, c, r >> 31);
}

static void ip_noflags(DisasContext *ctx, int c, int z, uint32_t r) { }

/* Several ops write Z and leave C entirely alone -- ZEROX and DECOD among
 * them. Reaching for the sign rule instead is silent until a WC turns up. */
static void ip_zonly(DisasContext *ctx, int c, int z, uint32_t r)
{
    ip_wz(ctx, z, r);
}

#define IEXEC_ALU(NAME, EXPR, FLAGS)                                          \
    bool iexec_##NAME(DisasContext *ctx, arg_ds *a)                           \
    {                                                                         \
        uint32_t d = ip_ld_d(ctx, a->d);                                      \
        uint32_t s = ip_get_s(ctx, a->i, a->s);                               \
        uint32_t r = (EXPR);                                                  \
        ip_st_d(ctx, a->d, r);                                                \
        FLAGS(ctx, a->c, a->z, r);                                            \
        return true;                                                          \
    }

IEXEC_ALU(mov,   s,        ip_sign)
IEXEC_ALU(not,   ~s,       ip_sign)
IEXEC_ALU(and,   d & s,    ip_parity)
IEXEC_ALU(andn,  d & ~s,   ip_parity)
IEXEC_ALU(or,    d | s,    ip_parity)
IEXEC_ALU(xor,   d ^ s,    ip_parity)
IEXEC_ALU(muxc,  (d & ~s) | (ctx->env->c ? s : 0),  ip_parity)
IEXEC_ALU(muxnc, (d & ~s) | (ctx->env->c ? 0 : s),  ip_parity)
IEXEC_ALU(muxz,  (d & ~s) | (ctx->env->z ? s : 0),  ip_parity)
IEXEC_ALU(muxnz, (d & ~s) | (ctx->env->z ? 0 : s),  ip_parity)
IEXEC_ALU(zerox, (s & 31) == 31 ? d : d & ((1u << ((s & 31) + 1)) - 1),
          ip_zonly)
IEXEC_ALU(signx, (uint32_t)((int32_t)(d << (31 - (s & 31))) >> (31 - (s & 31))),
          ip_sign)   /* WC reports the sign that got extended: the result MSB */
IEXEC_ALU(decod, 1u << (s & 31), ip_zonly)
IEXEC_ALU(movbyts,
          ((d >> (8 * (s & 3))) & 0xFF)
          | (((d >> (8 * ((s >> 2) & 3))) & 0xFF) << 8)
          | (((d >> (8 * ((s >> 4) & 3))) & 0xFF) << 16)
          | (((d >> (8 * ((s >> 6) & 3))) & 0xFF) << 24), ip_noflags)
/*
 * GETBYTE's C and Z are the byte INDEX, not flags -- the decoder has already
 * spent them -- and the byte comes from S, not D. Nothing is written to C or Z.
 */
bool iexec_getbyte(DisasContext *ctx, arg_ds *a)
{
    unsigned n = ((unsigned)a->c << 1) | (unsigned)a->z;

    ip_st_d(ctx, a->d, (ip_get_s(ctx, a->i, a->s) >> (n * 8)) & 0xFF);
    return true;
}

/* ENCOD's C is "S was non-zero"; ONES sets C to the LOW BIT of the count, not
 * its parity. */
bool iexec_encod(DisasContext *ctx, arg_ds *a)
{
    uint32_t s = ip_get_s(ctx, a->i, a->s);
    uint32_t r = s ? 31 - clz32(s) : 0;

    ip_st_d(ctx, a->d, r);
    ip_wz(ctx, a->z, r);
    ip_wc(ctx, a->c, s != 0);
    return true;
}

bool iexec_ones(DisasContext *ctx, arg_ds *a)
{
    uint32_t r = ctpop32(ip_get_s(ctx, a->i, a->s));

    ip_st_d(ctx, a->d, r);
    ip_wz(ctx, a->z, r);
    ip_wc(ctx, a->c, r & 1);
    return true;
}

bool iexec_rev(DisasContext *ctx, arg_misc *a)
{
    ip_st_d(ctx, a->d, revbit32(ip_ld_d(ctx, a->d)));
    return true;
}

/* ADD/SUB and the carry family. */
bool iexec_add(DisasContext *ctx, arg_ds *a)
{
    uint32_t d = ip_ld_d(ctx, a->d), s = ip_get_s(ctx, a->i, a->s);

    ip_st_d(ctx, a->d, d + s);
    ip_wz(ctx, a->z, d + s);
    ip_wc(ctx, a->c, (uint32_t)(d + s) < d);
    return true;
}

bool iexec_sub(DisasContext *ctx, arg_ds *a)
{
    uint32_t d = ip_ld_d(ctx, a->d), s = ip_get_s(ctx, a->i, a->s);

    ip_st_d(ctx, a->d, d - s);
    ip_wz(ctx, a->z, d - s);
    ip_wc(ctx, a->c, d < s);
    return true;
}

/* SUBR is the reverse subtract: D = S - D, and C is its borrow. */
bool iexec_subr(DisasContext *ctx, arg_ds *a)
{
    uint32_t d = ip_ld_d(ctx, a->d), s = ip_get_s(ctx, a->i, a->s);

    ip_st_d(ctx, a->d, s - d);
    ip_wz(ctx, a->z, s - d);
    ip_wc(ctx, a->c, s < d);
    return true;
}

/* CMP/CMPS/CMPR leave D alone. CMPR is the REVERSE unsigned compare: C is the
 * borrow of (S - D), which is the opposite sense from CMP. */
bool iexec_cmp(DisasContext *ctx, arg_ds *a)
{
    uint32_t d = ip_ld_d(ctx, a->d), s = ip_get_s(ctx, a->i, a->s);

    ip_wz(ctx, a->z, d - s);
    ip_wc(ctx, a->c, d < s);
    return true;
}

bool iexec_cmpr(DisasContext *ctx, arg_ds *a)
{
    uint32_t d = ip_ld_d(ctx, a->d), s = ip_get_s(ctx, a->i, a->s);

    ip_wz(ctx, a->z, s - d);
    ip_wc(ctx, a->c, s < d);
    return true;
}

bool iexec_cmps(DisasContext *ctx, arg_ds *a)
{
    uint32_t d = ip_ld_d(ctx, a->d), s = ip_get_s(ctx, a->i, a->s);

    ip_wz(ctx, a->z, d - s);
    ip_wc(ctx, a->c, (int32_t)d < (int32_t)s);
    return true;
}

/*
 * CMPSUB subtracts only when it fits, and C reports whether it did -- but Z
 * comes from the SUBTRACTION, not from the value written, so a non-fitting
 * CMPSUB can leave D alone and still report Z.
 */
bool iexec_cmpsub(DisasContext *ctx, arg_ds *a)
{
    uint32_t d = ip_ld_d(ctx, a->d), s = ip_get_s(ctx, a->i, a->s);
    bool fits = d >= s;

    ip_st_d(ctx, a->d, fits ? d - s : d);
    ip_wz(ctx, a->z, d - s);
    ip_wc(ctx, a->c, fits);
    return true;
}

/* TEST/TESTN leave D alone and report parity in C. */
bool iexec_test(DisasContext *ctx, arg_ds *a)
{
    uint32_t r = ip_ld_d(ctx, a->d) & ip_get_s(ctx, a->i, a->s);

    ip_parity(ctx, a->c, a->z, r);
    return true;
}

bool iexec_testn(DisasContext *ctx, arg_ds *a)
{
    uint32_t r = ip_ld_d(ctx, a->d) & ~ip_get_s(ctx, a->i, a->s);

    ip_parity(ctx, a->c, a->z, r);
    return true;
}

IEXEC_ALU(neg, -s, ip_sign)

/* ABS reports the sign of its INPUT, which is the bit it removed -- not the
 * sign of the result, which is always clear but for $80000000. */
bool iexec_abs(DisasContext *ctx, arg_ds *a)
{
    uint32_t sv = ip_get_s(ctx, a->i, a->s);
    uint32_t r = (int32_t)sv < 0 ? -sv : sv;

    ip_wc(ctx, a->c, sv >> 31);
    ip_st_d(ctx, a->d, r);
    ip_wz(ctx, a->z, r);
    return true;
}

/* NEGx negates S only when the flag says so; C is the sign of the RESULT. */
#define IEXEC_NEGX(NAME, TAKE)                                                \
    bool iexec_##NAME(DisasContext *ctx, arg_ds *a)                           \
    {                                                                         \
        uint32_t s = ip_get_s(ctx, a->i, a->s);                               \
        uint32_t r = (TAKE) ? -s : s;                                         \
        ip_st_d(ctx, a->d, r);                                                \
        ip_sign(ctx, a->c, a->z, r);                                          \
        return true;                                                          \
    }

IEXEC_NEGX(negc,  ctx->env->c)
IEXEC_NEGX(negnc, !ctx->env->c)
IEXEC_NEGX(negz,  ctx->env->z)
IEXEC_NEGX(negnz, !ctx->env->z)

/* ADDX/SUBX carry C in and out, and Z is STICKY: it only ever clears. */
bool iexec_addx(DisasContext *ctx, arg_ds *a)
{
    uint32_t d = ip_ld_d(ctx, a->d), s = ip_get_s(ctx, a->i, a->s);
    uint64_t w = (uint64_t)d + s + ctx->env->c;
    uint32_t r = (uint32_t)w;

    ip_st_d(ctx, a->d, r);
    if (a->z) {
        ctx->env->z = ctx->env->z && r == 0;
    }
    ip_wc(ctx, a->c, w >> 32);
    return true;
}

bool iexec_subx(DisasContext *ctx, arg_ds *a)
{
    uint32_t d = ip_ld_d(ctx, a->d), s = ip_get_s(ctx, a->i, a->s);
    uint64_t w = (uint64_t)d - s - ctx->env->c;
    uint32_t r = (uint32_t)w;

    ip_st_d(ctx, a->d, r);
    if (a->z) {
        ctx->env->z = ctx->env->z && r == 0;
    }
    ip_wc(ctx, a->c, (w >> 32) & 1);
    return true;
}

/* ADDS/SUBS: C is the sign of the TRUE result, not a carry out. */
#define IEXEC_SIGNED(NAME, ADD)                                               \
    bool iexec_##NAME(DisasContext *ctx, arg_ds *a)                           \
    {                                                                         \
        uint32_t d = ip_ld_d(ctx, a->d), s = ip_get_s(ctx, a->i, a->s);       \
        int64_t t = (ADD) ? (int64_t)(int32_t)d + (int32_t)s                  \
                          : (int64_t)(int32_t)d - (int32_t)s;                 \
        uint32_t r = (ADD) ? d + s : d - s;                                   \
        ip_st_d(ctx, a->d, r);                                                \
        ip_wz(ctx, a->z, r);                                                  \
        ip_wc(ctx, a->c, t < 0);                                              \
        return true;                                                          \
    }

IEXEC_SIGNED(adds, 1)
IEXEC_SIGNED(subs, 0)

/* SUMx adds or subtracts on a flag, and C is again the sign of the TRUE
 * result -- which is why the widening happens before the negation. */
#define IEXEC_SUM(NAME, TAKE)                                                 \
    bool iexec_##NAME(DisasContext *ctx, arg_ds *a)                           \
    {                                                                         \
        uint32_t d = ip_ld_d(ctx, a->d), s = ip_get_s(ctx, a->i, a->s);       \
        bool sub = (TAKE);                                                    \
        int64_t t = sub ? (int64_t)(int32_t)d - (int32_t)s                    \
                        : (int64_t)(int32_t)d + (int32_t)s;                   \
        uint32_t r = sub ? d - s : d + s;                                     \
        ip_st_d(ctx, a->d, r);                                                \
        ip_wz(ctx, a->z, r);                                                  \
        ip_wc(ctx, a->c, t < 0);                                              \
        return true;                                                          \
    }

IEXEC_SUM(sumc,  ctx->env->c)
IEXEC_SUM(sumnc, !ctx->env->c)
IEXEC_SUM(sumz,  ctx->env->z)
IEXEC_SUM(sumnz, !ctx->env->z)

/* FGE/FLE clamp, and C reports whether the clamp fired -- with FLE's sense the
 * OPPOSITE of FGE's, which silicon settles outright. FGES/FLES are the signed
 * twins and their WC follows suit. */
#define IEXEC_CLAMP(NAME, COND)                                               \
    bool iexec_##NAME(DisasContext *ctx, arg_ds *a)                           \
    {                                                                         \
        uint32_t d = ip_ld_d(ctx, a->d), s = ip_get_s(ctx, a->i, a->s);       \
        bool fired = (COND);                                                  \
        uint32_t r = fired ? s : d;                                           \
        ip_st_d(ctx, a->d, r);                                                \
        ip_wz(ctx, a->z, r);                                                  \
        ip_wc(ctx, a->c, fired);                                              \
        return true;                                                          \
    }

IEXEC_CLAMP(fge,  d < s)
IEXEC_CLAMP(fle,  d > s)
IEXEC_CLAMP(fges, (int32_t)d < (int32_t)s)
IEXEC_CLAMP(fles, (int32_t)d > (int32_t)s)

/* INCMOD counts 0..S and wraps to 0 at S; DECMOD counts down and wraps to S. */
bool iexec_incmod(DisasContext *ctx, arg_ds *a)
{
    uint32_t d = ip_ld_d(ctx, a->d), s = ip_get_s(ctx, a->i, a->s);
    bool wrap = d == s;
    uint32_t r = wrap ? 0 : d + 1;

    ip_st_d(ctx, a->d, r);
    ip_wz(ctx, a->z, r);
    ip_wc(ctx, a->c, wrap);
    return true;
}

bool iexec_decmod(DisasContext *ctx, arg_ds *a)
{
    uint32_t d = ip_ld_d(ctx, a->d), s = ip_get_s(ctx, a->i, a->s);
    bool wrap = d == 0;
    uint32_t r = wrap ? s : d - 1;

    ip_st_d(ctx, a->d, r);
    ip_wz(ctx, a->z, r);
    ip_wc(ctx, a->c, wrap);
    return true;
}

/*
 * Shifts: C is the last bit shifted OUT, probed one short of the count -- and
 * at n == 0 the probe is D ITSELF, not the old C. (That is the difference from
 * RCL/RCR below, which DO keep the old C at zero, and conflating the two is
 * silent until a shift by zero with WC turns up.)
 *
 * The two directions read different ends of the probe: left takes bit 31,
 * right takes bit 0.
 */
#define IEXEC_SHL(NAME, RESULT)                                               \
    bool iexec_##NAME(DisasContext *ctx, arg_ds *a)                           \
    {                                                                         \
        uint32_t d = ip_ld_d(ctx, a->d);                                      \
        uint32_t n = ip_get_s(ctx, a->i, a->s) & 31;                          \
        uint32_t r = (RESULT);                                                \
        uint32_t probe = n ? d << (n - 1) : d;                                \
        ip_st_d(ctx, a->d, r);                                                \
        ip_wz(ctx, a->z, r);                                                  \
        ip_wc(ctx, a->c, probe >> 31);                                        \
        return true;                                                          \
    }

#define IEXEC_SHR(NAME, RESULT, PROBE)                                        \
    bool iexec_##NAME(DisasContext *ctx, arg_ds *a)                           \
    {                                                                         \
        uint32_t d = ip_ld_d(ctx, a->d);                                      \
        uint32_t n = ip_get_s(ctx, a->i, a->s) & 31;                          \
        uint32_t r = (RESULT);                                                \
        uint32_t probe = n ? (PROBE) : d;                                     \
        ip_st_d(ctx, a->d, r);                                                \
        ip_wz(ctx, a->z, r);                                                  \
        ip_wc(ctx, a->c, probe & 1);                                          \
        return true;                                                          \
    }

IEXEC_SHL(shl, d << n)
IEXEC_SHL(rol, rol32(d, n))
IEXEC_SHR(shr, d >> n,                      d >> (n - 1))
IEXEC_SHR(ror, ror32(d, n),                 d >> (n - 1))
IEXEC_SHR(sar, (uint32_t)((int32_t)d >> n),
          (uint32_t)((int32_t)d >> (n - 1)))

/*
 * RCL/RCR rotate C *through* D: the vacated bits fill with copies of the
 * incoming C, and C takes the last bit shifted out. The boot ROM assembles pin
 * samples with RCL x,#1, so this is on the SPI receive path.
 */
#define IEXEC_RCX(NAME, LEFT)                                                 \
    bool iexec_##NAME(DisasContext *ctx, arg_ds *a)                           \
    {                                                                         \
        uint32_t d = ip_ld_d(ctx, a->d);                                      \
        uint32_t n = ip_get_s(ctx, a->i, a->s) & 31;                          \
        uint32_t fill = ctx->env->c ? (uint32_t)((1ull << n) - 1) : 0;        \
        uint32_t r, out;                                                      \
        if (LEFT) {                                                           \
            r = (d << n) | fill;                                              \
            out = n == 0 ? ctx->env->c : (d >> (32 - n)) & 1;                 \
        } else {                                                              \
            r = (d >> n) | (n ? fill << (32 - n) : 0);                        \
            out = n == 0 ? ctx->env->c : (d >> (n - 1)) & 1;                  \
        }                                                                     \
        ip_st_d(ctx, a->d, r);                                                \
        ip_wz(ctx, a->z, r);                                                  \
        ip_wc(ctx, a->c, out);                                                \
        return true;                                                          \
    }

IEXEC_RCX(rcl, 1)
IEXEC_RCX(rcr, 0)


/* ------------------------------------------------------- the bit-span family
 *
 * S[4:0] is the base bit and S[9:5]+1 the count, and the span wraps at bit 31
 * -- so the mask is a rotate, not a shift.
 */
static uint32_t ip_span_mask(uint32_t s)
{
    uint32_t count = ((s >> 5) & 31) + 1;
    uint32_t run = (uint32_t)((1ull << count) - 1);

    return rol32(run, s & 31);
}

/*
 * C and Z choose the shape, not the flags: C == Z writes the span (and under
 * WCZ reports the ORIGINAL bit in both flags); C != Z leaves D alone and
 * accumulates into whichever flag is selected.
 */
typedef enum {
    IP_BIT_H, IP_BIT_L, IP_BIT_NOT, IP_BIT_C, IP_BIT_NC, IP_BIT_Z, IP_BIT_NZ,
} IpBitKind;

static bool ip_bitx(DisasContext *ctx, arg_ds *a, IpBitKind kind)
{
    uint32_t d = ip_ld_d(ctx, a->d), s = ip_get_s(ctx, a->i, a->s);
    uint32_t base = s & 31;
    bool bit = (d >> base) & 1;

    if (a->c != a->z) {
        bool t = (kind == IP_BIT_L || kind == IP_BIT_C || kind == IP_BIT_Z)
                 ? bit : !bit;
        bool cur = a->c ? ctx->env->c : ctx->env->z;
        bool v;

        switch (kind) {
        case IP_BIT_L: case IP_BIT_H:   v = t;        break;
        case IP_BIT_C: case IP_BIT_NC:  v = cur && t; break;
        case IP_BIT_Z: case IP_BIT_NZ:  v = cur || t; break;
        default:                        v = cur ^ t;  break;
        }
        if (a->c) {
            ctx->env->c = v;
        } else {
            ctx->env->z = v;
        }
    } else {
        uint32_t mask = ip_span_mask(s), r;

        switch (kind) {
        case IP_BIT_H:   r = d | mask;  break;
        case IP_BIT_L:   r = d & ~mask; break;
        case IP_BIT_NOT: r = d ^ mask;  break;
        case IP_BIT_C: case IP_BIT_NC:
            r = (ctx->env->c != 0) == (kind == IP_BIT_C) ? d | mask : d & ~mask;
            break;
        default:
            r = (ctx->env->z != 0) == (kind == IP_BIT_Z) ? d | mask : d & ~mask;
            break;
        }
        ip_st_d(ctx, a->d, r);
        if (a->c && a->z) {
            ctx->env->c = bit;
            ctx->env->z = bit;
        }
    }
    return true;
}

#define IEXEC_BITX(NAME, KIND)                                                \
    bool iexec_##NAME(DisasContext *ctx, arg_ds *a)                           \
    {                                                                         \
        return ip_bitx(ctx, a, KIND);                                         \
    }

IEXEC_BITX(bith,   IP_BIT_H)
IEXEC_BITX(bitl,   IP_BIT_L)
IEXEC_BITX(bitnot, IP_BIT_NOT)
IEXEC_BITX(bitc,   IP_BIT_C)
IEXEC_BITX(bitnc,  IP_BIT_NC)
IEXEC_BITX(bitz,   IP_BIT_Z)
IEXEC_BITX(bitnz,  IP_BIT_NZ)

/* BITRND is the TESTB+XOR twin: its C != Z accumulate XORs the UN-inverted
 * bit, where BITNOT's XORs the inverted one. */
bool iexec_bitrnd(DisasContext *ctx, arg_ds *a)
{
    uint32_t d = ip_ld_d(ctx, a->d), s = ip_get_s(ctx, a->i, a->s);
    uint32_t base = s & 31;
    bool prior = (d >> base) & 1;

    if (a->c != a->z) {
        if (a->c) {
            ctx->env->c ^= prior;
        } else {
            ctx->env->z ^= prior;
        }
    } else {
        ip_st_d(ctx, a->d, helper_p2_bitrnd(ctx->env, d, s, base));
        ip_wc(ctx, a->c, prior);
        ip_wz(ctx, a->z, 0);
        if (a->z) {
            ctx->env->z = prior;
        }
    }
    return true;
}

/*
 * TESTB/TESTBN report D[S[4:0]] -- except under WCZ, which is not a test at
 * all but the bit-write form: TESTB clears the span, TESTBN sets it, and BOTH
 * flags take the ORIGINAL bit, un-inverted.
 */
static bool ip_testb(DisasContext *ctx, arg_ds *a, bool invert)
{
    uint32_t d = ip_ld_d(ctx, a->d), s = ip_get_s(ctx, a->i, a->s);
    bool bit = (d >> (s & 31)) & 1;

    if (a->c && a->z) {
        uint32_t mask = ip_span_mask(s);

        ip_st_d(ctx, a->d, invert ? d | mask : d & ~mask);
        ctx->env->c = bit;
        ctx->env->z = bit;
    } else {
        bool v = invert ? !bit : bit;

        ip_wc(ctx, a->c, v);
        if (a->z) {
            ctx->env->z = v;
        }
    }
    return true;
}

#define IEXEC_TESTB(NAME, INV)                                                \
    bool iexec_##NAME(DisasContext *ctx, arg_ds *a)                           \
    {                                                                         \
        return ip_testb(ctx, a, INV);                                         \
    }

IEXEC_TESTB(testb,    false)
IEXEC_TESTB(testb_2,  false)
IEXEC_TESTB(testb_3,  false)
IEXEC_TESTB(testbn,   true)
IEXEC_TESTB(testbn_2, true)
IEXEC_TESTB(testbn_3, true)

/* ------------------------------------------------------------ control flow */

static void ip_goto(DisasContext *ctx, uint32_t target)
{
    ctx->env->pc = target;
    ctx->branched = true;
}

/*
 * The 20-bit branch: R selects PC-relative over absolute, and the displacement
 * is a BYTE count even in cog space, where the PC steps one per long -- so it
 * is divided by four there.
 */
static uint32_t ip_rel20(DisasContext *ctx, arg_rel *a)
{
    int32_t disp;

    if (!a->r) {
        return a->imm & 0xFFFFF;
    }
    disp = (int32_t)(a->imm << 12) >> 12;
    return ctx->next_pc < P2_HUB_BASE ? ctx->next_pc + disp / 4
                                      : ctx->next_pc + disp;
}

bool iexec_jmp_3(DisasContext *ctx, arg_rel *a)
{
    ip_goto(ctx, ip_rel20(ctx, a));
    return true;
}

bool iexec_call_2(DisasContext *ctx, arg_rel *a)
{
    helper_p2_push(ctx->env, ctx->next_pc);
    ip_goto(ctx, ip_rel20(ctx, a));
    return true;
}

/* The misc-block forms take their target from D -- a register at L=0 and a
 * literal at L=1, which the decoder has already split into two patterns. */
#define IEXEC_JUMPD(NAME, LITERAL, CALL)                                      \
    bool iexec_##NAME(DisasContext *ctx, arg_misc *a)                         \
    {                                                                         \
        uint32_t t = (LITERAL) ? ip_d_literal(ctx, a->d) : ip_ld_d(ctx, a->d); \
        if (CALL) {                                                           \
            helper_p2_push(ctx->env, ctx->next_pc);                           \
        }                                                                     \
        ip_goto(ctx, t);                                                      \
        return true;                                                          \
    }

IEXEC_JUMPD(jmp,   0, 0)
IEXEC_JUMPD(jmp_2, 1, 0)
IEXEC_JUMPD(call,  0, 1)

/* RET is the L=1 encoding of CALL: no target field, just a pop. */
bool iexec_ret(DisasContext *ctx, arg_misc *a)
{
    ip_goto(ctx, helper_p2_pop(ctx->env));
    return true;
}

/* JMPREL steps D *instructions* from the next PC. */
#define IEXEC_JMPREL(NAME, LITERAL)                                           \
    bool iexec_##NAME(DisasContext *ctx, arg_misc *a)                         \
    {                                                                         \
        uint32_t d = (LITERAL) ? ip_d_literal(ctx, a->d) : ip_ld_d(ctx, a->d); \
        uint32_t step = ctx->env->pc < P2_HUB_BASE ? 1 : 4;                   \
        ip_goto(ctx, ctx->env->pc + d * step);                                \
        return true;                                                          \
    }

IEXEC_JMPREL(jmprel,   0)
IEXEC_JMPREL(jmprel_2, 1)

bool iexec_push(DisasContext *ctx, arg_misc *a)
{
    helper_p2_push(ctx->env, ip_ld_d(ctx, a->d));
    return true;
}

bool iexec_pop(DisasContext *ctx, arg_misc *a)
{
    uint32_t v = helper_p2_pop(ctx->env);

    ip_st_d(ctx, a->d, v);
    ip_wz(ctx, a->z, v);
    return true;
}

/*
 * The *sj forms take a SIGNED 9-bit offset in INSTRUCTIONS when S is an
 * immediate, and an absolute address when S is a register.
 */
static uint32_t ip_rel9(DisasContext *ctx, arg_ds *a)
{
    int32_t off;
    uint32_t step;

    if (!a->i) {
        return ip_reg(ctx, a->s);
    }
    off = (int32_t)(a->s << 23) >> 23;
    step = ctx->next_pc < P2_HUB_BASE ? 1 : 4;
    return ctx->next_pc + off * step;
}

#define IEXEC_DJX(NAME, TAKE)                                                 \
    bool iexec_##NAME(DisasContext *ctx, arg_ds *a)                           \
    {                                                                         \
        uint32_t r = ip_ld_d(ctx, a->d) - 1;                                  \
        ip_st_d(ctx, a->d, r);                                                \
        if (TAKE) {                                                           \
            ip_goto(ctx, ip_rel9(ctx, a));                                    \
        }                                                                     \
        return true;                                                          \
    }

IEXEC_DJX(djnz, r != 0)
IEXEC_DJX(djz,  r == 0)
IEXEC_DJX(djf,  r == UINT32_MAX)
IEXEC_DJX(djnf, r != UINT32_MAX)

#define IEXEC_TJX(NAME, TAKE)                                                 \
    bool iexec_##NAME(DisasContext *ctx, arg_ds *a)                           \
    {                                                                         \
        uint32_t d = ip_ld_d(ctx, a->d);                                      \
        if (TAKE) {                                                           \
            ip_goto(ctx, ip_rel9(ctx, a));                                    \
        }                                                                     \
        return true;                                                          \
    }

IEXEC_TJX(tjz,  d == 0)
IEXEC_TJX(tjnz, d != 0)

/* CALLPA/CALLPB stash D in PA or PB, then call the *sj target. */
#define IEXEC_CALLP(NAME, REG, LITERAL)                                       \
    bool iexec_##NAME(DisasContext *ctx, arg_ds *a)                           \
    {                                                                         \
        uint32_t d = (LITERAL) ? ip_d_literal(ctx, a->d) : ip_ld_d(ctx, a->d); \
        ip_set_reg(ctx, REG, d);                                              \
        helper_p2_push(ctx->env, ctx->next_pc);                               \
        ip_goto(ctx, ip_rel9(ctx, a));                                        \
        return true;                                                          \
    }

IEXEC_CALLP(callpa,   P2_REG_PA, 0)
IEXEC_CALLP(callpa_2, P2_REG_PA, 1)
IEXEC_CALLP(callpb,   P2_REG_PB, 0)
IEXEC_CALLP(callpb_2, P2_REG_PB, 1)

/* CALLD D,S: D takes the return address and the jump goes to S. */
bool iexec_calld(DisasContext *ctx, arg_ds *a)
{
    uint32_t t = ip_get_s(ctx, a->i, a->s);

    ip_st_d(ctx, a->d, ctx->next_pc);
    ip_goto(ctx, t);
    return true;
}

/* Word 0 is NOP on silicon. */
bool iexec_nop_zero(DisasContext *ctx, arg_nop_zero *a)
{
    return true;
}


/* -------------------------------------------------------------- hub memory */

/*
 * An immediate S with bit 8 set is a PTRA/PTRB expression, not an address:
 * %1_S_U_P_IIIII, where bit 7 picks the pointer, bit 6 writes it back, bit 5
 * selects PRE (clear) or POST (set) modify, and the signed 5-bit index is
 * scaled by the transfer size. An AUGS'd S is a 32-bit literal, never a PTR.
 */
static uint32_t ip_hub_addr(DisasContext *ctx, arg_ds *a, int scale)
{
    unsigned s = a->s, reg;
    int32_t idx;
    uint32_t base, modified;

    if (!a->i) {
        return ip_reg(ctx, s);
    }
    if (!(s & 0x100) || (ctx->prefix & P2_PFX_AUGS)) {
        return ip_get_s(ctx, 1, s);
    }
    reg = (s & 0x80) ? P2_REG_PTRB : P2_REG_PTRA;
    idx = (((int32_t)(s & 0x1F)) << 27 >> 27) * scale;
    base = ip_reg(ctx, reg);
    modified = base + idx;
    if (s & 0x40) {
        ip_set_reg(ctx, reg, modified);
    }
    return (s & 0x20) ? base : modified;     /* bit 5 set = POST-modify */
}

/*
 * RDBYTE/RDWORD/RDLONG zero-extend into D, and WC takes the MSB of the
 * TRANSFER -- not of the zero-extended register. Hub access costs nine clocks
 * on top of the instruction's two.
 */
#define IEXEC_HUB_LD(NAME, SCALE, LOAD)                                       \
    bool iexec_##NAME(DisasContext *ctx, arg_ds *a)                           \
    {                                                                         \
        uint32_t addr, v;                                                     \
        if ((SCALE) == 4 && (ctx->prefix & (P2_PFX_SETQ | P2_PFX_SETQ2))) {   \
            helper_p2_block_rdlong(ctx->env, a->s, a->i, a->d);               \
            return true;                                                      \
        }                                                                     \
        addr = ip_hub_addr(ctx, a, SCALE) & P2_HUB_MASK;                      \
        ctx->env->clocks += P2_CLOCKS_HUB_ACCESS;                             \
        v = LOAD(ctx->env, addr);                                             \
        ip_st_d(ctx, a->d, v);                                                \
        ip_wz(ctx, a->z, v);                                                  \
        ip_wc(ctx, a->c, (v >> ((SCALE) * 8 - 1)) & 1);                       \
        return true;                                                          \
    }

IEXEC_HUB_LD(rdbyte, 1, cpu_ldub_data)
IEXEC_HUB_LD(rdword, 2, cpu_lduw_le_data)
IEXEC_HUB_LD(rdlong, 4, cpu_ldl_le_data)

/* The WR forms write D and touch no flags; bit 19 is the L bit here, not WZ. */
#define IEXEC_HUB_ST(NAME, SCALE, STORE, LITERAL)                             \
    bool iexec_##NAME(DisasContext *ctx, arg_ds *a)                           \
    {                                                                         \
        uint32_t v = (LITERAL) ? ip_d_literal(ctx, a->d) : ip_ld_d(ctx, a->d); \
        uint32_t addr;                                                        \
        if ((SCALE) == 4 && (ctx->prefix & P2_PFX_SETQ)) {                    \
            helper_p2_block_wrlong(ctx->env, a->s, a->i,                      \
                                   ((LITERAL) << 16) | a->d);                 \
            return true;                                                      \
        }                                                                     \
        addr = ip_hub_addr(ctx, a, SCALE) & P2_HUB_MASK;                      \
        ctx->env->clocks += P2_CLOCKS_HUB_ACCESS;                             \
        STORE(ctx->env, addr, v);                                             \
        return true;                                                          \
    }

IEXEC_HUB_ST(wrbyte,   1, cpu_stb_data,    0)
IEXEC_HUB_ST(wrbyte_2, 1, cpu_stb_data,    1)
IEXEC_HUB_ST(wrword,   2, cpu_stw_le_data, 0)
IEXEC_HUB_ST(wrword_2, 2, cpu_stw_le_data, 1)
IEXEC_HUB_ST(wrlong,   4, cpu_stl_le_data, 0)
IEXEC_HUB_ST(wrlong_2, 4, cpu_stl_le_data, 1)

/* ----------------------------------------------------------- the prefixes */

/*
 * p2core's clear_prefixes decides what a prefix instruction passes on, and it
 * is asymmetric: Q survives any of the four (so `setq / augs / rdlong ##addr`
 * works, which is how the boot ROM copies its cog image into place), but AUG
 * survives only its OWN kind -- `augs / setq / rdlong` loses the AUGS. ALTD
 * and ALTS are not prefixes to that rule at all: they survive everything and
 * consume nothing, and they clear the others when they run.
 */
#define IP_KEEP_ALT (P2_PFX_ALTD | P2_PFX_ALTS)

#define IEXEC_AUG(NAME, FIELD, BIT)                                           \
    bool iexec_##NAME(DisasContext *ctx, arg_aug *a)                          \
    {                                                                         \
        ctx->env->FIELD = (uint32_t)a->imm << 9;                              \
        ctx->prefix = (ctx->prefix                                            \
                       & (P2_PFX_SETQ | P2_PFX_SETQ2)) | (BIT);               \
        ctx->is_prefix = true;                                                \
        return true;                                                          \
    }

IEXEC_AUG(augs, aug_s, P2_PFX_AUGS)
IEXEC_AUG(augd, aug_d, P2_PFX_AUGD)

#define IEXEC_SETQ(NAME, BIT, LITERAL)                                        \
    bool iexec_##NAME(DisasContext *ctx, arg_misc *a)                         \
    {                                                                         \
        ctx->env->setq = (LITERAL) ? ip_d_literal(ctx, a->d)                  \
                                   : ip_ld_d(ctx, a->d);                      \
        ctx->prefix = (ctx->prefix                                            \
                       & (P2_PFX_SETQ | P2_PFX_SETQ2)) | (BIT);               \
        ctx->is_prefix = true;                                                \
        return true;                                                          \
    }

IEXEC_SETQ(setq,    P2_PFX_SETQ,  0)
IEXEC_SETQ(setq_2,  P2_PFX_SETQ,  1)
IEXEC_SETQ(setq2,   P2_PFX_SETQ2, 0)
IEXEC_SETQ(setq2_2, P2_PFX_SETQ2, 1)

/*
 * ALTD/ALTS: S[8:0] is the offset added to D to form the substituted field,
 * and S[17:9] is a SIGNED increment written back to the D register. flexspin's
 * FCACHE depends on the second half.
 */
#define IEXEC_ALTX(NAME, FIELD, BIT)                                          \
    bool iexec_##NAME(DisasContext *ctx, arg_ds *a)                           \
    {                                                                         \
        uint32_t d = ip_ld_d(ctx, a->d), sv = ip_get_s(ctx, a->i, a->s);      \
        int32_t inc = (int32_t)((sv >> 9) & 0x1FF) << 23 >> 23;               \
        ctx->env->FIELD = (d + sv) & 0x1FF;                                   \
        ip_st_d(ctx, a->d, d + inc);                                          \
        ctx->prefix = (BIT);                                                  \
        ctx->is_prefix = true;                                                \
        return true;                                                          \
    }

IEXEC_ALTX(altd, alt_d, P2_PFX_ALTD)
IEXEC_ALTX(alts, alt_s, P2_PFX_ALTS)

/* ----------------------------------------------------------------- pins */

/* WRPIN/WXPIN/WYPIN take the PIN from S and the VALUE from D. */
#define IEXEC_PINCFG(NAME, HELPER, LITERAL)                                   \
    bool iexec_##NAME(DisasContext *ctx, arg_ds *a)                           \
    {                                                                         \
        uint32_t v = (LITERAL) ? ip_d_literal(ctx, a->d) : ip_ld_d(ctx, a->d); \
        HELPER(ctx->env, ip_get_s(ctx, a->i, a->s), v);                       \
        return true;                                                          \
    }

IEXEC_PINCFG(wrpin,   helper_p2_wrpin, 0)
IEXEC_PINCFG(wrpin_2, helper_p2_wrpin, 1)
IEXEC_PINCFG(wxpin,   helper_p2_wxpin, 0)
IEXEC_PINCFG(wxpin_2, helper_p2_wxpin, 1)
IEXEC_PINCFG(wypin,   helper_p2_wypin, 0)
IEXEC_PINCFG(wypin_2, helper_p2_wypin, 1)

/* RDPIN/RQPIN: C means BUSY, not ready. */
#define IEXEC_RDPIN(NAME)                                                     \
    bool iexec_##NAME(DisasContext *ctx, arg_ds *a)                           \
    {                                                                         \
        uint64_t packed = helper_p2_rdpin(ctx->env,                           \
                                          ip_get_s(ctx, a->i, a->s));         \
        ip_st_d(ctx, a->d, (uint32_t)packed);                                 \
        ip_wc(ctx, a->c, packed >> 32);                                       \
        return true;                                                          \
    }

IEXEC_RDPIN(rdpin)
IEXEC_RDPIN(rdpin_2)
IEXEC_RDPIN(rqpin)
IEXEC_RDPIN(rqpin_2)

/* TESTP takes its pin from D, not S. */
#define IEXEC_TESTP(NAME)                                                     \
    bool iexec_##NAME(DisasContext *ctx, arg_misc *a)                         \
    {                                                                         \
        uint32_t pin = a->i ? ip_d_literal(ctx, a->d) : ip_ld_d(ctx, a->d);   \
        bool v = helper_p2_testp(ctx->env, pin);                              \
        ip_wc(ctx, a->c, v);                                                  \
        if (a->z) {                                                           \
            ctx->env->z = v;                                                  \
        }                                                                     \
        return true;                                                          \
    }

IEXEC_TESTP(testp)
IEXEC_TESTP(testp_2)
IEXEC_TESTP(testp_3)

#define IEXEC_PINOP(NAME, OP)                                                 \
    bool iexec_##NAME(DisasContext *ctx, arg_misc *a)                         \
    {                                                                         \
        uint32_t pin = a->i ? ip_d_literal(ctx, a->d) : ip_ld_d(ctx, a->d);   \
        helper_p2_pinop(ctx->env, pin, OP);                                   \
        return true;                                                          \
    }

IEXEC_PINOP(dirl,     P2_PINOP_DIRL)
IEXEC_PINOP(dirl_2,   P2_PINOP_DIRL)
IEXEC_PINOP(dirh,     P2_PINOP_DIRH)
IEXEC_PINOP(dirh_2,   P2_PINOP_DIRH)
IEXEC_PINOP(fltl,     P2_PINOP_FLTL)
IEXEC_PINOP(fltl_2,   P2_PINOP_FLTL)
IEXEC_PINOP(flth,     P2_PINOP_FLTH)
IEXEC_PINOP(flth_2,   P2_PINOP_FLTH)
IEXEC_PINOP(drvl,     P2_PINOP_DRVL)
IEXEC_PINOP(drvl_2,   P2_PINOP_DRVL)
IEXEC_PINOP(drvh,     P2_PINOP_DRVH)
IEXEC_PINOP(drvh_2,   P2_PINOP_DRVH)
IEXEC_PINOP(outl,     P2_PINOP_OUTL)
IEXEC_PINOP(outl_2,   P2_PINOP_OUTL)
IEXEC_PINOP(outh,     P2_PINOP_OUTH)
IEXEC_PINOP(outh_2,   P2_PINOP_OUTH)
IEXEC_PINOP(drvc,     P2_PINOP_DRVC)
IEXEC_PINOP(drvc_2,   P2_PINOP_DRVC)
IEXEC_PINOP(drvnc,    P2_PINOP_DRVNC)
IEXEC_PINOP(drvnc_2,  P2_PINOP_DRVNC)
IEXEC_PINOP(drvz,     P2_PINOP_DRVZ)
IEXEC_PINOP(drvz_2,   P2_PINOP_DRVZ)
IEXEC_PINOP(drvnz,    P2_PINOP_DRVNZ)
IEXEC_PINOP(drvnz_2,  P2_PINOP_DRVNZ)
IEXEC_PINOP(drvnot,   P2_PINOP_DRVNOT)
IEXEC_PINOP(drvnot_2, P2_PINOP_DRVNOT)

/* ------------------------------------------------- CORDIC, locks, the rest */

#define IEXEC_MISC_D(NAME, LITERAL, BODY)                                     \
    bool iexec_##NAME(DisasContext *ctx, arg_misc *a)                         \
    {                                                                         \
        uint32_t d = (LITERAL) ? ip_d_literal(ctx, a->d) : ip_ld_d(ctx, a->d); \
        BODY;                                                                 \
        return true;                                                          \
    }

IEXEC_MISC_D(waitx,   0, ctx->env->clocks += d)
IEXEC_MISC_D(waitx_2, 1, ctx->env->clocks += d)
IEXEC_MISC_D(cogstop,   0, helper_p2_cogstop(ctx->env, d))
IEXEC_MISC_D(cogstop_2, 1, helper_p2_cogstop(ctx->env, d))
IEXEC_MISC_D(lockret,   0, helper_p2_lockret(ctx->env, d))
IEXEC_MISC_D(lockret_2, 1, helper_p2_lockret(ctx->env, d))
IEXEC_MISC_D(skip,   0, helper_p2_skip_arm(ctx->env, d))
IEXEC_MISC_D(skip_2, 1, helper_p2_skip_arm(ctx->env, d))

/* HUBSET records a clock mode and nothing else. */
bool iexec_hubset(DisasContext *ctx, arg_misc *a)   { return true; }
bool iexec_hubset_2(DisasContext *ctx, arg_misc *a) { return true; }

#define IEXEC_LOCKREL(NAME, LITERAL)                                          \
    bool iexec_##NAME(DisasContext *ctx, arg_misc *a)                         \
    {                                                                         \
        uint32_t d = (LITERAL) ? ip_d_literal(ctx, a->d) : ip_ld_d(ctx, a->d); \
        helper_p2_lockrel(ctx->env, d);                                       \
        ip_wc(ctx, a->c, false);                                              \
        return true;                                                          \
    }

IEXEC_LOCKREL(lockrel,   0)
IEXEC_LOCKREL(lockrel_2, 1)

#define IEXEC_LOCKTRY(NAME, LITERAL)                                          \
    bool iexec_##NAME(DisasContext *ctx, arg_misc *a)                         \
    {                                                                         \
        uint32_t d = (LITERAL) ? ip_d_literal(ctx, a->d) : ip_ld_d(ctx, a->d); \
        ip_wc(ctx, a->c, helper_p2_locktry(ctx->env, d));                     \
        return true;                                                          \
    }

IEXEC_LOCKTRY(locktry,   0)
IEXEC_LOCKTRY(locktry_2, 1)

/* LOCKNEW writes C only when it SUCCEEDS; the helper owns that asymmetry. */
#define IEXEC_LOCKNEW(NAME)                                                   \
    bool iexec_##NAME(DisasContext *ctx, arg_misc *a)                         \
    {                                                                         \
        ip_st_d(ctx, a->d, helper_p2_locknew(ctx->env, a->c));                \
        return true;                                                          \
    }

IEXEC_LOCKNEW(locknew)
IEXEC_LOCKNEW(locknew_2)

#define IEXEC_COGID(NAME)                                                     \
    bool iexec_##NAME(DisasContext *ctx, arg_misc *a)                         \
    {                                                                         \
        ip_st_d(ctx, a->d, ctx->env->cogid);                                  \
        ip_wc(ctx, a->c, false);                                              \
        return true;                                                          \
    }

IEXEC_COGID(cogid)
IEXEC_COGID(cogid_2)

/* GETCT's WC selects the HIGH half of the 64-bit counter. */
#define IEXEC_GETCT(NAME)                                                     \
    bool iexec_##NAME(DisasContext *ctx, arg_misc *a)                         \
    {                                                                         \
        uint64_t t = ctx->env->clocks;                                        \
        ip_st_d(ctx, a->d, a->c ? (uint32_t)(t >> 32) : (uint32_t)t);         \
        return true;                                                          \
    }

IEXEC_GETCT(getct)
IEXEC_GETCT(getct_2)

#define IEXEC_GETQ(NAME, FIELD)                                               \
    bool iexec_##NAME(DisasContext *ctx, arg_misc *a)                         \
    {                                                                         \
        uint32_t v = ctx->env->FIELD;                                         \
        ip_st_d(ctx, a->d, v);                                                \
        ip_wz(ctx, a->z, v);                                                  \
        return true;                                                          \
    }

IEXEC_GETQ(getqx,   qx)
IEXEC_GETQ(getqx_2, qx)
IEXEC_GETQ(getqy,   qy)
IEXEC_GETQ(getqy_2, qy)

/* Bit 19 is D's L bit in the Q block, not WZ. */
#define IEXEC_QOP(NAME, LITERAL, BODY)                                        \
    bool iexec_##NAME(DisasContext *ctx, arg_ds *a)                           \
    {                                                                         \
        uint32_t d = (LITERAL) ? ip_d_literal(ctx, a->d) : ip_ld_d(ctx, a->d); \
        uint32_t sv = ip_get_s(ctx, a->i, a->s);                              \
        BODY;                                                                 \
        return true;                                                          \
    }

#define IP_QMUL                                                               \
    do {                                                                      \
        uint64_t p = (uint64_t)d * sv;                                        \
        ctx->env->qx = (uint32_t)p;                                           \
        ctx->env->qy = (uint32_t)(p >> 32);                                   \
    } while (0)

IEXEC_QOP(qmul,      0, IP_QMUL)
IEXEC_QOP(qmul_2,    1, IP_QMUL)
IEXEC_QOP(qdiv,      0, helper_p2_qdiv(ctx->env, d, sv,
                                       !!(ctx->prefix & P2_PFX_SETQ)))
IEXEC_QOP(qdiv_2,    1, helper_p2_qdiv(ctx->env, d, sv,
                                       !!(ctx->prefix & P2_PFX_SETQ)))
IEXEC_QOP(qsqrt,     0, helper_p2_qsqrt(ctx->env, d))
IEXEC_QOP(qsqrt_2,   1, helper_p2_qsqrt(ctx->env, d))
IEXEC_QOP(qrotate,   0, helper_p2_qrotate(ctx->env, d, sv))
IEXEC_QOP(qrotate_2, 1, helper_p2_qrotate(ctx->env, d, sv))

/* ADDCT1/2/3 write D as well as arming the deadline, and never touch flags:
 * bits 20:19 are the CT selector, not WC/WZ. Only CT1 is modelled. */
#define IEXEC_ADDCT(NAME)                                                     \
    bool iexec_##NAME(DisasContext *ctx, arg_ds *a)                           \
    {                                                                         \
        uint32_t v = ip_ld_d(ctx, a->d) + ip_get_s(ctx, a->i, a->s);          \
        ip_st_d(ctx, a->d, v);                                                \
        ctx->env->ct1 = v;                                                    \
        return true;                                                          \
    }

IEXEC_ADDCT(addct1)
IEXEC_ADDCT(addct2)
IEXEC_ADDCT(addct3)

/* WAITCT1 jumps the clock to the deadline; the comparison wraps. */
bool iexec_waitct1(DisasContext *ctx, arg_dsel *a)
{
    int32_t delta = (int32_t)(ctx->env->ct1 - (uint32_t)ctx->env->clocks);

    if (delta > 0) {
        ctx->env->clocks += delta;
    }
    return true;
}

/* POLLSE1-4 report not-set on an event this model never raises. */
#define IEXEC_POLLSE(NAME)                                                    \
    bool iexec_##NAME(DisasContext *ctx, arg_dsel *a)                         \
    {                                                                         \
        ip_wc(ctx, a->c, false);                                              \
        if (a->z) {                                                           \
            ctx->env->z = 0;                                                  \
        }                                                                     \
        return true;                                                          \
    }

IEXEC_POLLSE(pollse1)
IEXEC_POLLSE(pollse2)
IEXEC_POLLSE(pollse3)
IEXEC_POLLSE(pollse4)

/* MODCZ rewrites both flags from a truth table in D, indexed by the CURRENT
 * {C,Z} -- so both must be read before either is written. */
bool iexec_modcz(DisasContext *ctx, arg_misc *a)
{
    uint32_t d = ip_d_literal(ctx, a->d);
    unsigned idx = (ctx->env->c << 1) | ctx->env->z;

    if (a->c) {
        ctx->env->c = ((d >> 4) >> idx) & 1;
    }
    if (a->z) {
        ctx->env->z = (d >> idx) & 1;
    }
    return true;
}

/* WRC/WRNC/WRZ/WRNZ put a flag into D and touch no flags of their own; with D
 * a literal, silicon performs no register write at all. */
#define IEXEC_WRFLAG(NAME, FIELD, INVERT, LITERAL)                            \
    bool iexec_##NAME(DisasContext *ctx, arg_misc *a)                         \
    {                                                                         \
        if (!(LITERAL)) {                                                     \
            ip_st_d(ctx, a->d, (INVERT) ? !ctx->env->FIELD                    \
                                        : !!ctx->env->FIELD);                 \
        }                                                                     \
        return true;                                                          \
    }

IEXEC_WRFLAG(wrc,    c, 0, 0)
IEXEC_WRFLAG(wrnc,   c, 1, 0)
IEXEC_WRFLAG(wrz,    z, 0, 0)
IEXEC_WRFLAG(wrnz,   z, 1, 0)
IEXEC_WRFLAG(wrc_2,  c, 0, 1)
IEXEC_WRFLAG(wrnc_2, c, 1, 1)
IEXEC_WRFLAG(wrz_2,  z, 0, 1)
IEXEC_WRFLAG(wrnz_2, z, 1, 1)

/* REP arms a hardware loop over the next D instructions, run S times. */
#define IEXEC_REP(NAME, LITERAL)                                              \
    bool iexec_##NAME(DisasContext *ctx, arg_ds *a)                           \
    {                                                                         \
        uint32_t len = (LITERAL) ? ip_d_literal(ctx, a->d)                    \
                                 : ip_ld_d(ctx, a->d);                        \
        helper_p2_rep(ctx->env, len, ip_get_s(ctx, a->i, a->s), ctx->next_pc); \
        return true;                                                          \
    }

IEXEC_REP(rep,   0)
IEXEC_REP(rep_2, 1)

/* COGINIT may restart THIS cog, in which case the helper has replaced the PC
 * we would otherwise fall through to. */
bool iexec_coginit(DisasContext *ctx, arg_ds *a)
{
    uint32_t d = a->z ? ip_d_literal(ctx, a->d) : ip_ld_d(ctx, a->d);
    uint32_t sv = ip_get_s(ctx, a->i, a->s);
    uint32_t pc_before = ctx->env->pc;

    helper_p2_coginit(ctx->env, d, sv,
                      !!(ctx->prefix & P2_PFX_SETQ), a->c);
    if (ctx->env->pc != pc_before) {
        ctx->branched = true;
    }
    return true;
}

#include "interp_stub.c.inc"

/* --------------------------------------------------------------- the loop */

/*
 * Interpret a RUN of cog-space instructions, not one. Spike 0b measured the
 * mean cog-space run at 46.2 instructions between excursions into hub space,
 * so the helper entry is amortised ~46 ways.
 */
void helper_p2_interp_cog(CPUP2State *env, uint32_t budget)
{
    DisasContext ctx;
    uint32_t n;
    int cond;

    ctx.env = env;
    for (n = 0; n < budget; n++) {
        uint32_t w;

        if (env->pc >= P2_HUB_BASE) {
            return;             /* left cog space: back to translated code */
        }
        /*
         * A whole run happens inside one translation block, so `-d cpu` logs
         * the state once for the block rather than once per instruction. The
         * first instruction's state is the one cpu_tb_exec already printed on
         * entry; the rest have to be printed here, or a cog-space trace cannot
         * be diffed against p2core instruction by instruction.
         */
        if (n && qemu_loglevel_mask(CPU_LOG_TB_CPU)) {
            log_cpu_state(env_cpu(env), 0);
        }
        ctx.pc = env->pc;
        ctx.next_pc = ip_next_pc(ctx.pc);
        ctx.prefix = env->prefix;
        ctx.is_prefix = false;
        ctx.branched = false;
        ctx.unimpl = false;
        w = ip_fetch(env, ctx.pc);
        /* An all-zero word is NOP, and its EEEE field is NOT the _RET_ prefix:
     * p2core decodes it with cond 15 explicitly, because otherwise it is a ROR
     * under %0000 and returns through an empty stack. */
        cond = w ? (int)(w >> 28) : 0xF;

        /*
         * The SKIP gate comes first, and a cancelled slot is never decoded --
         * compilers step over inline DATA that way. It still costs its time
         * (this is SKIP, not SKIPF) and still swallows a pending prefix.
         */
        if (env->skip_left) {
            uint32_t cancel = helper_p2_skip_take(env);

            if (cancel) {
                env->clocks += P2_CLOCKS_PER_INSN;
                env->pc = ctx.next_pc;
                env->prefix &= ip_cancelled_survivors(w);
                continue;
            }
        }

        env->clocks += P2_CLOCKS_PER_INSN;
        env->pc = ctx.next_pc;

        if (!ip_cond_true(&ctx, cond)) {
            /* A cancelled instruction still consumes the pending prefixes,
             * by the same kind-aware rule as one that ran: a condition-false
             * AUGS keeps an already-pending aug_s, and ALTx survives either
             * way. */
            env->prefix &= ip_cancelled_survivors(w);
            continue;
        }

        if (!interp_p2(&ctx, w) || ctx.unimpl) {
            env->pc = ctx.pc;
            env->clocks -= P2_CLOCKS_PER_INSN;
            helper_p2_unimpl(env, ctx.pc);
        }

        /* A retiring instruction consumes everything, prefix ops included --
         * they have already rewritten ctx.prefix to what they pass on. */
        env->prefix = ctx.is_prefix ? ctx.prefix : 0;

        /* _RET_ prefix: the instruction ran, now return. */
        if (cond == 0 && !ctx.branched) {
            env->pc = helper_p2_pop(env);
        }
        helper_p2_tick_rep(env);
    }
}
