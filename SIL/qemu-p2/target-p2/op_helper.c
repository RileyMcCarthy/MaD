/*
 * Propeller 2 helpers: the cog-exec interpreter and the pin bus.
 * SPDX-License-Identifier: LGPL-2.1-or-later
 */
#include "qemu/osdep.h"
#include "cpu.h"
#include "exec/helper-proto.h"
#include "accel/tcg/cpu-ldst.h"
#include "qemu/log.h"
#include "system/runstate.h"
#include "hw/core/cpu.h"
#include "pinbus.h"
#include <math.h>

/*
 * Pin ops are HELPERS, never MemoryRegions, and must never end a translation
 * block (design rules 1 and 2). Spike 0d measured the difference: a helper
 * call that does not end the block is ~0 ns; a forced TB exit is 53.5 ns, and
 * the SD driver bit-bangs one every 1-3 instructions.
 *
 * They forward to whatever P2PinBus is installed (pinbus.h) -- the bring-up
 * model during development, embsim's engine later. Nothing electrical is
 * decided here.
 */

void HELPER(p2_wrpin)(CPUP2State *env, uint32_t pin, uint32_t cfg)
{
    p2_pinbus_ops->wrpin(p2_pinbus_opaque, pin & 63, cfg);
}

void HELPER(p2_wxpin)(CPUP2State *env, uint32_t pin, uint32_t x)
{
    p2_pinbus_ops->wxpin(p2_pinbus_opaque, pin & 63, x);
}

void HELPER(p2_wypin)(CPUP2State *env, uint32_t pin, uint32_t y)
{
    /*
     * A transition-mode smart pin (%00101, mode & $3F == $0A) turns `WYPIN n`
     * into n pad toggles driven in lockstep with the streamer -- loadp2 clocks
     * SPI that way. The bring-up bus never reports that mode, so the path is
     * unreachable today; it halts rather than silently queueing a byte, because
     * a wrong answer there looks like a working SD driver that reads garbage.
     */
    if ((p2_pinbus_ops->pin_cfg(p2_pinbus_opaque, pin & 63) & 0x3F) == 0x0A) {
        helper_p2_unimpl(env, env->pc);
    }
    p2_pinbus_ops->wypin(p2_pinbus_opaque, pin & 63, y);
}

/* Packed so one call can both read the value and report BUSY: value in the low
 * 32 bits, C in bit 32. RDPIN consumes the IN flag, so it cannot be split. */
uint64_t HELPER(p2_rdpin)(CPUP2State *env, uint32_t pin)
{
    bool busy = false;
    uint32_t v = p2_pinbus_ops->rdpin(p2_pinbus_opaque, pin & 63, &busy);

    return (uint64_t)v | ((uint64_t)busy << 32);
}

uint32_t HELPER(p2_testp)(CPUP2State *env, uint32_t pin)
{
    return p2_pinbus_ops->testp(p2_pinbus_opaque, pin & 63) ? 1 : 0;
}

/* A DIRA/DIRB/OUTA/OUTB write was committed to the register file. */
void HELPER(p2_reg_published)(CPUP2State *env, uint32_t reg, uint32_t value)
{
    p2_pinbus_ops->dir_out_changed(p2_pinbus_opaque, env->cogid, reg, value);
}

uint32_t HELPER(p2_rd_in)(CPUP2State *env, uint32_t reg)
{
    return reg == P2_REG_INA ? p2_pinbus_ops->ina(p2_pinbus_opaque)
                             : p2_pinbus_ops->inb(p2_pinbus_opaque);
}

static void p2_publish(CPUP2State *env, unsigned reg, uint32_t v)
{
    env->cog[reg] = v;
    p2_pinbus_ops->dir_out_changed(p2_pinbus_opaque, env->cogid, reg, v);
}

/*
 * DIRL/DIRH/OUTL/OUTH/FLTL/FLTH/DRVL/DRVH/DRVC/DRVNC/DRVZ/DRVNZ/DRVNOT.
 *
 * Which pair of registers a pin lands in is a RUNTIME choice (pin < 32 picks
 * DIRA/OUTA, else DIRB/OUTB), so the whole family is a helper rather than
 * TCG with a computed register offset -- and by Spike 0d a helper that does
 * not end the block is what a pin op should be anyway.
 *
 * The two writes are not commutative. Each publishes to the bus, so a fixed
 * order makes DRVH/DRVL glitch: the pin is briefly driven at the PREVIOUS
 * level. Commit the edge that releases the pad first and the one that drives
 * it last, so the intermediate state is never a wrong drive.
 */
