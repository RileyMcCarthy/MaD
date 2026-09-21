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
#define P2_NUM_LOCKS 16
/* Longs a COGINIT load copies from hub into cog RAM ($000..$1F7). */
#define P2_COGINIT_LOAD_LONGS 0x1F8
/* Cog RAM's top 16 longs are the special registers. */
#define P2_REG_PA   0x1F6
#define P2_REG_PB   0x1F7
#define P2_REG_PTRA 0x1F8
#define P2_REG_PTRB 0x1F9
#define P2_REG_DIRA 0x1FA      /* DIRB is +1, OUTA/OUTB and INA/INB follow */
#define P2_REG_OUTA 0x1FC
#define P2_REG_INA  0x1FE
#define P2_REG_INB  0x1FF

/* The DIR/OUT/FLT/DRV family, which shares one helper. */
enum {
    P2_PINOP_DIRL, P2_PINOP_DIRH, P2_PINOP_FLTL, P2_PINOP_FLTH,
    P2_PINOP_DRVL, P2_PINOP_DRVH, P2_PINOP_OUTL, P2_PINOP_OUTH,
    P2_PINOP_DRVC, P2_PINOP_DRVNC, P2_PINOP_DRVZ, P2_PINOP_DRVNZ,
    P2_PINOP_DRVNOT,
};
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
/* Not prefixes, but the same trick: instruction-stream state in the TB key. */
#define P2_TB_REP    64
#define P2_TB_SKIP   128
#define P2_TB_MASK   (P2_PFX_MASK | P2_TB_REP | P2_TB_SKIP)

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

    /*
     * REP and SKIP are runtime state that changes what the instruction stream
     * MEANS, so "a REP is running" and "a SKIP pattern is live" are part of the
     * translation-block key -- see P2_TB_REP / P2_TB_SKIP. The values stay here
     * because they are computed from registers.
     */
    uint32_t rep_left;      /* iterations still to run; 0 = no REP active */
    uint32_t rep_first;     /* first and last PC of the repeated block */
    uint32_t rep_last;
    uint32_t skip_pattern;  /* LSB first: a 1 cancels the instruction */
    uint32_t skip_left;     /* instructions still covered by the pattern */

    uint32_t qx;            /* CORDIC results, read back by GETQX/GETQY */
    uint32_t qy;
    uint32_t ct1;           /* the CT1 deadline ADDCT1 arms and WAITCT1 waits on */

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
