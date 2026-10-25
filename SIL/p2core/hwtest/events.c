/*
 * Silicon + ISS: events and interrupts.
 *
 * What a cog's 16 event flags and three interrupts actually do, measured on a
 * P2-EVAL so p2core can match it (silicon is the spec). Each probe is a block
 * of PASM run from FCACHE (cog RAM) with recording ISRs in LUT; each PASS line
 * packs the observations of one question into a hex word, decoded in the
 * comment above the probe.
 *
 * Pins: only P56/P57, the P2-EVAL's on-board LEDs, are driven. The bench has
 * the force-gauge add-on on P0/P2 and the FT232R on P53/P55, so nothing else
 * may be touched.
 *
 * Registers $1E0-$1EF (left free by FlexC) carry ISR state:
 *   $1E0 INT1 entries   $1E1 progress counter at INT1 entry   $1E2 IRET1 at entry
 *   $1E3 INT2 entries   $1E4 CT at INT1 entry                 $1E5 INT3 entries
 *   $1E6 scratch        $1E8 main-code progress counter       $1E9 order log
 *   $1EA-$1EC SETQ burst destination                          $1ED scratch
 * The order log shifts in one nibble per ISR step: 1/2/3 = INT1/2/3 entered,
 * A/B = the nesting ISRs' exit marks.
 */
#define P2_TARGET_MHZ 160

#include <propeller.h>
#include <propeller2.h>
#include <sys/p2es_clock.h>
#include <stdint.h>
#include <stdio.h>

#define LED 56
#define LED_INB_BIT (1U << (LED - 32))

/* LUT ISR addresses: one 16-long slot each. */
#define ISR1_REC 0x200
#define ISR2_REC 0x210
#define ISR3_REC 0x220
#define ISR3_NEST 0x230
#define ISR1_TRG3 0x240
#define ISR1_LEVEL 0x250
#define ISR1_CT 0x260
#define ISR1_SELF 0x270
#define ISR1_RESI 0x280
#define ISR_LONGS 0x90

/* SETSE configurations. */
#define SE_RISE(p) ((1U << 6) | (p))
#define SE_FALL(p) ((2U << 6) | (p))
#define SE_CHANGE(p) ((3U << 6) | (p))
#define SE_LOW(p) ((4U << 6) | (p))
#define SE_HIGH(p) ((6U << 6) | (p))
#define SE_LOCK_RISE(l) (0x10U | (l))
#define SE_LOCK_FALL(l) (0x20U | (l))
#define SE_LUT_READ(a) (0x00U | (a))  /* this cog reads LUT $1FC+a */
#define SE_LUT_WRITE(a) (0x04U | (a)) /* this cog writes LUT $1FC+a */

/* Timeout for every WAITxxx, so a wrong guess cannot hang the capture. */
#define WAIT_TIMEOUT 100000U

__asm {
        org     0x200
isr_lut
        // ISR1_REC: count, snapshot progress / IRET1 / CT, log 1, clobber C=0 Z=1
        add     0x1e0, #1
        mov     0x1e1, 0x1e8
        mov     0x1e2, 0x1f5
        getct   0x1e4
        shl     0x1e9, #4
        or      0x1e9, #1
        cmp     0x1e6, 0x1e6    wcz
        reti1
        orgf    0x210
        // ISR2_REC
        add     0x1e3, #1
        shl     0x1e9, #4
        or      0x1e9, #2
        reti2
        orgf    0x220
        // ISR3_REC
        add     0x1e5, #1
        shl     0x1e9, #4
        or      0x1e9, #3
        reti3
        orgf    0x230
        // ISR3_NEST: INT3 raising INT1 mid-ISR
        add     0x1e5, #1
        shl     0x1e9, #4
        or      0x1e9, #3
        trgint1
        nop
        nop
        nop
        nop
        shl     0x1e9, #4
        or      0x1e9, #0xA
        reti3
        orgf    0x240
        // ISR1_TRG3: INT1 raising INT3 mid-ISR
        add     0x1e0, #1
        shl     0x1e9, #4
        or      0x1e9, #1
        trgint3
        nop
        nop
        nop
        nop
        shl     0x1e9, #4
        or      0x1e9, #0xB
        reti1
        orgf    0x250
        // ISR1_LEVEL: count; on the fifth entry drop the LED (ends a level event)
        add     0x1e0, #1
        cmp     0x1e0, #5       wz
 if_z   drvl    #LED
        reti1
        orgf    0x260
        // ISR1_CT: count; on the third entry turn INT1 off
        add     0x1e0, #1
        cmp     0x1e0, #3       wz
 if_z   setint1 #0
        reti1
        orgf    0x270
        // ISR1_SELF: on the first entry trigger INT1 again from inside INT1
        add     0x1e0, #1
        cmp     0x1e0, #1       wz
 if_z   trgint1
        reti1
        orgf    0x280
        // ISR1_RESI: first entry logs 1 and suspends; later entries resume at 2
        shl     0x1e9, #4
        or      0x1e9, #1
        resi1
        shl     0x1e9, #4
        or      0x1e9, #2
        reti1
        fit     0x290
        orgh
}

