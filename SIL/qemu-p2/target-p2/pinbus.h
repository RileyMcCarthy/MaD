/*
 * The CPU's only outward surface.
 * SPDX-License-Identifier: LGPL-2.1-or-later
 *
 * This mirrors p2core's `PinBus` trait (SIL/p2core/src/pins.rs) deliberately:
 * the CPU forwards what the firmware executed and nothing electrical lives on
 * this side of the line. Smart-pin state machines, nets and UART peers belong
 * to the implementation behind these ops, which is how embsim will eventually
 * plug in without the target changing.
 *
 * Polarity, from p2core's trait documentation -- both of these hang the guest
 * if inverted:
 *   - rdpin()'s `busy` becomes C, and C means BUSY, not ready.
 *     `__system___txraw` spins on `rdpin #62 wc` / `if_b jmp`.
 *   - testp() reports the pin's IN flag, and drivers spin with `if_nc jmp`
 *     waiting for it, so it must read true once an operation has completed.
 *
 * The bus is MACHINE state, not CPU state: all eight cogs share one, exactly
 * as p2core has one `pins` field on `Machine`. It is therefore reached through
 * a process-wide pointer rather than through CPUP2State.
 */
#ifndef P2_PINBUS_H
#define P2_PINBUS_H

typedef struct P2PinBusOps {
    /* Pin input states 0..31 (INA) and 32..63 (INB). */
    uint32_t (*ina)(void *opaque);
    uint32_t (*inb)(void *opaque);
    /*
     * A cog wrote DIRA/DIRB/OUTA/OUTB. `cog` matters: these are PER-COG
     * registers and the pad sees the OR across all eight, so a bus that
     * mirrors them globally lets one cog's write erase another's.
     */
    void (*dir_out_changed)(void *opaque, unsigned cog, unsigned reg,
                            uint32_t value);
    void (*wrpin)(void *opaque, unsigned pin, uint32_t cfg);
    void (*wxpin)(void *opaque, unsigned pin, uint32_t x);
    void (*wypin)(void *opaque, unsigned pin, uint32_t y);
    /* Last WRPIN mode word, or 0 if never configured. */
    uint32_t (*pin_cfg)(void *opaque, unsigned pin);
    /* RDPIN/RQPIN. Returns the value; *busy becomes C. */
    uint32_t (*rdpin)(void *opaque, unsigned pin, bool *busy);
    /* TESTP -- sample the IN flag without consuming it. */
    bool (*testp)(void *opaque, unsigned pin);
    /* AKPIN -- acknowledge, clearing the IN flag. */
    void (*akpin)(void *opaque, unsigned pin);
} P2PinBusOps;

extern const P2PinBusOps *p2_pinbus_ops;
extern void *p2_pinbus_opaque;

void p2_pinbus_set(const P2PinBusOps *ops, void *opaque);
/* Install the bring-up model -- see pinbus.c. */
void p2_pinbus_bringup_init(void);

#endif