void HELPER(p2_pinop)(CPUP2State *env, uint32_t pinv, uint32_t op)
{
    unsigned pin = pinv & 63;
    uint32_t bit = 1u << (pin & 31);
    unsigned dreg = pin < 32 ? P2_REG_DIRA : P2_REG_DIRA + 1;
    unsigned oreg = pin < 32 ? P2_REG_OUTA : P2_REG_OUTA + 1;
    uint32_t dir = env->cog[dreg], out = env->cog[oreg];
    bool level;

    switch (op) {
    case P2_PINOP_DIRL:  dir &= ~bit; break;
    case P2_PINOP_DIRH:  dir |= bit; break;
    case P2_PINOP_FLTL:  dir &= ~bit; out &= ~bit; break;
    case P2_PINOP_FLTH:  dir &= ~bit; out |= bit; break;
    case P2_PINOP_DRVL:  dir |= bit; out &= ~bit; break;
    case P2_PINOP_DRVH:  dir |= bit; out |= bit; break;
    case P2_PINOP_OUTL:  out &= ~bit; break;
    case P2_PINOP_OUTH:  out |= bit; break;
    /* Drive to a flag: the ROM's spi_cmd shifts the command bit into C and
     * DRVCs it onto the data line. */
    case P2_PINOP_DRVC:
    case P2_PINOP_DRVNC:
        level = (env->c != 0) == (op == P2_PINOP_DRVC);
        dir |= bit;
        if (level) { out |= bit; } else { out &= ~bit; }
        break;
    case P2_PINOP_DRVZ:
    case P2_PINOP_DRVNZ:
        level = (env->z != 0) == (op == P2_PINOP_DRVZ);
        dir |= bit;
        if (level) { out |= bit; } else { out &= ~bit; }
        break;
    default:            /* DRVNOT: toggle */
        dir |= bit;
        out ^= bit;
        break;
    }

    if (dir & bit) {
        p2_publish(env, oreg, out);
        p2_publish(env, dreg, dir);
    } else {
        p2_publish(env, dreg, dir);
        p2_publish(env, oreg, out);
    }
}

/*
 * An instruction the target does not model yet. Halt THIS cog and say which
 * instruction it was -- during bring-up the missing opcode is the thing you
 * need, and silently continuing would let a wrong result propagate.
 *
 * EXCP_DEBUG is the wrong exit here: with no gdbstub attached it lands in
 * cpu_handle_guest_debug and crashes. EXCP_HLT parks the cog instead.
 */
G_NORETURN void helper_p2_unimpl(CPUArchState *env, uint32_t pc)
{
    CPUState *cs = env_cpu(env);
    uint32_t w = 0;

    if (pc >= P2_HUB_BASE) {
        w = cpu_ldl_le_data(env, pc);
    }
    qemu_log_mask(LOG_UNIMP, "p2: unimplemented instruction %08X at $%05X\n", w, pc);
    env->pc = pc;
    env->running = false;
    cs->halted = 1;

    /* When no cog is left running the chip is stopped, so stop the machine --
     * otherwise QEMU idles forever and every harness has to time out. */
    {
        CPUState *o;
        bool any = false;
        CPU_FOREACH(o) {
            if (!o->halted) {
                any = true;
                break;
            }
        }
        if (!any) {
            qemu_system_shutdown_request(SHUTDOWN_CAUSE_GUEST_SHUTDOWN);
        }
    }
    cs->exception_index = EXCP_HLT;
    cpu_loop_exit(cs);
}

/*
 * Cog-exec is INTERPRETED, not translated (Spike 0b). Cog RAM is the register
 * file: translating from it would put the registers and the code in the same
 * page, and QEMU's self-modifying-code trap is per-page and sticky. One call
 * interprets a RUN of instructions -- the firmware's measured mean run is 46.2
 * -- never one call per instruction.
 */
