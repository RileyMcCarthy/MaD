/*
 * Parallax Propeller 2 CPU. SPDX-License-Identifier: LGPL-2.1-or-later
 *
 * One QEMU vCPU is one cog (design D1): eight of them under single-threaded
 * TCG with icount, which is what makes the interleaving deterministic.
 * Spike 0c measured that eight vCPUs cost essentially nothing over one -- only
 * the scheduling quantum matters, and the firmware tolerates 48.
 */
#include "qemu/osdep.h"
#include "qapi/error.h"
#include "qemu/qemu-print.h"
#include "cpu.h"
#include "exec/cputlb.h"
#include "exec/target_page.h"
#include "exec/translation-block.h"
#include "accel/tcg/cpu-ops.h"
#include "hw/qdev-properties.h"
#include "hw/core/sysemu-cpu-ops.h"

static void p2_cpu_set_pc(CPUState *cs, vaddr value)
{
    cpu_env(cs)->pc = value;
}

static vaddr p2_cpu_get_pc(CPUState *cs)
{
    return cpu_env(cs)->pc;
}

static bool p2_cpu_has_work(CPUState *cs)
{
    return cpu_env(cs)->running;
}

static int p2_cpu_mmu_index(CPUState *cs, bool ifetch)
{
    return 0;
}

static TCGTBCPUState p2_get_tb_cpu_state(CPUState *cs)
{
    CPUP2State *env = cpu_env(cs);

    return (TCGTBCPUState){ .pc = env->pc,
                            .flags = (env->prefix & P2_PFX_MASK)
                                     | (env->rep_left ? P2_TB_REP : 0)
                                     | (env->skip_left ? P2_TB_SKIP : 0),
                            .cs_base = 0 };
}

static void p2_cpu_synchronize_from_tb(CPUState *cs, const TranslationBlock *tb)
{
    tcg_debug_assert(!tcg_cflags_has(cs, CF_PCREL));
    cpu_env(cs)->pc = tb->pc;
}

static void p2_restore_state_to_opc(CPUState *cs, const TranslationBlock *tb,
                                    const uint64_t *data)
{
    cpu_env(cs)->pc = data[0];
}

bool p2_cpu_tlb_fill(CPUState *cs, vaddr address, int size,
                     MMUAccessType access_type, int mmu_idx,
                     bool probe, uintptr_t retaddr)
{
    /* Hub RAM is flat and always present; cog RAM and LUT are CPU state and
     * never reach the TLB at all. */
    tlb_set_page(cs, address & TARGET_PAGE_MASK, address & TARGET_PAGE_MASK,
                 PAGE_READ | PAGE_WRITE | PAGE_EXEC, mmu_idx, TARGET_PAGE_SIZE);
    return true;
}

hwaddr p2_cpu_get_phys_page_debug(CPUState *cs, vaddr addr)
{
    return addr;
}

void p2_cpu_do_interrupt(CPUState *cs) { }

bool p2_cpu_exec_interrupt(CPUState *cs, int interrupt_request)
{
    return false;
}

static void p2_cpu_dump_state(CPUState *cs, FILE *f, int flags)
{
    CPUP2State *env = cpu_env(cs);
    int i;

    /* One line per state, in the exact shape the differential harness diffs
     * against p2core. Registers 0..31 are what the generated tests target. */
    qemu_fprintf(f, "P2STATE cog=%u pc=%05X c=%u z=%u sp=%u clk=%" PRIu64,
                 env->cogid, env->pc, env->c, env->z, env->sp, env->clocks);
    for (i = 0; i < 32; i++) {
        qemu_fprintf(f, " %08X", env->cog[i]);
    }
    /* PA/PB/PTRA/PTRB and the rest of the special block: CALLPA writes PA and
     * every PTR expression writes PTRA/PTRB, so without these a whole class of
     * divergence is invisible to the diff. */
    qemu_fprintf(f, " |");
    for (i = 0x1F0; i < 0x200; i++) {
        qemu_fprintf(f, " %08X", env->cog[i]);
    }
    qemu_fprintf(f, "\n");
}

