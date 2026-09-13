/*
 * p2core hardware oracle.
 *
 * The same FlexC binary runs on the ISS (`p2core`) and on a real P2. Each
 * check prints PASS/FAIL; a RESULT line closes the report. Differences in
 * that report are ISS bugs — the encoding is the compiler's, shared by both
 * sides, so a match against silicon is the strongest oracle this crate has.
 *
 * The cases are the ones that have already produced correct-looking ISS
 * behaviour while being wrong (see SIL/p2core/README.md, "Things that cost
 * hours"): shift C, ENCOD C, GETBYTE field of S, unaligned hub access,
 * tagged-pointer masking, SETQ block length, REP length-vs-count, QMUL/QDIV,
 * and a tight add loop that FlexC FCACHE's (ALTD writeback).
 */
#define P2_TARGET_MHZ 160

#include <propeller.h>
#include <propeller2.h>
#include <sys/p2es_clock.h>
#include <stdint.h>
#include <stdio.h>

static int g_fail;

static void check_u32(const char *name, uint32_t got, uint32_t want)
{
    /* Always print the value silicon produced. The golden file is that
     * number, not a tick-mark: a later ISS change that still "passes" a
     * loosened check still has to match the captured bits. */
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

static void check_shift_c(void)
{
    uint32_t x = 0x80000000u;
    uint32_t cflag = 0;
    __asm {
        shl x, #1 wc
        muxc cflag, #1
    }
    check_u32("shl_msb_result", x, 0);
    check_u32("shl_msb_c", cflag, 1);

    x = 1;
    cflag = 0;
    __asm {
        shl x, #1 wc
        muxc cflag, #1
    }
    check_u32("shl_one_result", x, 2);
    check_u32("shl_one_c", cflag, 0);
}

static void check_encod(void)
{
    uint32_t src, dest, cflag;

    src = 0;
    dest = 0xFFFFFFFFu;
    cflag = 0;
    __asm {
        encod dest, src wc
        muxc cflag, #1
    }
    check_u32("encod_zero_dest", dest, 0);
    check_u32("encod_zero_c", cflag, 0);

    src = 1;
    dest = 0xFFFFFFFFu;
    cflag = 0;
    __asm {
        encod dest, src wc
        muxc cflag, #1
    }
    check_u32("encod_one_dest", dest, 0);
    check_u32("encod_one_c", cflag, 1);

    src = 0x80000000u;
    dest = 0;
    cflag = 0;
    __asm {
        encod dest, src wc
        muxc cflag, #1
    }
    check_u32("encod_msb_dest", dest, 31);
    check_u32("encod_msb_c", cflag, 1);
}

static void check_getbyte(void)
{
    uint32_t src = 0x11223344u;
    uint32_t b0 = 0xFFFFFFFFu;
    uint32_t b1 = 0xFFFFFFFFu;
    uint32_t b2 = 0xFFFFFFFFu;
    uint32_t b3 = 0xFFFFFFFFu;
    __asm {
        getbyte b0, src, #0
        getbyte b1, src, #1
        getbyte b2, src, #2
        getbyte b3, src, #3
    }
    check_u32("getbyte0", b0, 0x44);
    check_u32("getbyte1", b1, 0x33);
    check_u32("getbyte2", b2, 0x22);
    check_u32("getbyte3", b3, 0x11);
}

static void check_unaligned_hub(void)
{
    volatile uint8_t buf[8];
    uint32_t i;
    for (i = 0; i < 8; i++)
    {
        buf[i] = 0;
    }
    /* Firmware does this in send_cmd: store a DWORD at buf+1. Silicon permits
     * unaligned hub access; masking to a long boundary redirects the write. */
    *(volatile uint32_t *)(buf + 1) = 0xAABBCCDDu;
    check_u32("unaligned_b0", buf[0], 0);
    check_u32("unaligned_b1", buf[1], 0xDD);
    check_u32("unaligned_b2", buf[2], 0xCC);
    check_u32("unaligned_b3", buf[3], 0xBB);
    check_u32("unaligned_b4", buf[4], 0xAA);
    check_u32("unaligned_b5", buf[5], 0);
}

static void check_tagged_pointer(void)
{
    volatile uint32_t cell = 0xA5A5A5A5u;
    uint32_t addr = ((uint32_t)(uintptr_t)&cell) | 0x02D00000u;
    uint32_t got = 0;
    __asm {
        rdlong got, addr
    }
    check_u32("tagged_rdlong", got, 0xA5A5A5A5u);
}

static void check_setq_fill(void)
{
    uint32_t dst[4] = {1u, 2u, 3u, 4u};
    uint32_t *p = dst;
    __asm {
        setq #2
        wrlong #0, p
    }
    check_u32("setq_fill0", dst[0], 0);
    check_u32("setq_fill1", dst[1], 0);
    check_u32("setq_fill2", dst[2], 0);
    check_u32("setq_fill3", dst[3], 4);
}

static void check_rep(void)
{
    uint32_t acc = 0;
    uint32_t one = 1;
    /* REP D,S: D is block length in instructions, S is the repeat count.
     * Swapping them runs one instruction once (or four instructions once)
     * instead of adding four times. */
    __asm {
        rep #1, #4
        add acc, one
    }
    check_u32("rep_add_four", acc, 4);
}

static void check_qmul_qdiv(void)
{
    uint32_t ua = 3;
    uint32_t ub = 5;
    uint32_t lo = 0;
    uint32_t hi = 0xFFFFFFFFu;
    __asm {
        qmul ua, ub
        getqx lo
        getqy hi
    }
    check_u32("qmul_lo", lo, 15);
    check_u32("qmul_hi", hi, 0);

    /* 64-bit 0x00000001_00000000 / 3 = 0x55555555 rem 1. */
    uint32_t dividend_lo = 0;
    uint32_t dividend_hi = 1;
    uint32_t divisor = 3;
    uint32_t quot = 0;
    uint32_t rem = 0;
    __asm {
        setq dividend_hi
        qdiv dividend_lo, divisor
        getqx quot
        getqy rem
    }
    check_u32("qdiv_quot", quot, 0x55555555u);
    check_u32("qdiv_rem", rem, 1);
}

static void check_fcache_sum(void)
{
    /* FlexC FCACHE's a tight counted loop at -O1. FCACHE's ret_instr_ is an
     * ALTD post-decrement; if ALTD writeback is missing the loop either
     * hangs, under-counts, or walks off the cached body. */
    uint32_t s = 0;
    uint32_t i;
    for (i = 0; i < 100; i++)
    {
        s += i;
    }
    check_u32("fcache_sum_0_99", s, 4950);
}

static void check_float(void)
{
    /* Soft-float uses the integer unit's C flag (shifts, ENCOD). A flag bug
     * that leaves integer tests green still corrupts every float. */
    volatile float a = 1.5f;
    volatile float b = 2.0f;
    float c = a * b;
    uint32_t bits;
    __asm {
        mov bits, c
    }
    check_u32("float_1_5_times_2", bits, 0x40400000u); /* 3.0f */
}

void main(void)
{
    _clkset(_SETFREQ, _CLOCKFREQ);
    _setbaud(230400);
    printf("P2CORE-HW\n");
    printf("CLKFREQ %u\n", (unsigned)_clockfreq());

    check_shift_c();
    check_encod();
    check_getbyte();
    check_unaligned_hub();
    check_tagged_pointer();
    check_setq_fill();
    check_rep();
    check_qmul_qdiv();
    check_fcache_sum();
    check_float();

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