void helper_p2_interp_cog(CPUArchState *env, uint32_t budget)
{
    uint32_t n;

    for (n = 0; n < budget; n++) {
        uint32_t pc = env->pc;
        uint32_t w, cond, op, d, sf, dv, sv, r;

        if (pc >= P2_HUB_BASE) {
            return;             /* left cog space: back to translated code */
        }
        w = (pc < P2_LUT_BASE) ? env->cog[pc] : env->lut[pc - P2_LUT_BASE];

        cond = w >> 28;
        op = (w >> 21) & 0x7F;
        d = (w >> 9) & 0x1FF;
        sf = w & 0x1FF;

        env->pc = pc + 1;
        env->clocks += P2_CLOCKS_PER_INSN;

        /* EEEE: bit ((C<<1)|Z) selects execute. %0000 is the _RET_ prefix. */
        if (cond != 0 && !((cond >> (((env->c & 1) << 1) | (env->z & 1))) & 1)) {
            continue;
        }

        sv = (w & (1u << 18)) ? sf : env->cog[sf];
        dv = env->cog[d];

        switch (op) {
        /* Opcodes are the real PNut-TS encodings -- see generated/insn.decode. */
        case 0x08: r = dv + sv; env->c = (r < dv); break;    /* ADD */
        case 0x0C: r = dv - sv; env->c = (dv < sv); break;   /* SUB */
        case 0x28: r = dv & sv; break;                       /* AND */
        case 0x2A: r = dv | sv; break;                       /* OR  */
        case 0x2B: r = dv ^ sv; break;                       /* XOR */
        case 0x30: r = sv; break;                            /* MOV */
        case 0x31: r = ~sv; break;                           /* NOT */
        default:
            /* Not yet modelled: stop so bring-up notices rather than drifts. */
            env->pc = pc;
            env->clocks -= P2_CLOCKS_PER_INSN;
            helper_p2_unimpl(env, pc);
        }

        env->cog[d] = r;
        env->z = (r == 0);
    }
}

/*
 * The hardware stack is a ring: the index is a runtime value, so push and pop
 * are helpers rather than inline TCG. CALL/RET are ~6.5% of the firmware's
 * instruction stream, and a helper call is ~1-3 ns against the ~53 ns a
 * translation-block exit costs -- the branch itself already pays that.
 */
void HELPER(p2_push)(CPUP2State *env, uint32_t v)
{
    env->stack[env->sp & (P2_STACK_DEPTH - 1)] = v;
    env->sp = (env->sp + 1) & (P2_STACK_DEPTH - 1);
}

uint32_t HELPER(p2_pop)(CPUP2State *env)
{
    env->sp = (env->sp - 1) & (P2_STACK_DEPTH - 1);
    return env->stack[env->sp];
}

/* Runtime-indexed cog access: only a post-ALTx instruction needs it, which
 * Spike 1a measured at 0.0999% of the firmware's instruction stream. */
uint32_t HELPER(p2_cog_rd)(CPUP2State *env, uint32_t idx)
{
    unsigned i = idx & (P2_COG_LONGS - 1);

    if (i == P2_REG_INA || i == P2_REG_INB) {
        return helper_p2_rd_in(env, i);
    }
    return env->cog[i];
}

void HELPER(p2_cog_wr)(CPUP2State *env, uint32_t idx, uint32_t v)
{
    unsigned i = idx & (P2_COG_LONGS - 1);

    env->cog[i] = v;
    if (i >= P2_REG_DIRA && i <= P2_REG_OUTA + 1) {
        p2_pinbus_ops->dir_out_changed(p2_pinbus_opaque, env->cogid, i, v);
    }
}

/*
 * A PTRA/PTRB expression advances by the WHOLE block, not one element, so the
 * address of a SETQ block transfer cannot be folded at translate time: the
 * count is a register. The whole address computation therefore happens here,
 * mirroring p2core's ptr_operand().
 */
static uint32_t p2_block_addr(CPUP2State *env, uint32_t sfield, uint32_t i,
                              uint32_t elements)
{
    uint32_t reg, base, modified;
    int32_t idx;

    if (!i) {
        return env->cog[sfield & (P2_COG_LONGS - 1)];
    }
    if (!(sfield & 0x100) || (env->prefix & P2_PFX_AUGS)) {
        return (env->prefix & P2_PFX_AUGS) ? (env->aug_s | sfield) : sfield;
    }
    reg = (sfield & 0x80) ? P2_REG_PTRB : P2_REG_PTRA;
    idx = ((((int32_t)(sfield & 0x1F)) << 27) >> 27) * 4 * (int32_t)elements;
    base = env->cog[reg];
    modified = base + idx;
    if (sfield & 0x40) {
        env->cog[reg] = modified;
    }
    return (sfield & 0x20) ? base : modified;   /* bit 5 set = POST-modify */
}

