/*
 * Silicon report: two cogs share a hub mailbox. Same binary on silicon and ISS.
 */
#define P2_TARGET_MHZ 160

#include <propeller.h>
#include <propeller2.h>
#include <sys/p2es_clock.h>
#include <stdint.h>
#include <stdio.h>

static int g_fail;
static volatile uint32_t box;
static uint32_t peer_stack[128];

static void check_u32(const char *name, uint32_t got, uint32_t want)
{
    if (got == want)
    {
        printf("PASS %s %08x\n", name, (unsigned)got);
    }
    else
    {
        printf("FAIL %s got=%08x want=%08x\n", name, (unsigned)got, (unsigned)want);
        g_fail++;
    }
}

static void peer(void *arg)
{
    (void)arg;
    while (box != 0xA5A5A5A5u)
    {
    }
    box = 0x5A5A5A5Au;
}

void main(void)
{
    uint32_t t;

    _clkset(_SETFREQ, _CLOCKFREQ);
    _setbaud(230400);
    printf("COGS\n");

    box = 0;
    _cogstart(peer, 0, peer_stack, sizeof(peer_stack));
    box = 0xA5A5A5A5u;
    t = _cnt();
    while (box != 0x5A5A5A5Au)
    {
        if ((_cnt() - t) > 16000000u)
        {
            break;
        }
    }
    check_u32("mailbox", box, 0x5A5A5A5Au);
    check_u32("cogid0", (uint32_t)_cogid(), 0);

    if (g_fail == 0)
    {
        printf("RESULT 0 PASS\n");
    }
    else
    {
        printf("RESULT %d FAIL\n", g_fail);
    }
    _waitms(20);
    _cogstop(_cogid());
}
