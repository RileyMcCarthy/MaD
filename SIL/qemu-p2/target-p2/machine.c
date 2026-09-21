/* Propeller 2 vmstate. SPDX-License-Identifier: LGPL-2.1-or-later */
#include "qemu/osdep.h"
#include "cpu.h"
#include "migration/cpu.h"

const VMStateDescription vmstate_p2_cpu = {
    .name = "cpu",
    .version_id = 1,
    .minimum_version_id = 1,
    .fields = (const VMStateField[]) {
        VMSTATE_UINT32_ARRAY(env.cog, ArchCPU, P2_COG_LONGS),
        VMSTATE_UINT32_ARRAY(env.lut, ArchCPU, P2_LUT_LONGS),
        VMSTATE_UINT32(env.pc, ArchCPU),
        VMSTATE_UINT32(env.c, ArchCPU),
        VMSTATE_UINT32(env.z, ArchCPU),
        VMSTATE_UINT64(env.clocks, ArchCPU),
        VMSTATE_UINT32(env.cogid, ArchCPU),
        VMSTATE_END_OF_LIST()
    }
};
