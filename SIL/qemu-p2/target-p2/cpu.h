/* Parallax Propeller 2 CPU state. SPDX-License-Identifier: LGPL-2.1-or-later */
#ifndef P2_CPU_H
#define P2_CPU_H

#include "cpu-qom.h"
#include "exec/cpu-common.h"
#include "exec/cpu-defs.h"
#include "exec/cpu-interrupt.h"
#include "system/memory.h"

#define P2_COG_LONGS 512
#define P2_STACK_DEPTH 8
/* Cog RAM's top 16 longs are the special registers. */
#define P2_REG_PA   0x1F6
#define P2_REG_PB   0x1F7
#define P2_REG_PTRA 0x1F8
#define P2_REG_PTRB 0x1F9
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
#define P2_CLOCKS_HUB_ACCESS 9
#define P2_HUB_MASK 0x7FFFF

/*
 * Prefix instructions modify only the instruction that immediately follows.
 * Which prefixes are live is part of the translation-block key, so the
 * translator can fold them in statically and emit nothing at all on the
 * overwhelmingly common path where none is pending; the VALUES stay in env
 * because SETQ's operand is a register.
 */
#define P2_PFX_AUGS  1
#define P2_PFX_AUGD  2
#define P2_PFX_SETQ  4
#define P2_PFX_SETQ2 8
#define P2_PFX_ALTD  16
#define P2_PFX_ALTS  32
#define P2_PFX_MASK  0x3F

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

    /* The 8-level hardware call stack. A ring on silicon too: a 9th push
     * overwrites the oldest entry rather than faulting, and CALL/RET, PUSH/POP
     * and the _RET_ prefix all share it. */
    uint32_t stack[P2_STACK_DEPTH];
    uint32_t sp;

    uint32_t aug_s;         /* AUGS literal, already shifted to bits 31:9 */
    uint32_t aug_d;
    uint32_t setq;          /* SETQ / SETQ2 operand */
    uint32_t alt_d;         /* ALTD/ALTS substituted register index */
    uint32_t alt_s;
    uint32_t prefix;        /* P2_PFX_* -- which of the above are live */

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
