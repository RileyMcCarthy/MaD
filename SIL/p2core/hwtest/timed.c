/*
 * Silicon + ISS timed unit tests.
 *
 * GETCT / WAITX cannot go through the one-instruction trampoline: they are
 * about the cycle counter, not D/S. The same binary runs on a P2-EVAL and in
 * p2core; PASS lines are the measured GETCT deltas. Silicon is the spec.
 *
 * Expected shape (exact constants come from the chip):
 *   getct_pair  = overhead of two GETCTs with nothing between
 *   waitx_N     = that overhead plus N (or N+k) clocks
 */
#define P2_TARGET_MHZ 160

#include <propeller.h>
#include <propeller2.h>
#include <sys/p2es_clock.h>
#include <stdint.h>
#include <stdio.h>

static uint32_t getct_now(void)
{
    uint32_t t;
    __asm {
        getct t
    }
    return t;
}

static uint32_t measure_waitx(uint32_t n)
{
    uint32_t a;
    uint32_t b;
    a = getct_now();
    __asm {
        waitx n
    }
    b = getct_now();
    return b - a;
}

static uint32_t measure_getct_pair(void)
{
    uint32_t a;
    uint32_t b;
    __asm {
        getct a
        getct b
    }
    return b - a;
}

void main(void)
{
    static const uint32_t ns[7] = {0, 1, 2, 8, 100, 1000, 10000};
    unsigned i;

    _clkset(_SETFREQ, _CLOCKFREQ);
    _setbaud(230400);
    printf("TIMED\n");
    printf("PASS getct_pair %08x\n", (unsigned)measure_getct_pair());
    for (i = 0; i < 7; i++)
    {
        uint32_t n = ns[i];
        uint32_t d = measure_waitx(n);
        printf("PASS waitx_%u %08x\n", (unsigned)n, (unsigned)d);
    }
    printf("RESULT 0 PASS\n");
    _waitms(20);
    _cogstop(_cogid());
}
