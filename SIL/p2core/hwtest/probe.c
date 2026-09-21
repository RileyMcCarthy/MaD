/*
 * One-instruction silicon probe (FlexC host cog).
 *
 * If the mailbox encoding is already patched (non-zero), run that one
 * instruction and print DUMP/END — ISS replay and the original oneshot
 * capture. If encoding is zero, print READY and accept GO lines on the
 * debug UART so the host can query many encodings without reloading.
 */
#define P2_TARGET_MHZ 160

#include <propeller.h>
#include <propeller2.h>
#include <sys/p2es_clock.h>
#include <stdint.h>
#include <stdio.h>

#include "probe_worker.h"

volatile uint32_t probe_mbox[16] = {
    0xAA55F00Du,
    0xC0DE0B01u,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
};

static void print_dump(void)
{
    printf(
        "DUMP %08x %08x %08x %u %u\n",
        (unsigned)probe_mbox[2],
        (unsigned)probe_mbox[12],
        (unsigned)probe_mbox[13],
        (unsigned)(probe_mbox[14] & 1u),
        (unsigned)((probe_mbox[14] >> 1) & 1u));
    printf(
        "HUB %08x %08x %08x %08x\n",
        (unsigned)probe_mbox[8],
        (unsigned)probe_mbox[9],
        (unsigned)probe_mbox[10],
        (unsigned)probe_mbox[11]);
}

static void run_once(void)
{
    probe_mbox[12] = 0;
    probe_mbox[13] = 0;
    probe_mbox[14] = 0;
    probe_mbox[15] = 0;
    _cogstop(1);
    _coginit(1, (void *)probe_worker, (void *)probe_mbox);
    {
        uint32_t t = _cnt();
        while (probe_mbox[15] == 0)
        {
            if ((_cnt() - t) > 16000000u)
            {
                break;
            }
        }
    }
    print_dump();
}

static int read_line(char *buf, int max)
{
    int n = 0;
    for (;;)
    {
        int c = getchar();
        if (c < 0)
        {
            continue;
        }
        if (c == '\n' || c == '\r')
        {
            if (n == 0)
            {
                continue;
            }
            buf[n] = 0;
            return n;
        }
        if (n < max - 1)
        {
            buf[n++] = (char)c;
        }
    }
}

void main(void)
{
    _clkset(_SETFREQ, _CLOCKFREQ);
    _setbaud(230400);

    if (probe_mbox[2] != 0)
    {
        printf("PROBE\n");
        run_once();
        printf("END\n");
        _waitms(20);
        _cogstop(_cogid());
        return;
    }

    printf("READY\n");
    for (;;)
    {
        char line[160];
        unsigned enc, pre, din, sin, h0, h1, h2, h3;
        unsigned flags;
        int n;

        n = read_line(line, (int)sizeof(line));
        (void)n;
        if (line[0] == 'Q')
        {
            printf("END\n");
            _waitms(20);
            _cogstop(_cogid());
            return;
        }
        if (sscanf(
                line,
                "GO %x %x %x %x %u %x %x %x %x",
                &enc,
                &pre,
                &din,
                &sin,
                &flags,
                &h0,
                &h1,
                &h2,
                &h3)
            != 9)
        {
            printf("ERR\n");
            continue;
        }
        probe_mbox[2] = enc;
        probe_mbox[3] = pre;
        probe_mbox[4] = din;
        probe_mbox[5] = sin;
        probe_mbox[6] = flags;
        probe_mbox[8] = h0;
        probe_mbox[9] = h1;
        probe_mbox[10] = h2;
        probe_mbox[11] = h3;
        run_once();
    }
}