/*
 * SETQ + RDLONG is a block read into the register file; SETQ2 + RDLONG fills
 * LUT RAM instead. Folding the two together let the boot ROM's LUT load
 * overwrite the cog registers it had just copied into place.
 */
void HELPER(p2_block_rdlong)(CPUP2State *env, uint32_t sfield, uint32_t i,
                             uint32_t d)
{
    bool lut = env->prefix & P2_PFX_SETQ2;
    uint32_t limit = lut ? P2_LUT_LONGS - 1 : P2_COG_LONGS - 1;
    uint32_t n = env->setq > limit ? limit : env->setq;
    uint32_t addr, k;

    addr = p2_block_addr(env, sfield, i, n + 1);
    env->clocks += P2_CLOCKS_HUB_ACCESS;
    for (k = 0; k <= n; k++) {
        uint32_t v = cpu_ldl_le_data(env, (addr + k * 4) & P2_HUB_MASK);
        if (lut) {
            env->lut[(d + k) & (P2_LUT_LONGS - 1)] = v;
        } else {
            env->cog[(d + k) & (P2_COG_LONGS - 1)] = v;
        }
    }
}

/*
 * SETQ + WRLONG. With D a literal it is a block FILL, not a copy: `setq
 * #len/4-1` / `wrlong #0,p` is what flexcc emits for memset(), and copying
 * from cog register 0 upward instead sprayed FCACHE contents over every
 * memset-initialised struct at boot.
 */
void HELPER(p2_block_wrlong)(CPUP2State *env, uint32_t sfield, uint32_t i,
                             uint32_t dpack)
{
    uint32_t n = env->setq > P2_COG_LONGS - 1 ? P2_COG_LONGS - 1 : env->setq;
    uint32_t d = dpack & 0xFFFF;
    bool literal = dpack >> 16;
    uint32_t addr, k;

    addr = p2_block_addr(env, sfield, i, n + 1);
    env->clocks += P2_CLOCKS_HUB_ACCESS;
    for (k = 0; k <= n; k++) {
        uint32_t v = literal ? d : env->cog[(d + k) & (P2_COG_LONGS - 1)];
        cpu_stl_le_data(env, (addr + k * 4) & P2_HUB_MASK, v);
    }
}

/* ---- CORDIC --------------------------------------------------------------
 *
 * p2core models the solver as plain arithmetic rather than as the iterative
 * CORDIC the silicon runs, and the result queue as two registers. That is the
 * oracle, so it is what this mirrors -- including QDIV's saturation and its
 * divide-by-zero answer, both of which are p2core's choices and not inferred
 * from the hardware.
 */
void HELPER(p2_qdiv)(CPUP2State *env, uint32_t d, uint32_t s, uint32_t has_setq)
{
    /* A preceding SETQ supplies the upper 32 bits of a 64-bit dividend --
     * `_getus` divides the full cycle count that way. */
    uint64_t hi = has_setq ? env->setq : 0;
    uint64_t dividend = (hi << 32) | d;
    uint64_t q;

    if (s == 0) {
        env->qx = UINT32_MAX;
        env->qy = 0;
        return;
    }
    q = dividend / s;
    env->qx = q > UINT32_MAX ? UINT32_MAX : (uint32_t)q;
    env->qy = (uint32_t)(dividend % s);
}

/*
 * p2core writes these results with Rust's float-to-int cast, which SATURATES
 * (and maps NaN to 0). C's cast is undefined outside the range, so the oracle's
 * rule is spelled out here rather than inherited from the compiler.
 */
static uint32_t p2_f64_to_i32(double v)
{
    double t = trunc(v);

    if (isnan(t)) {
        return 0;
    }
    if (t > 2147483647.0) {
        return 0x7FFFFFFFu;
    }
    if (t < -2147483648.0) {
        return 0x80000000u;
    }
    return (uint32_t)(int32_t)t;
}

static uint32_t p2_f64_to_u32(double v)
{
    double t = trunc(v);

    if (isnan(t) || t < 0.0) {
        return 0;
    }
    if (t > 4294967295.0) {
        return 0xFFFFFFFFu;
    }
    return (uint32_t)t;
}

