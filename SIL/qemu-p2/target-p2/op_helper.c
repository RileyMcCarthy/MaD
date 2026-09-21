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