/* Hub scratch for the FIFO and SETQ-burst probes (the FIFO probe reads 17 longs). */
static uint32_t lut_buf[32];

static void report(const char *name, uint32_t v)
{
    printf("PASS %s %08x\n", name, (unsigned)v);
}

static void isr_install(void)
{
    const uint32_t *code = (const uint32_t *)&isr_lut;
    for (uint32_t i = 0U; i < ISR_LONGS; i++)
    {
        uint32_t insn = code[i];
        __asm volatile {
            wrlut   insn, i
        }
    }
}

/* Interrupts off and un-pended, every event flag and ISR register cleared. A
 * dormant interrupt source for the TRGINT probes: SE4 = "this cog reads LUT
 * $1FF", which nothing here does. */
static void int_reset(void)
{
    __asm volatile {
        setint1 #0
        setint2 #0
        setint3 #0
        nixint1
        nixint2
        nixint3
        allowi
        setse1  #3
        setse2  #3
        setse3  #3
        setse4  #3
        pollint
        pollct1
        pollct2
        pollct3
        pollse1
        pollse2
        pollse3
        pollse4
        pollpat
        pollfbw
        pollatn
        pollqmt
        mov     0x1e0, #0
        mov     0x1e1, #0
        mov     0x1e2, #0
        mov     0x1e3, #0
        mov     0x1e4, #0
        mov     0x1e5, #0
        mov     0x1e8, #0
        mov     0x1e9, #0
        mov     0x1ea, #0
        mov     0x1eb, #0
        mov     0x1ec, #0
    }
}

/* ---- CT events ----------------------------------------------------------- */

/* bit0: POLLCT1 after CT passed the target; bit1: a second POLLCT1 (does the
 * sensor set the flag again while CT stays past the target?). */
static uint32_t ct_flag_sticky(void)
{
    uint32_t t, a, b;
    __asm volatile {
        getct   t
        addct1  t, #40
        waitx   #100
        pollct1 wc
        wrc     a
        pollct1 wc
        wrc     b
    }
    return a | (b << 1);
}

/* POLLCT1 after a passed target was replaced by a far-future ADDCT1. */
static uint32_t ct_addct_clears(void)
{
    uint32_t t, a;
    __asm volatile {
        getct   t
        addct1  t, #20
        waitx   #60
        getct   t
        addct1  t, ##1000000
        pollct1 wc
        wrc     a
    }
    return a;
}

/* CT1/CT2/CT3 are separate targets: 1 and 3 passed, 2 far ahead. bit n-1 = CTn. */
static uint32_t ct_independent(void)
{
    uint32_t t, t2, t3, a, b, c;
    __asm volatile {
        getct   t
        mov     t2, t
        mov     t3, t
        addct1  t, #20
        addct2  t2, ##1000000
        addct3  t3, #20
        waitx   #100
        pollct1 wc
        wrc     a
        pollct2 wc
        wrc     b
        pollct3 wc
        wrc     c
    }
    return a | (b << 1) | (c << 2);
}

/* bit0: JCT1 jumped on a passed target; bit1: POLLCT1 afterwards;
 * bit2: JNCT1 jumped on a future target. */
static uint32_t ct_jct(void)
{
    uint32_t t, taken = 0U, b, ntaken = 0U;
    __asm volatile {
        getct   t
        addct1  t, #20
        waitx   #60
        jct1    #.jt
        jmp     #.jd
.jt
        mov     taken, #1
.jd
        pollct1 wc
        wrc     b
        getct   t
        addct1  t, ##1000000
        jnct1   #.nt
        jmp     #.nd
.nt
        mov     ntaken, #1
.nd
    }
    return taken | (b << 1) | (ntaken << 2);
}