static void p2_cpu_reset_hold(Object *obj, ResetType type)
{
    CPUState *cs = CPU(obj);
    P2CPUClass *pcc = P2_CPU_GET_CLASS(obj);
    CPUP2State *env = cpu_env(cs);

    if (pcc->parent_phases.hold) {
        pcc->parent_phases.hold(obj, type);
    }
    memset(env->cog, 0, sizeof(env->cog));
    memset(env->lut, 0, sizeof(env->lut));
    env->pc = 0;
    env->c = 0;
    env->z = 0;
    env->clocks = 0;
    /*
     * The boot ROM launches cog 0; the rest wait for COGINIT. They must be
     * halted at the CPU level too, or cpu_exec starts translating them at
     * PC 0 -- which is cog space, and they have no code there yet.
     */
    env->rep_left = 0;
    env->skip_left = 0;
    env->prefix = 0;
    env->sp = 0;
    memset(env->stack, 0, sizeof(env->stack));
    env->running = (env->cogid == 0);
    cs->halted = !env->running;
}

static void p2_cpu_realizefn(DeviceState *dev, Error **errp)
{
    CPUState *cs = CPU(dev);
    P2CPUClass *pcc = P2_CPU_GET_CLASS(dev);
    Error *local_err = NULL;

    cpu_exec_realizefn(cs, &local_err);
    if (local_err != NULL) {
        error_propagate(errp, local_err);
        return;
    }
    qemu_init_vcpu(cs);
    cpu_reset(cs);
    pcc->parent_realize(dev, errp);
}

static const Property p2_cpu_properties[] = {
    DEFINE_PROP_UINT32("cogid", ArchCPU, env.cogid, 0),
};

static const struct SysemuCPUOps p2_sysemu_ops = {
    .has_work = p2_cpu_has_work,
    .get_phys_page_debug = p2_cpu_get_phys_page_debug,
};

static const TCGCPUOps p2_tcg_ops = {
    .guest_default_memory_order = 0,
    .mttcg_supported = false,          /* determinism: single-threaded TCG (D1) */
    .initialize = p2_cpu_tcg_init,
    .translate_code = p2_cpu_translate_code,
    .get_tb_cpu_state = p2_get_tb_cpu_state,
    .synchronize_from_tb = p2_cpu_synchronize_from_tb,
    .restore_state_to_opc = p2_restore_state_to_opc,
    .mmu_index = p2_cpu_mmu_index,
    .cpu_exec_interrupt = p2_cpu_exec_interrupt,
    .cpu_exec_halt = p2_cpu_has_work,
    .cpu_exec_reset = cpu_reset,
    .tlb_fill = p2_cpu_tlb_fill,
    .do_interrupt = p2_cpu_do_interrupt,
    .pointer_wrap = cpu_pointer_wrap_uint32,
};

static void p2_cpu_class_init(ObjectClass *oc, const void *data)
{
    DeviceClass *dc = DEVICE_CLASS(oc);
    CPUClass *cc = CPU_CLASS(oc);
    P2CPUClass *pcc = P2_CPU_CLASS(oc);
    ResettableClass *rc = RESETTABLE_CLASS(oc);

    device_class_set_parent_realize(dc, p2_cpu_realizefn, &pcc->parent_realize);
    device_class_set_props(dc, p2_cpu_properties);
    resettable_class_set_parent_phases(rc, NULL, p2_cpu_reset_hold, NULL,
                                       &pcc->parent_phases);
    cc->dump_state = p2_cpu_dump_state;
    cc->set_pc = p2_cpu_set_pc;
    cc->get_pc = p2_cpu_get_pc;
    cc->sysemu_ops = &p2_sysemu_ops;
    cc->tcg_ops = &p2_tcg_ops;
}

static const TypeInfo p2_cpu_type_info[] = {
    {
        .name = TYPE_P2_CPU,
        .parent = TYPE_CPU,
        .instance_size = sizeof(P2CPU),
        .class_size = sizeof(P2CPUClass),
        .class_init = p2_cpu_class_init,
    },
};

DEFINE_TYPES(p2_cpu_type_info)