void HELPER(p2_qsqrt)(CPUP2State *env, uint32_t d)
{
    env->qx = p2_f64_to_u32(sqrt((double)d));
}

void HELPER(p2_qrotate)(CPUP2State *env, uint32_t d, uint32_t s)
{
    double theta = (double)s * (2.0 * M_PI) / 4294967296.0;

    env->qx = p2_f64_to_i32((double)d * cos(theta));
    env->qy = p2_f64_to_i32((double)d * sin(theta));
}

/* ---- the lock pool -------------------------------------------------------
 *
 * MACHINE state, not CPU state: one pool shared by all eight cogs, exactly as
 * p2core has one `locks` array on Machine. Single-threaded round-robin TCG
 * (design D1) is what makes touching it from any cog's helper safe without a
 * mutex -- and what makes the result deterministic.
 */
static uint16_t p2_lock_alloc;                  /* bit per lock: allocated */
static uint16_t p2_lock_held;                   /* bit per lock: taken */
static uint8_t  p2_lock_owner[P2_NUM_LOCKS];

uint32_t HELPER(p2_locknew)(CPUP2State *env, uint32_t wc)
{
    int i;

    for (i = 0; i < P2_NUM_LOCKS; i++) {
        if (!(p2_lock_alloc & (1u << i))) {
            p2_lock_alloc |= 1u << i;
            if (wc) {
                env->c = 0;
            }
            return i;
        }
    }
    /*
     * Exhausted. P2-EVAL `_locknew` after 16 allocations writes 15 into D --
     * the last valid id, not 0 and not "leave D unchanged" -- and does NOT
     * write C, which is why the flag update above is inside the success path.
     */
    return P2_NUM_LOCKS - 1;
}

void HELPER(p2_lockret)(CPUP2State *env, uint32_t d)
{
    unsigned id = d & (P2_NUM_LOCKS - 1);

    p2_lock_alloc &= ~(1u << id);
    p2_lock_held &= ~(1u << id);
}

uint32_t HELPER(p2_locktry)(CPUP2State *env, uint32_t d)
{
    unsigned id = d & (P2_NUM_LOCKS - 1);

    if (!(p2_lock_held & (1u << id))) {
        p2_lock_held |= 1u << id;
        p2_lock_owner[id] = env->cogid;
        return 1;
    }
    /* Re-taking a lock this cog already holds succeeds. */
    return p2_lock_owner[id] == env->cogid;
}

void HELPER(p2_lockrel)(CPUP2State *env, uint32_t d)
{
    unsigned id = d & (P2_NUM_LOCKS - 1);

    if ((p2_lock_held & (1u << id)) && p2_lock_owner[id] == env->cogid) {
        p2_lock_held &= ~(1u << id);
    }
}

/* COGSTOP halts a cog -- possibly this one, which then never returns here. */
void HELPER(p2_cogstop)(CPUP2State *env, uint32_t d)
{
    unsigned target = d & 7;
    CPUState *other = qemu_get_cpu(target);
    CPUP2State *oenv;

    if (!other) {
        return;
    }
    oenv = cpu_env(other);
    oenv->running = false;
    other->halted = 1;
    if (target == env->cogid) {
        CPUState *cs = env_cpu(env);
        cs->exception_index = EXCP_HLT;
        cpu_loop_exit(cs);
    }
}

/* ---- REP and SKIP --------------------------------------------------------
 *
 * REP D,S repeats D instructions S times: D is the block LENGTH and S the
 * repeat count. Swapping them makes the block one instruction too long, which
 * in an FCACHE'd loop runs the trailing `_ret_` on every iteration -- popping
 * the call stack each time until it underflows.
 */
void HELPER(p2_rep)(CPUP2State *env, uint32_t len, uint32_t count,
                    uint32_t first)
{
    uint32_t step = first < P2_HUB_BASE ? 1 : 4;

    if (count == 0 || len == 0) {
        env->rep_left = 0;
        return;
    }
    env->rep_left = count;
    env->rep_first = first;
    env->rep_last = first + (len - 1) * step;
}

/* Run after every instruction while a REP is live -- which is why the
 * translator only emits it in blocks the TB key says are inside one. */
