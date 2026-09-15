/*
 * Silicon + ISS smart-pin unit tests.
 *
 * The one-instruction probe cannot reach any of this: `probe_skip_reason`
 * excludes the whole `Pin` bucket, because a pin's answer is not in D/S/C/Z --
 * it is a level on a wire, some number of clocks later. So the pin surface had
 * ZERO silicon coverage, which is awkward, because it is where p2core has
 * historically been wrong: a step train driven as levels rather than edges, a
 * per-cog DIR that was global, a WYPIN word lost on a microsecond boundary,
 * and smart-pin configuration that was decoded by ignoring it.
 *
 * The four modes exercised here are exactly the four the shipped firmware
 * configures, with the same arithmetic:
 *
 *   P_ASYNC_TX   HAL_serial.c      bitMode = 7 + (clkfreq/baud << 16)
 *   P_ASYNC_RX   HAL_serial.c      same bitMode
 *   P_TRANSITION HAL_pulseOut.c    X = cyclesPerPulse>>1, Y = pulses*2
 *   P_NCO_FREQ   HAL_pulseOut.c    X = 1, Y = freq * 2^32 / clk
 *
 * Every number printed is a measurement, not an expectation: silicon is the
 * spec, and p2core must reproduce the same console from the same binary. Where
 * a value is predictable the comment says what it should be, so a capture that
 * is merely self-consistent nonsense is still obvious to a reader.
 *
 * Pins P0..P5 only -- P58..P61 are the flash and the microSD, P62/P63 are the
 * debug UART, and this program shares the board with loadp2's serial link.
 */
#define P2_TARGET_MHZ 160

#include <propeller.h>
#include <propeller2.h>
#include <sys/p2es_clock.h>
#include <stdint.h>
#include <stdio.h>

#define PIN_PLAIN 0
#define PIN_TX 2
#define PIN_RX 3
#define PIN_PULSE 4
#define PIN_NCO 5

/* Long enough that a working pin always finishes, short enough that a broken
 * one does not hang the capture. 160 MHz, so this is ~6 ms. */
#define TIMEOUT_CLOCKS 1000000U

static uint32_t getct_now(void)
{
    uint32_t t;
    __asm {
        getct t
    }
    return t;
}

/* Clocks from now until the smart pin raises IN, or ~0 if it never does. */
static uint32_t wait_in(int pin, uint32_t budget)
{
    const uint32_t t0 = getct_now();
    for (;;)
    {
        const uint32_t elapsed = getct_now() - t0;
        if (_pinr(pin))
        {
            return elapsed;
        }
        if (elapsed > budget)
        {
            return 0xFFFFFFFFU;
        }
    }
}

/* --- 1. A cog drives a pin and reads its own level back. ---------------- */
static void test_drive_readback(void)
{
    uint32_t high;
    uint32_t low;

    _pinclear(PIN_PLAIN);
    _dirh(PIN_PLAIN);

    _drvh(PIN_PLAIN);
    high = _pinr(PIN_PLAIN); /* expect 1 */
    _drvl(PIN_PLAIN);
    low = _pinr(PIN_PLAIN); /* expect 0 */

    /* OUT with the driver still enabled: same path, different instruction. */
    _pinh(PIN_PLAIN);
    high |= _pinr(PIN_PLAIN) << 1;
    _pinl(PIN_PLAIN);

    _dirl(PIN_PLAIN);

    printf("PASS drive_high %08x\n", (unsigned)high);
    printf("PASS drive_low %08x\n", (unsigned)low);
}

/* --- 2. P_TRANSITION: the step-pulse generator. ------------------------- */
/*
 * X is half a pulse period; Y is a transition count. The firmware asks for
 * `pulses * 2` transitions of `cyclesPerPulse >> 1` each, so the train should
 * take pulses * cyclesPerPulse clocks and then raise IN.
 */
static void test_transition(uint32_t cycles_per_pulse, uint32_t pulses)
{
    uint32_t took;

    _pinclear(PIN_PULSE);
    _pinstart(PIN_PULSE, P_TRANSITION | P_OE, cycles_per_pulse >> 1, 0);
    _wypin(PIN_PULSE, pulses * 2U);
    took = wait_in(PIN_PULSE, TIMEOUT_CLOCKS);
    _pinclear(PIN_PULSE);

    /* expect ~ pulses * cycles_per_pulse */
    printf("PASS transition_%u_%u %08x\n", (unsigned)cycles_per_pulse, (unsigned)pulses,
           (unsigned)took);
}