/* Clocks from GETCT through ADDCT1 +1000 / WAITCT1 to the next GETCT. */
static uint32_t ct_waitct_delta(void)
{
    uint32_t a, t, b;
    __asm volatile {
        getct   a
        mov     t, a
        addct1  t, ##1000
        waitct1
        getct   b
    }
    return b - a;
}

/* WAITCT1 WC with a SETQ deadline 300 clocks out and a target far beyond it:
 * low 16 bits = clocks waited, bit 16 = C (timed out). */
static uint32_t ct_waitct_timeout(void)
{
    uint32_t a, t, q, c, b;
    __asm volatile {
        getct   a
        mov     t, a
        addct1  t, ##1000000
        mov     q, a
        add     q, #300
        setq    q
        waitct1 wc
        wrc     c
        getct   b
    }
    return ((b - a) & 0xFFFFU) | (c << 16);
}

/* ---- selectable events on the LED pin ------------------------------------ */

static void led_out(void)
{
    __asm volatile {
        drvl    #LED
        waitx   #40
    }
}

static void led_release(void)
{
    __asm volatile {
        fltl    #LED
    }
}

/* Rising edge. bit0 POLLSE1 before the edge, bit1 after, bit2 again. */
static uint32_t se_rise(void)
{
    uint32_t cfg = SE_RISE(LED), a, b, c;
    __asm volatile {
        drvl    #LED
        waitx   #40
        setse1  cfg
        pollse1 wc
        wrc     a
        drvh    #LED
        waitx   #40
        pollse1 wc
        wrc     b
        pollse1 wc
        wrc     c
    }
    return a | (b << 1) | (c << 2);
}

/* Falling edge, same layout. */
static uint32_t se_fall(void)
{
    uint32_t cfg = SE_FALL(LED), a, b, c;
    __asm volatile {
        drvh    #LED
        waitx   #40
        setse1  cfg
        pollse1 wc
        wrc     a
        drvl    #LED
        waitx   #40
        pollse1 wc
        wrc     b
        pollse1 wc
        wrc     c
    }
    return a | (b << 1) | (c << 2);
}

/* Any change: low->high->low before polling. bit0 first POLLSE1, bit1 second. */
static uint32_t se_change(void)
{
    uint32_t cfg = SE_CHANGE(LED), a, b;
    __asm volatile {
        drvl    #LED
        waitx   #40
        setse1  cfg
        drvh    #LED
        waitx   #40
        drvl    #LED
        waitx   #40
        pollse1 wc
        wrc     a
        pollse1 wc
        wrc     b
    }
    return a | (b << 1);
}

/* Level high: bits 0,1 = two POLLSE1 with the pin high; bits 2,3 = two after
 * it went low. */
static uint32_t se_high(void)
{
    uint32_t cfg = SE_HIGH(LED), a, b, c, d;
    __asm volatile {
        drvh    #LED
        waitx   #40
        setse1  cfg
        pollse1 wc
        wrc     a
        pollse1 wc
        wrc     b
        drvl    #LED
        waitx   #40
        pollse1 wc
        wrc     c
        pollse1 wc
        wrc     d
    }
    return a | (b << 1) | (c << 2) | (d << 3);
}

/* Level low: bit0 POLLSE1 while low; bits 1,2 = two after it went high. */
static uint32_t se_low(void)
{
    uint32_t cfg = SE_LOW(LED), a, b, c;
    __asm volatile {
        drvl    #LED
        waitx   #40
        setse1  cfg
        pollse1 wc
        wrc     a
        drvh    #LED
        waitx   #40
        pollse1 wc
        wrc     b
        pollse1 wc
        wrc     c
    }
    return a | (b << 1) | (c << 2);
}

/* SETSE1 again after a rising edge, then POLLSE1. */
static uint32_t se_setse_clears(void)
{
    uint32_t cfg = SE_RISE(LED), a;
    __asm volatile {
        drvl    #LED
        waitx   #40
        setse1  cfg
        drvh    #LED
        waitx   #40
        setse1  cfg
        pollse1 wc
        wrc     a
    }
    return a;
}

/* SE1 rise, SE2 fall, SE3 change, SE4 high, one low->high edge. bit n-1 = SEn. */
static uint32_t se_all4(void)
{
    uint32_t r = SE_RISE(LED), f = SE_FALL(LED), ch = SE_CHANGE(LED), h = SE_HIGH(LED);
    uint32_t a, b, c, d;
    __asm volatile {
        drvl    #LED
        waitx   #40
        setse1  r
        setse2  f
        setse3  ch
        setse4  h
        drvh    #LED
        waitx   #40
        pollse1 wc
        wrc     a
        pollse2 wc
        wrc     b
        pollse3 wc
        wrc     c
        pollse4 wc
        wrc     d
    }
    return a | (b << 1) | (c << 2) | (d << 3);
}