void HELPER(p2_tick_rep)(CPUP2State *env)
{
    if (!env->rep_left || env->pc <= env->rep_last) {
        return;
    }
    if (env->rep_left > 1) {
        env->rep_left--;
        env->pc = env->rep_first;
    } else {
        env->rep_left = 0;
    }
}

void HELPER(p2_skip_arm)(CPUP2State *env, uint32_t pattern)
{
    env->skip_pattern = pattern;
    env->skip_left = 32;
}

/*
 * Consume one bit of the SKIP pattern and say whether this slot is cancelled.
 *
 * A cancelled slot is never DECODED on silicon, and compilers use exactly
 * that to step over inline data: loadp2's flash stub opens with a SKIP over
 * its own header -- a checksum long and a flag long -- so decoding those first
 * trapped on the checksum, whose value depends on the payload. The translator
 * therefore emits this check ahead of everything, including the
 * unimplemented-instruction trap.
 *
 * A cancelled instruction still costs its time (this is SKIP, not SKIPF) and
 * still swallows any pending prefix, like a failed condition.
 */
uint32_t HELPER(p2_skip_take)(CPUP2State *env)
{
    uint32_t cancel;

    if (!env->skip_left) {
        return 0;
    }
    cancel = env->skip_pattern & 1;
    env->skip_pattern >>= 1;
    env->skip_left--;
    if (cancel) {
        env->prefix = 0;
    }
    return cancel;
}

/* ---- COGINIT -------------------------------------------------------------
 *
 * Load $1F8 longs from hub into the target cog and run it in cog-exec at $000,
 * with PTRA from the preceding SETQ and PTRB = the source address. Every MaD
 * cog runs the same kernel and branches on PTRA, so this one path serves both
 * the boot trampoline and all seven workers.
 *
 * Safe to reach into another CPU's state directly because the accelerator is
 * single-threaded round-robin (design D1): only one cog is executing, which is
 * also what makes the interleaving deterministic.
 */
void HELPER(p2_coginit)(CPUP2State *env, uint32_t d, uint32_t s,
                        uint32_t has_setq, uint32_t wc)
{
    uint32_t ptra = has_setq ? env->setq : 0;
    bool want_free = (d & 0x10) != 0;
    bool hubexec = (d & 0x20) != 0;
    CPUState *other;
    CPUP2State *o;
    int target = -1, i;

    if (want_free) {
        for (i = 0; i < P2_NUM_COGS; i++) {
            CPUState *c = qemu_get_cpu(i);
            if (c && !cpu_env(c)->running) {
                target = i;
                break;
            }
        }
        if (target < 0) {
            qemu_log_mask(LOG_GUEST_ERROR,
                          "p2: COGINIT found no free cog (cog %u, pc $%05X)\n",
                          env->cogid, env->pc);
            helper_p2_unimpl(env, env->pc);
        }
    } else {
        target = d & 7;
    }

    other = qemu_get_cpu(target);
    if (!other) {
        return;
    }
    o = cpu_env(other);

    memset(o->cog, 0, sizeof(o->cog));
    memset(o->lut, 0, sizeof(o->lut));
    memset(o->stack, 0, sizeof(o->stack));
    o->sp = 0;
    o->c = 0;
    o->z = 0;
    o->prefix = 0;
    o->rep_left = 0;
    o->skip_left = 0;
    o->qx = 0;
    o->qy = 0;
    o->ct1 = 0;

    if (hubexec) {
        o->pc = s;
    } else {
        for (i = 0; i < P2_COGINIT_LOAD_LONGS; i++) {
            o->cog[i] = cpu_ldl_le_data(env, (s + i * 4) & P2_HUB_MASK);
        }
        o->pc = 0;
    }
    o->cog[P2_REG_PTRA] = ptra;
    o->cog[P2_REG_PTRB] = s;
    o->running = true;
    /*
     * A cog starts NOW: it inherits the starter's clock, so the machine's time
     * (the minimum over running cogs) does not collapse to zero the instant a
     * cog is launched mid-run, and the new cog joins the time frontier instead
     * of burning a catch-up burst.
     */
    o->clocks = env->clocks;
    other->halted = 0;
    qemu_cpu_kick(other);

    /* C reports FAILURE on the P2 -- flexspin emits `if_b neg result1,#1`
     * after COGINIT WC. (spinsim disagrees; silicon and flexspin do not.) */
    if (wc) {
        env->c = 0;
    }
}
