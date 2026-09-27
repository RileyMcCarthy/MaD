/* Parallax Propeller 2 CPU parameters. SPDX-License-Identifier: LGPL-2.1-or-later */
#ifndef P2_CPU_PARAM_H
#define P2_CPU_PARAM_H

/*
 * The P2's unified 20-bit PC addresses cog RAM (<$200), LUT (<$400) and hub
 * (byte address, 512 KB). Only hub is real guest memory -- cog RAM and LUT live
 * in CPUArchState (see Spike 0b: a store into a page holding translated code
 * costs +194 ns even when it invalidates nothing, and the firmware does 0.62
 * cog-register writes per instruction).
 */
#define TARGET_PAGE_BITS 12
#define TARGET_PHYS_ADDR_SPACE_BITS 20
#define TARGET_VIRT_ADDR_SPACE_BITS 20

#define TARGET_INSN_START_EXTRA_WORDS 0

#endif