/* bit0 JSE1 jumped after an edge, bit1 POLLSE1 afterwards, bit2 JNSE1 jumped
 * with no edge. */
static uint32_t se_jse(void)
{
    uint32_t cfg = SE_RISE(LED), taken = 0U, b, ntaken = 0U;
    __asm volatile {
        drvl    #LED
        waitx   #40
        setse1  cfg
        drvh    #LED
        waitx   #40
        jse1    #.jt
        jmp     #.jd
.jt
        mov     taken, #1
.jd
        pollse1 wc
        wrc     b
        jnse1   #.nt
        jmp     #.nd
.nt
        mov     ntaken, #1
.nd
    }
    return taken | (b << 1) | (ntaken << 2);
}

/* WAITSE1 WC with no edge coming and a 300-clock SETQ deadline: low 16 bits =
 * clocks waited, bit 16 = C. */
static uint32_t se_waitse_timeout(void)
{
    uint32_t cfg = SE_RISE(LED), a, q, c, b;
    __asm volatile {
        drvl    #LED
        waitx   #40
        setse1  cfg
        getct   a
        mov     q, a
        add     q, #300
        setq    q
        waitse1 wc
        wrc     c
        getct   b
    }
    return ((b - a) & 0xFFFFU) | (c << 16);
}

/* WAITSE1 WC when the edge already happened: same layout. */
static uint32_t se_waitse_ready(void)
{
    uint32_t cfg = SE_RISE(LED), a, q, c, b;
    __asm volatile {
        drvl    #LED
        waitx   #40
        setse1  cfg
        drvh    #LED
        waitx   #40
        getct   a
        mov     q, a
        add     q, ##WAIT_TIMEOUT
        setq    q
        waitse1 wc
        wrc     c
        getct   b
    }
    return ((b - a) & 0xFFFFU) | (c << 16);
}

/* Hub-lock modes. bit0: lock-rise flag after LOCKTRY took the lock; bit1:
 * lock-rise flag after LOCKREL (polled clear first); bit2: lock-fall flag after
 * take + release; bit3: LOCKTRY's own C (got it). */
static uint32_t se_lock(int lock)
{
    uint32_t id = (uint32_t)lock, rise = SE_LOCK_RISE((uint32_t)lock), fall = SE_LOCK_FALL((uint32_t)lock);
    uint32_t a, b, c, got;
    __asm volatile {
        setse1  rise
        locktry id      wc
        wrc     got
        pollse1 wc
        wrc     a
        lockrel id
        pollse1 wc
        wrc     b
        setse1  fall
        locktry id
        lockrel id
        pollse1 wc
        wrc     c
    }
    return a | (b << 1) | (c << 2) | (got << 3);
}

/* LUT modes. bit0 read-$1FC flag before any read, bit1 after RDLUT $1FC,
 * bit2 write-$1FD flag after WRLUT $1FD, bit3 read-$1FC flag after reading
 * $1FD (a different address). */
static uint32_t se_lut(void)
{
    uint32_t rd = SE_LUT_READ(0U), wr = SE_LUT_WRITE(1U), x = 0U, a, b, c, d;
    __asm volatile {
        setse1  rd
        pollse1 wc
        wrc     a
        rdlut   x, #0x1fc
        pollse1 wc
        wrc     b
        setse2  wr
        wrlut   x, #0x1fd
        pollse2 wc
        wrc     c
        setse1  rd
        rdlut   x, #0x1fd
        pollse1 wc
        wrc     d
    }
    return a | (b << 1) | (c << 2) | (d << 3);
}

/* ---- other events -------------------------------------------------------- */

/* PAT on INB, equal: mask = match = the LED bit. bit0 POLLPAT while the LED is
 * low, bit1 after it went high, bit2 a second POLLPAT. */
static uint32_t pat_inb_equal(void)
{
    uint32_t mask = LED_INB_BIT, one = 1U, zero = 0U, a, b, c;
    __asm volatile {
        drvl    #LED
        waitx   #40
        testb   one, #0         wc
        cmp     zero, zero      wz
        setpat  mask, mask
        pollpat wc
        wrc     a
        drvh    #LED
        waitx   #40
        pollpat wc
        wrc     b
        pollpat wc
        wrc     c
    }
    return a | (b << 1) | (c << 2);
}