/* --- 3. P_ASYNC_TX: the protocol's transmit path. ----------------------- */
/*
 * bitMode = 7 + (bitPeriod << 16) is 8 data bits at bitPeriod clocks each.
 * A character is start + 8 data + stop, so IN should come back about
 * 10 * bitPeriod clocks after the WYPIN that queued it.
 */
static void test_async_tx(uint32_t bit_period, uint32_t byte)
{
    const uint32_t bit_mode = 7U + (bit_period << 16);
    uint32_t took;

    _pinclear(PIN_TX);
    _pinstart(PIN_TX, P_OE | P_ASYNC_TX, bit_mode, 0);
    _wypin(PIN_TX, byte);
    took = wait_in(PIN_TX, TIMEOUT_CLOCKS);
    _pinclear(PIN_TX);

    /* expect ~ 10 * bit_period */
    printf("PASS async_tx_%u %08x\n", (unsigned)bit_period, (unsigned)took);
}

/* --- 4. TX -> RX on chip, with no jumper. ------------------------------- */
/*
 * A smart pin's A input does not have to be its own pin: bits 31:28 of the
 * WRPIN mode select a neighbour, %1111 meaning "the pin below me". So an
 * ASYNC_RX on PIN_RX can listen to the ASYNC_TX one pin below it, and the
 * protocol's whole byte path -- framing, baud, sampling -- is exercised
 * without wiring anything to the board.
 */
#define A_INPUT_MINUS_ONE 0xF0000000U

static void test_loopback(uint32_t bit_period, uint32_t byte)
{
    const uint32_t bit_mode = 7U + (bit_period << 16);
    uint32_t took;
    uint32_t got;

    _pinclear(PIN_TX);
    _pinclear(PIN_RX);
    _pinstart(PIN_RX, A_INPUT_MINUS_ONE | P_ASYNC_RX, bit_mode, 0);
    _pinstart(PIN_TX, P_OE | P_ASYNC_TX, bit_mode, 0);

    _wypin(PIN_TX, byte);
    took = wait_in(PIN_RX, TIMEOUT_CLOCKS);
    got = (uint32_t)_rdpin(PIN_RX);
    _pinclear(PIN_TX);
    _pinclear(PIN_RX);

    /* P2 async receive left-justifies: an 8-bit character arrives in 31:24. */
    printf("PASS loopback_took_%u %08x\n", (unsigned)bit_period, (unsigned)took);
    printf("PASS loopback_byte_%u %08x\n", (unsigned)bit_period, (unsigned)(got >> 24));
}

/* --- 5. P_NCO_FREQ: the continuous-velocity step train. ----------------- */
/*
 * Y is added to a 32-bit accumulator every clock and the pin follows the
 * accumulator's MSB, so the pin is a square wave at Y * clk / 2^32. Sampling
 * it on a fixed cadence turns that wave into a bit pattern, which is a far
 * sharper assertion than "the pin changed at some point": it pins the PHASE,
 * and a model that drives a step train as levels rather than edges gets a
 * different word here.
 */
static void test_nco_pattern(uint32_t nco_word, uint32_t gap)
{
    uint32_t bits = 0;
    unsigned i;

    _pinclear(PIN_NCO);
    _pinstart(PIN_NCO, P_NCO_FREQ | P_OE, 1U, nco_word);
    for (i = 0; i < 32U; i++)
    {
        bits = (bits << 1) | (_pinr(PIN_NCO) ? 1U : 0U);
        _waitx(gap);
    }
    _pinclear(PIN_NCO);

    printf("PASS nco_pattern_%u %08x\n", (unsigned)gap, (unsigned)bits);
}

void main(void)
{
    _clkset(_SETFREQ, _CLOCKFREQ);
    _setbaud(230400);
    printf("PINS\n");

    test_drive_readback();

    /* A short train and a longer one: the short one catches an off-by-one in
     * the transition count, the long one catches a wrong period. */
    test_transition(200U, 4U);
    test_transition(1000U, 20U);

    /* 1.6 Mbaud and 2 Mbaud at 160 MHz -- the second is the rate the board
     * actually runs the protocol at. */
    test_async_tx(100U, 0x5AU);
    test_async_tx(80U, 0xFFU);

    test_loopback(100U, 0x5AU);
    test_loopback(80U, 0xA5U);

    /* 2^31 is exactly half the accumulator: one full pin period every two
     * clocks. 2^28 is sixteen times slower, so the sampling cadence below
     * resolves it into a recognisable square wave. */
    test_nco_pattern(0x10000000U, 8U);
    test_nco_pattern(0x08000000U, 16U);

    printf("RESULT 0 PASS\n");
    _waitms(20);
    _cogstop(_cogid());
}
