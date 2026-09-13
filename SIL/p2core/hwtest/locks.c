/*
 * Silicon report: lock pool. Values are whatever the chip produced;
 * p2core must print the same lines.
 */
#define P2_TARGET_MHZ 160

#include <propeller.h>
#include <propeller2.h>
#include <sys/p2es_clock.h>
#include <stdint.h>
#include <stdio.h>

void main(void)
{
    int ids[16];
    int i;
    int extra;
    int try1;
    int try2;
    int try_after;

    _clkset(_SETFREQ, _CLOCKFREQ);
    _setbaud(230400);
    printf("LOCKS\n");

    for (i = 0; i < 16; i++)
    {
        ids[i] = _locknew();
    }
    printf("PASS locknew0 %08x\n", (unsigned)ids[0]);
    printf("PASS locknew15 %08x\n", (unsigned)ids[15]);
    extra = _locknew();
    printf("PASS locknew_exhausted %08x\n", (unsigned)extra);

    try1 = _locktry(ids[0]);
    printf("PASS locktry_first %08x\n", (unsigned)try1);
    try2 = _locktry(ids[0]);
    printf("PASS locktry_again %08x\n", (unsigned)try2);

    _lockrel(ids[0]);
    _lockret(ids[0]);
    extra = _locknew();
    printf("PASS locknew_after_ret %08x\n", (unsigned)extra);
    try_after = _locktry(extra);
    printf("PASS locktry_after %08x\n", (unsigned)try_after);

    printf("RESULT 0 PASS\n");
    _waitms(20);
    _cogstop(_cogid());
}