/* COGATN to this cog. bit0 POLLATN, bit1 a second POLLATN. */
static uint32_t atn_self(void)
{
    uint32_t me, a, b;
    __asm volatile {
        cogid   me
        decod   me
        cogatn  me
        waitx   #20
        pollatn wc
        wrc     a
        pollatn wc
        wrc     b
    }
    return a | (b << 1);
}

/* GETQX with nothing queued. bit0 POLLQMT, bit1 again, bit2 POLLQMT after a
 * GETQX that had a result. */
static uint32_t qmt(void)
{
    uint32_t x, two = 2U, three = 3U, a, b, c;
    __asm volatile {
        getqx   x
        pollqmt wc
        wrc     a
        pollqmt wc
        wrc     b
        qmul    two, three
        getqx   x
        pollqmt wc
        wrc     c
    }
    return a | (b << 1) | (c << 2);
}

/* RDFAST with a one-block (64-byte) count. bit0 POLLFBW right after RDFAST,
 * bit1 after 4 longs read, bit2 after 17 longs read. */
static uint32_t fbw(void)
{
    uint32_t addr = (uint32_t)&lut_buf[0], x, a, b, c;
    __asm volatile {
        rdfast  #1, addr
        pollfbw wc
        wrc     a
        rflong  x
        rflong  x
        rflong  x
        rflong  x
        pollfbw wc
        wrc     b
        rflong  x
        rflong  x
        rflong  x
        rflong  x
        rflong  x
        rflong  x
        rflong  x
        rflong  x
        rflong  x
        rflong  x
        rflong  x
        rflong  x
        rflong  x
        pollfbw wc
        wrc     c
    }
    return a | (b << 1) | (c << 2);
}

/* ---- interrupts ---------------------------------------------------------- */

static void arm_dormant_int1(void)
{
    __asm volatile {
        mov     ijmp1, ##ISR1_REC
        setint1 #7
    }
}

/* TRGINT1 with INT1's source off: bits 0-7 entries, bits 8-15 progress count
 * at the branch. */
static uint32_t int_trg_source_off(void)
{
    uint32_t e, p;
    __asm volatile {
        mov     ijmp1, ##ISR1_REC
        setint1 #0
        mov     0x1e8, #0
        trgint1
        add     0x1e8, #1
        add     0x1e8, #1
        add     0x1e8, #1
        add     0x1e8, #1
        add     0x1e8, #1
        add     0x1e8, #1
        mov     e, 0x1e0
        mov     p, 0x1e1
    }
    return (e & 0xFFU) | ((p & 0xFFU) << 8);
}

/* TRGINT1 with a dormant source: how many instructions after TRGINT1 the branch
 * lands. bits 0-7 entries, 8-15 progress at the branch. */
static uint32_t int_trg_latency(void)
{
    uint32_t e, p;
    arm_dormant_int1();
    __asm volatile {
        mov     0x1e8, #0
        trgint1
        add     0x1e8, #1
        add     0x1e8, #1
        add     0x1e8, #1
        add     0x1e8, #1
        add     0x1e8, #1
        add     0x1e8, #1
        mov     e, 0x1e0
        mov     p, 0x1e1
    }
    return (e & 0xFFU) | ((p & 0xFFU) << 8);
}

/* Main sets C=1 Z=0, the ISR leaves C=0 Z=1. bit0 C after, bit1 Z after,
 * bits 2-3 IRET1[31:30] as saved, bits 8-15 entries. */
static uint32_t int_flags(void)
{
    uint32_t zero = 0U, one = 1U, c, z, iret, e;
    arm_dormant_int1();
    __asm volatile {
        cmp     zero, one       wcz
        trgint1
        nop
        nop
        nop
        nop
        wrc     c
        wrz     z
        mov     iret, 0x1e2
        mov     e, 0x1e0
    }
    return c | (z << 1) | ((iret >> 30) << 2) | ((e & 0xFFU) << 8);
}

/* An AUGS-prefixed MOV placed N instructions after TRGINT1 (N = 0, 1, 2).
 * bits 0-7 entries (an ISR that ate the prefix counts wrong), bits 8-15
 * progress at the branch, bit 16 the augmented value arrived whole. */
