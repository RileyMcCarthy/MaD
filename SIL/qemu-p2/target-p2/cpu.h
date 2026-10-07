/* Parallax Propeller 2 CPU state. SPDX-License-Identifier: LGPL-2.1-or-later */
#ifndef P2_CPU_H
#define P2_CPU_H

#include "cpu-qom.h"
#include "exec/cpu-common.h"
#include "exec/cpu-defs.h"
#include "exec/cpu-interrupt.h"
#include "system/memory.h"

#define P2_COG_LONGS 512
#define P2_LUT_LONGS 512
#define P2_NUM_COGS  8

/* Unified PC regions. */
#define P2_LUT_BASE  0x200
#define P2_HUB_BASE  0x400

/* Special cog registers. */
#define P2_REG_DIRA  0x1FA
#define P2_REG_OUTA  0x1FC
#define P2_REG_INA   0x1FE
#define P2_REG_INB   0x1FF

/* Silicon retires a simple instruction in two clocks. */
#define P2_CLOCKS_PER_INSN 2

/*
 * One QEMU vCPU is one cog (design D1). Cog RAM and LUT are CPU state, NOT
 * guest RAM -- they are the register file, written by nearly every
 * instruction, and routing that through softmmu is what Spike 0b measured at
 * 20x too slow.
 */
typedef struct CPUArchState {
    uint32_t cog[P2_COG_LONGS];
    uint32_t lut[P2_LUT_LONGS];

    uint32_t pc;            /* unified 20-bit PC */
    uint32_t c;             /* carry flag, 0 or 1 */
    uint32_t z;             /* zero flag, 0 or 1 */
    uint64_t clocks;        /* this cog's clock, what GETCT reads */

    uint32_t cogid;
    bool     running;
} CPUP2State;

typedef CPUP2State CPUArchState;

struct ArchCPU {
    CPUState parent_obj;
    CPUArchState env;
};

struct P2CPUClass {
    CPUClass parent_class;
    DeviceRealize parent_realize;
    ResettablePhases parent_phases;
};

#define CPU_RESOLVING_TYPE TYPE_P2_CPU

void p2_cpu_tcg_init(void);
void p2_cpu_translate_code(CPUState *cs, TranslationBlock *tb,
                           int *max_insns, vaddr pc, void *host_pc);
void p2_cpu_do_interrupt(CPUState *cpu);
bool p2_cpu_exec_interrupt(CPUState *cpu, int interrupt_request);
hwaddr p2_cpu_get_phys_page_debug(CPUState *cpu, vaddr addr);
int p2_cpu_gdb_read_register(CPUState *cpu, GByteArray *mem_buf, int n);
int p2_cpu_gdb_write_register(CPUState *cpu, uint8_t *mem_buf, int n);
bool p2_cpu_tlb_fill(CPUState *cs, vaddr address, int size,
                     MMUAccessType access_type, int mmu_idx,
                     bool probe, uintptr_t retaddr);


#endif
