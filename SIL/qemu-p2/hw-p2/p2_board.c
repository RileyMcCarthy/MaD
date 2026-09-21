/*
 * A bare Propeller 2: 512 KB of hub RAM and eight cogs.
 * SPDX-License-Identifier: LGPL-2.1-or-later
 */
#include "qemu/osdep.h"
#include "qemu/units.h"
#include "qapi/error.h"
#include "hw/boards.h"
#include "hw/qdev-properties.h"
#include "system/address-spaces.h"
#include "system/system.h"
#include "target/p2/cpu.h"

#define P2_HUB_SIZE (512 * KiB)

static void p2_machine_init(MachineState *machine)
{
    MemoryRegion *hub = g_new(MemoryRegion, 1);
    MemoryRegion *wrap = g_new(MemoryRegion, 1);
    int i;

    /*
     * Hub RAM is the only real guest memory. Cog RAM and LUT are CPU state
     * (Spike 0b), so they are deliberately absent from the address space.
     */
    memory_region_init_ram(hub, NULL, "p2.hub", P2_HUB_SIZE, &error_fatal);
    memory_region_add_subregion(get_system_memory(), 0, hub);

    /*
     * Hub addressing wraps: silicon (and p2core, which assembles each byte
     * through `addr & (HUB_BYTES - 1)`) lets a RDLONG at $7FFFD read its last
     * byte from $00000. The translator masks the address to 19 bits, so the
     * only case left is an access that straddles the top -- an alias of the
     * whole hub at $80000 makes that wrap exactly, at no cost in memory.
     */
    memory_region_init_alias(wrap, NULL, "p2.hub.wrap", hub, 0, P2_HUB_SIZE);
    memory_region_add_subregion(get_system_memory(), P2_HUB_SIZE, wrap);

    for (i = 0; i < P2_NUM_COGS; i++) {
        Object *cpu = object_new(TYPE_P2_CPU);
        object_property_set_uint(cpu, "cogid", i, &error_fatal);
        qdev_realize(DEVICE(cpu), NULL, &error_fatal);
    }
}

static void p2_machine_class_init(ObjectClass *oc, const void *data)
{
    MachineClass *mc = MACHINE_CLASS(oc);

    mc->desc = "Parallax Propeller 2";
    mc->init = p2_machine_init;
    mc->max_cpus = P2_NUM_COGS;
    mc->default_cpu_type = TYPE_P2_CPU;
    mc->no_floppy = 1;
    mc->no_cdrom = 1;
    mc->no_parallel = 1;
}

static const TypeInfo p2_machine_types[] = {
    {
        .name = MACHINE_TYPE_NAME("p2"),
        .parent = TYPE_MACHINE,
        .class_init = p2_machine_class_init,
    },
};

DEFINE_TYPES(p2_machine_types)