static uint32_t int_augs(int n)
{
    uint32_t e, p, v, ok;
    arm_dormant_int1();
    if (n == 0)
    {
        __asm volatile {
            mov     0x1e8, #0
            trgint1
            mov     0x1ea, ##0x12345678
            add     0x1e8, #1
            add     0x1e8, #1
            add     0x1e8, #1
            add     0x1e8, #1
        }
    }
    else if (n == 1)
    {
        __asm volatile {
            mov     0x1e8, #0
            trgint1
            add     0x1e8, #1
            mov     0x1ea, ##0x12345678
            add     0x1e8, #1
            add     0x1e8, #1
            add     0x1e8, #1
        }
    }
    else
    {
        __asm volatile {
            mov     0x1e8, #0
            trgint1
            add     0x1e8, #1
            add     0x1e8, #1
            mov     0x1ea, ##0x12345678
            add     0x1e8, #1
            add     0x1e8, #1
        }
    }
    __asm volatile {
        mov     e, 0x1e0
        mov     p, 0x1e1
        mov     v, 0x1ea
    }
    ok = (v == 0x12345678U) ? 1U : 0U;
    return (e & 0xFFU) | ((p & 0xFFU) << 8) | (ok << 16);
}

/* SETQ + 3-long RDLONG burst right after TRGINT1. bits 0-7 entries, 8-15
 * progress at the branch, bit 16 the third long arrived. */
static uint32_t int_setq(void)
{
    uint32_t e, p, v;
    uint32_t addr = (uint32_t)&lut_buf[0];
    lut_buf[2] = 0xCAFEF00DU;
    arm_dormant_int1();
    __asm volatile {
        mov     0x1e8, #0
        trgint1
        setq    #2
        rdlong  0x1ea, addr
        add     0x1e8, #1
        add     0x1e8, #1
        add     0x1e8, #1
        mov     e, 0x1e0
        mov     p, 0x1e1
        mov     v, 0x1ec
    }
    return (e & 0xFFU) | ((p & 0xFFU) << 8) | ((v == 0xCAFEF00DU ? 1U : 0U) << 16);
}

/* GETCT WC + GETCT right after TRGINT1: progress at the branch. */
static uint32_t int_getct_wc(void)
{
    uint32_t e, p, hi, lo;
    arm_dormant_int1();
    __asm volatile {
        mov     0x1e8, #0
        trgint1
        getct   hi      wc
        getct   lo
        add     0x1e8, #1
        add     0x1e8, #1
        add     0x1e8, #1
        mov     e, 0x1e0
        mov     p, 0x1e1
    }
    (void)hi;
    (void)lo;
    return (e & 0xFFU) | ((p & 0xFFU) << 8);
}

/* TRGINT1 then an 8-iteration REP of one ADD: progress at the branch. */
static uint32_t int_rep(void)
{
    uint32_t e, p;
    arm_dormant_int1();
    __asm volatile {
        mov     0x1e8, #0
        trgint1
        rep     #1, #8
        add     0x1e8, #1
        add     0x1e8, #0x10
        add     0x1e8, #0x10
        mov     e, 0x1e0
        mov     p, 0x1e1
    }
    return (e & 0xFFU) | ((p & 0xFFU) << 8);
}

/* STALLI, TRGINT1, four ADDs, ALLOWI, four ADDs: progress at the branch. */
static uint32_t int_stalli(void)
{
    uint32_t e, p;
    arm_dormant_int1();
    __asm volatile {
        mov     0x1e8, #0
        stalli
        trgint1
        add     0x1e8, #1
        add     0x1e8, #1
        add     0x1e8, #1
        add     0x1e8, #1
        allowi
        add     0x1e8, #0x10
        add     0x1e8, #0x10
        add     0x1e8, #0x10
        add     0x1e8, #0x10
        mov     e, 0x1e0
        mov     p, 0x1e1
    }
    return (e & 0xFFU) | ((p & 0xFFU) << 8);
}

/* STALLI, TRGINT1, NIXINT1, ALLOWI: entries. */
static uint32_t int_nixint(void)
{
    uint32_t e;
    arm_dormant_int1();
    __asm volatile {
        stalli
        trgint1
        nixint1
        allowi
        nop
        nop
        nop
        nop
        mov     e, 0x1e0
    }
    return e;
}

/* TRGINT1 then WAITX 1000: bits 0-15 clocks from before TRGINT1 to the ISR's
 * GETCT, bits 16-23 progress at the branch, bits 24-31 entries. */
