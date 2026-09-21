/*
 * The bring-up pin bus: a line-for-line mirror of p2core's `SmartPins`
 * (SIL/p2core/src/model.rs), which is the model the differential harness runs
 * the reference against.
 *
 * SPDX-License-Identifier: LGPL-2.1-or-later
 *
 * It is deliberately NOT the full board model. p2core has two PinBus
 * implementations -- `SmartPins` (this one) and `Board`, which carries an SD
 * card, flash and serial peers -- and only the small one is worth mirroring in
 * C: the real peripherals belong on embsim's side of the seam, and duplicating
 * them here would create exactly the second source of truth the whole
 * single-source decoder effort exists to avoid.
 *
 * What it does buy is a differential test of the CPU's half: operand decoding,
 * flag polarity, which register a pin number comes from, and the DIR/OUT
 * write-ordering rule. Those are the target's responsibility; the peripheral
 * behaviour is not.
 */
#include "qemu/osdep.h"
#include "cpu.h"
#include "pinbus.h"

void p2_pinbus_set(const P2PinBusOps *ops, void *opaque)
{
    p2_pinbus_ops = ops;
    p2_pinbus_opaque = opaque;
}

#define P2_PINS 64

typedef struct P2BringupBus {
    uint32_t mode[P2_PINS];     /* last WRPIN mode word; non-zero = configured */
    uint32_t x[P2_PINS];        /* last WXPIN parameter */
    bool     in_flag[P2_PINS];  /* pending IN flag */
    uint32_t out[2];            /* pin levels 0..31 / 32..63, from DIRx/OUTx */
    uint32_t dir[2];
    /*
     * What RDPIN returns for a pin with no queued data. $FF reads as an idle
     * (pulled-high) line, which is what an absent SD card looks like on MISO --
     * so disk_initialize fails its retries and the firmware takes its
     * documented mount-failure path instead of hanging.
     */
    uint32_t idle_value;
} P2BringupBus;

static P2BringupBus p2_bringup = { .idle_value = 0xFF };

static uint32_t bringup_ina(void *o)  { return p2_bringup.out[0]; }
static uint32_t bringup_inb(void *o)  { return p2_bringup.out[1]; }

static void bringup_dir_out_changed(void *o, unsigned cog, unsigned reg,
                                    uint32_t value)
{
    /* $1FA/$1FB are DIRA/DIRB, $1FC/$1FD are OUTA/OUTB. This model is the
     * simple one and keeps no per-cog copy. */
    switch (reg) {
    case P2_REG_DIRA:     p2_bringup.dir[0] = value; break;
    case P2_REG_DIRA + 1: p2_bringup.dir[1] = value; break;
    case P2_REG_OUTA:     p2_bringup.out[0] = value; break;
    case P2_REG_OUTA + 1: p2_bringup.out[1] = value; break;
    default: break;
    }
}

static void bringup_wrpin(void *o, unsigned pin, uint32_t cfg)
{
    p2_bringup.mode[pin & 63] = cfg;
    p2_bringup.in_flag[pin & 63] = cfg != 0;
}

static void bringup_wxpin(void *o, unsigned pin, uint32_t x)
{
    p2_bringup.x[pin & 63] = x;
    p2_bringup.in_flag[pin & 63] = true;
}

static void bringup_wypin(void *o, unsigned pin, uint32_t y)
{
    /* The transmitted byte would be logged here; nothing reads it back, so
     * the trace cannot see it and the log is omitted. */
    p2_bringup.in_flag[pin & 63] = true;
}

/*
 * Always 0: the streamer / transition-clock path keys off a real mode word,
 * and this model never claims to own a pad. p2core's `SmartPins` does not
 * override pin_cfg either, which is what keeps WYPIN on its simple path.
 */
static uint32_t bringup_pin_cfg(void *o, unsigned pin) { return 0; }

static uint32_t bringup_rdpin(void *o, unsigned pin, bool *busy)
{
    p2_bringup.in_flag[pin & 63] = false;
    *busy = false;              /* C reports BUSY; nothing here ever is */
    return p2_bringup.idle_value;
}

static bool bringup_testp(void *o, unsigned pin)
{
    /* A configured pin always reads "operation complete". */
    return p2_bringup.in_flag[pin & 63] || p2_bringup.mode[pin & 63] != 0;
}

static void bringup_akpin(void *o, unsigned pin)
{
    p2_bringup.in_flag[pin & 63] = false;
}

static const P2PinBusOps p2_bringup_ops = {
    .ina = bringup_ina,
    .inb = bringup_inb,
    .dir_out_changed = bringup_dir_out_changed,
    .wrpin = bringup_wrpin,
    .wxpin = bringup_wxpin,
    .wypin = bringup_wypin,
    .pin_cfg = bringup_pin_cfg,
    .rdpin = bringup_rdpin,
    .testp = bringup_testp,
    .akpin = bringup_akpin,
};

/*
 * Installed statically rather than from an init hook: a pin op that ran before
 * the hook would dereference a null ops pointer, and there is no arrangement
 * of machine/CPU init order that makes that impossible for all callers. A
 * board that wants a different bus calls p2_pinbus_set() over the top.
 */
const P2PinBusOps *p2_pinbus_ops = &p2_bringup_ops;
void *p2_pinbus_opaque = &p2_bringup;

void p2_pinbus_bringup_init(void)
{
    memset(&p2_bringup, 0, sizeof(p2_bringup));
    p2_bringup.idle_value = 0xFF;
    p2_pinbus_set(&p2_bringup_ops, &p2_bringup);
}
