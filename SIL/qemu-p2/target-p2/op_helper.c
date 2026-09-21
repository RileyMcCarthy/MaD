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

/*
 * Pin ops are HELPERS, never MemoryRegions, and must never end a translation
 * block (design rules 1 and 2). Spike 0d measured the difference: a helper
 * call that does not end the block is ~0 ns; a forced TB exit is 53.5 ns, and
 * the SD driver bit-bangs one every 1-3 instructions.
 *
 * These are the seam where embsim's PinBus will be plugged in; for now they are
 * inert so the target can be brought up without a board.
 */
static uint64_t p2_pin_sink;

void helper_p2_wrpin(uint32_t pin, uint32_t cfg) { p2_pin_sink += pin ^ cfg; }
void helper_p2_wxpin(uint32_t pin, uint32_t x)   { p2_pin_sink += pin ^ x; }
void helper_p2_wypin(uint32_t pin, uint32_t y)   { p2_pin_sink += pin ^ y; }
uint32_t helper_p2_rdpin(uint32_t pin)           { return (uint32_t)(p2_pin_sink + pin); }
uint32_t helper_p2_testp(uint32_t pin)           { return (uint32_t)(p2_pin_sink >> (pin & 31)) & 1; }

void helper_p2_dir_out(CPUArchState *env, uint32_t reg, uint32_t value)
{
    /* DIRA/DIRB/OUTA/OUTB are per-cog; the pad sees the OR across all eight. */
    p2_pin_sink += (uint64_t)env->cogid << 32 | ((uint64_t)reg << 16) | value;
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
    return env->cog[idx & (P2_COG_LONGS - 1)];
}

void HELPER(p2_cog_wr)(CPUP2State *env, uint32_t idx, uint32_t v)
{
    env->cog[idx & (P2_COG_LONGS - 1)] = v;
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