static uint32_t int_waitx(void)
{
    uint32_t a, e, p, t;
    arm_dormant_int1();
    __asm volatile {
        mov     0x1e8, #0
        getct   a
        trgint1
        waitx   ##1000
        add     0x1e8, #1
        add     0x1e8, #1
        add     0x1e8, #1
        mov     e, 0x1e0
        mov     p, 0x1e1
        mov     t, 0x1e4
    }
    return ((t - a) & 0xFFFFU) | ((p & 0xFFU) << 16) | ((e & 0xFFU) << 24);
}

/* All three triggered under STALLI, then ALLOWI: the order log. */
static uint32_t int_priority(void)
{
    uint32_t log;
    __asm volatile {
        mov     ijmp1, ##ISR1_REC
        mov     ijmp2, ##ISR2_REC
        mov     ijmp3, ##ISR3_REC
        setint1 #7
        setint2 #7
        setint3 #7
        stalli
        trgint3
        trgint2
        trgint1
        allowi
        nop
        nop
        nop
        nop
        nop
        nop
        mov     log, 0x1e9
    }
    return log;
}

/* INT3's ISR raises INT1: the order log (3, then 1 or A first). */
static uint32_t int_nest_3_1(void)
{
    uint32_t log;
    __asm volatile {
        mov     ijmp1, ##ISR1_REC
        mov     ijmp3, ##ISR3_NEST
        setint1 #7
        setint3 #7
        trgint3
        nop
        nop
        nop
        nop
        nop
        nop
        nop
        nop
        mov     log, 0x1e9
    }
    return log;
}

/* INT1's ISR raises INT3: the order log. */
static uint32_t int_nest_1_3(void)
{
    uint32_t log;
    __asm volatile {
        mov     ijmp1, ##ISR1_TRG3
        mov     ijmp3, ##ISR3_REC
        setint1 #7
        setint3 #7
        trgint1
        nop
        nop
        nop
        nop
        nop
        nop
        nop
        nop
        mov     log, 0x1e9
    }
    return log;
}

/* INT1's ISR re-triggers INT1 on its first entry: entries. */
static uint32_t int_self_retrigger(void)
{
    uint32_t e;
    __asm volatile {
        mov     ijmp1, ##ISR1_SELF
        setint1 #7
        trgint1
        nop
        nop
        nop
        nop
        nop
        nop
        mov     e, 0x1e0
    }
    return e;
}

/* INT1 on SE1 rising edge of the LED. bits 0-3 entries after one edge, bit 4
 * POLLSE1 after that ISR ran, bits 8-11 entries after a second edge. */
static uint32_t int_se_edge(void)
{
    uint32_t cfg = SE_RISE(LED), a, b, c;
    __asm volatile {
        drvl    #LED
        waitx   #40
        setse1  cfg
        mov     ijmp1, ##ISR1_REC
        setint1 #4
        drvh    #LED
        waitx   #40
        nop
        nop
        mov     a, 0x1e0
        pollse1 wc
        wrc     b
        drvl    #LED
        waitx   #40
        drvh    #LED
        waitx   #40
        nop
        nop
        mov     c, 0x1e0
    }
    return (a & 0xFU) | (b << 4) | ((c & 0xFU) << 8);
}

/* INT1 on SE1 "LED high"; the ISR drops the LED on its fifth entry: entries. */
static uint32_t int_se_level(void)
{
    uint32_t cfg = SE_HIGH(LED), e;
    __asm volatile {
        drvl    #LED
        waitx   #40
        setse1  cfg
        mov     ijmp1, ##ISR1_LEVEL
        setint1 #4
        drvh    #LED
        waitx   ##2000
        nop
        nop
        nop
        nop
        mov     e, 0x1e0
    }
    return e;
}

/* INT1 on CT1, target 100 clocks out and never moved; the ISR turns INT1 off on
 * its third entry: entries. */
static uint32_t int_ct_source(void)
{
    uint32_t t, e;
    __asm volatile {
        mov     ijmp1, ##ISR1_CT
        getct   t
        addct1  t, #100
        setint1 #1
        waitx   ##3000
        nop
        nop
        nop
        nop
        mov     e, 0x1e0
    }
    return e;
}

/* bit0 POLLINT after an interrupt, bit1 again. */
static uint32_t int_pollint(void)
{
    uint32_t a, b;
    arm_dormant_int1();
    __asm volatile {
        trgint1
        nop
        nop
        nop
        nop
        pollint wc
        wrc     a
        pollint wc
        wrc     b
    }
    return a | (b << 1);
}

/* WAITINT WC (SETQ deadline far out) with INT1 on CT1 500 clocks ahead.
 * bits 0-3 entries, bits 4-7 progress at the branch (main bumps it right after
 * WAITINT), bit 8 C (timed out), bits 16-31 clocks waited. */
static uint32_t int_waitint(void)
{
    uint32_t t, a, q, c, b, e, p;
    __asm volatile {
        mov     ijmp1, ##ISR1_REC
        mov     0x1e8, #0
        getct   a
        mov     t, a
        addct1  t, ##500
        setint1 #1
        mov     q, a
        add     q, ##WAIT_TIMEOUT
        setq    q
        waitint wc
        add     0x1e8, #1
        wrc     c
        getct   b
        setint1 #0
        mov     e, 0x1e0
        mov     p, 0x1e1
    }
    return (e & 0xFU) | ((p & 0xFU) << 4) | (c << 8) | (((b - a) & 0xFFFFU) << 16);
}

/* RESI1: three TRGINT1s into an ISR that suspends after logging 1: the log. */
static uint32_t int_resi(void)
{
    uint32_t log;
    __asm volatile {
        mov     ijmp1, ##ISR1_RESI
        setint1 #7
        trgint1
        nop
        nop
        nop
        nop
        trgint1
        nop
        nop
        nop
        nop
        trgint1
        nop
        nop
        nop
        nop
        mov     log, 0x1e9
    }
    return log;
}

/* INT1 on ATN (event 14), COGATN to this cog: entries. */
static uint32_t int_atn_source(void)
{
    uint32_t me, e;
    __asm volatile {
        mov     ijmp1, ##ISR1_REC
        setint1 #14
        cogid   me
        decod   me
        cogatn  me
        waitx   #40
        nop
        nop
        mov     e, 0x1e0
    }
    return e;
}

/* A macro, not a function pointer: FlexC has mis-dispatched indirect calls. */
#define RUN(name, expr)       \
    do                        \
    {                         \
        uint32_t v_;          \
        int_reset();          \
        v_ = (expr);          \
        int_reset();          \
        report((name), v_);   \
    } while (0)

void main(void)
{
    int lock;

    _clkset(_SETFREQ, _CLOCKFREQ);
    _setbaud(230400);
    printf("EVENTS\n");
    isr_install();
    int_reset();

    RUN("ct_flag_sticky", ct_flag_sticky());
    RUN("ct_addct_clears", ct_addct_clears());
    RUN("ct_independent", ct_independent());
    RUN("ct_jct", ct_jct());
    RUN("ct_waitct_delta", ct_waitct_delta());
    RUN("ct_waitct_timeout", ct_waitct_timeout());

    led_out();
    RUN("se_rise", se_rise());
    RUN("se_fall", se_fall());
    RUN("se_change", se_change());
    RUN("se_high", se_high());
    RUN("se_low", se_low());
    RUN("se_setse_clears", se_setse_clears());
    RUN("se_all4", se_all4());
    RUN("se_jse", se_jse());
    RUN("se_waitse_timeout", se_waitse_timeout());
    RUN("se_waitse_ready", se_waitse_ready());
    lock = _locknew();
    RUN("se_lock", se_lock(lock));
    _lockret(lock);
    RUN("se_lut", se_lut());

    RUN("pat_inb_equal", pat_inb_equal());
    RUN("atn_self", atn_self());
    RUN("qmt", qmt());
    RUN("fbw", fbw());

    RUN("int_trg_source_off", int_trg_source_off());
    RUN("int_trg_latency", int_trg_latency());
    RUN("int_flags", int_flags());
    RUN("int_augs_0", int_augs(0));
    RUN("int_augs_1", int_augs(1));
    RUN("int_augs_2", int_augs(2));
    RUN("int_setq", int_setq());
    RUN("int_getct_wc", int_getct_wc());
    RUN("int_rep", int_rep());
    RUN("int_stalli", int_stalli());
    RUN("int_nixint", int_nixint());
    RUN("int_waitx", int_waitx());
    RUN("int_priority", int_priority());
    RUN("int_nest_3_1", int_nest_3_1());
    RUN("int_nest_1_3", int_nest_1_3());
    RUN("int_self_retrigger", int_self_retrigger());
    RUN("int_se_edge", int_se_edge());
    RUN("int_se_level", int_se_level());
    RUN("int_ct_source", int_ct_source());
    RUN("int_pollint", int_pollint());
    RUN("int_waitint", int_waitint());
    RUN("int_resi", int_resi());
    RUN("int_atn_source", int_atn_source());

    led_release();
    printf("RESULT 0 PASS\n");
    _waitms(20);
    _cogstop(_cogid());
}
