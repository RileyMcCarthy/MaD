/*
 * Unit tests for IO_fullDuplexSerial — the buffered full-duplex serial layer
 * sitting on top of the (unbuffered) HAL_serial driver.
 *
 * The module owns per-channel rx/tx ring indices into the buffers held by
 * IO_fullDuplexSerial_channelConfig (the real Config/ translation unit is
 * #included here so the production buffer sizes / wiring are exercised).
 * HAL_serial_* are replaced by controllable test doubles defined below; the
 * module itself is the only code under test.
 *
 * Behaviours pinned down:
 *   - init() starts the HAL serial channel(s) exactly once each.
 *   - send() appends into the tx buffer (accumulating across calls), rejects an
 *     out-of-range channel, and rejects a write that would not fit (strict "<"
 *     boundary => the last usable byte is txBufferSize-1).
 *   - run() flushes pending tx via a single transmitData call carrying the
 *     accumulated bytes from the channel's own txBuffer, then zeroes the index;
 *     with nothing pending it does not transmit.
 *   - run() ingests at most one rx byte per cycle (HAL_serial_recieveByte), and
 *     stops ingesting once the rx buffer is full (the overflow gate).
 *   - receive() copies FIFO-ordered bytes out, left-shifts the remainder, and
 *     decrements the count; a partial read (maxLength < available) leaves the
 *     tail intact; an empty buffer returns false.
 *   - available() mirrors the live rx count.
 *
 * The module reads HAL_serial_recieveByte once per run() cycle, so the byte to
 * be ingested is staged *before* the run() that consumes it (input-snapshot
 * cadence). HAL_lock is the native mock from mock_propeller2.c; the module's
 * LOCK spin-macro degrades to a single acquire/release under that mock.
 */

#include <unity.h>
#include <string.h>
#include <stdarg.h>

#include "HAL_lock.h"
#include "HAL_serial.h"

/* The module under test (pulls in IO_fullDuplexSerial.h + the static data). */
#include "../../src/IO/IO_fullDuplexSerial.c"
/* Real production channel config (buffers + sizes). */
#include "../../src/IO/Config/IO_fullDuplexSerial_config.c"

extern void HAL_lock_mock_reset(void);

/* DEBUG_ERROR (ENABLE_DEBUG_SERIAL=1) grabs this lock; give it a real id. */
extern int _stdio_debug_lock; /* shared in mock_propeller2.c */

/* ====================================================================== *
 * HAL_serial test doubles — controllable stand-ins.                      *
 * ====================================================================== */

#define DBL_TX_CAP 16384U

static uint32_t d_startCount;
static HAL_serial_channel_E d_lastStartChannel;

/* transmitData capture */
static uint32_t d_txCallCount;
static HAL_serial_channel_E d_lastTxChannel;
static uint32_t d_lastTxLen;
static uint8_t d_txCapture[DBL_TX_CAP];

/* recieveByte script: a queue of bytes to hand out one-per-call. */
static uint8_t d_rxScript[256];
static uint32_t d_rxScriptLen;
static uint32_t d_rxScriptPos;

static void doubles_reset(void)
{
    d_startCount = 0U;
    d_lastStartChannel = HAL_SERIAL_CHANNEL_COUNT;

    d_txCallCount = 0U;
    d_lastTxChannel = HAL_SERIAL_CHANNEL_COUNT;
    d_lastTxLen = 0U;
    memset(d_txCapture, 0, sizeof(d_txCapture));

    memset(d_rxScript, 0, sizeof(d_rxScript));
    d_rxScriptLen = 0U;
    d_rxScriptPos = 0U;
}

static void rx_stage(const uint8_t *bytes, uint32_t n)
{
    TEST_ASSERT_TRUE(n <= sizeof(d_rxScript));
    memcpy(d_rxScript, bytes, n);
    d_rxScriptLen = n;
    d_rxScriptPos = 0U;
}

void HAL_serial_start(HAL_serial_channel_E channel)
{
    d_startCount++;
    d_lastStartChannel = channel;
}

void HAL_serial_transmitData(HAL_serial_channel_E channel, const uint8_t *const data, const uint32_t len)
{
    d_txCallCount++;
    d_lastTxChannel = channel;
    d_lastTxLen = len;
    if (len <= sizeof(d_txCapture))
    {
        memcpy(d_txCapture, data, len);
    }
}

bool HAL_serial_recieveByte(HAL_serial_channel_E channel, uint8_t *const data)
{
    (void)channel;
    if (d_rxScriptPos < d_rxScriptLen)
    {
        *data = d_rxScript[d_rxScriptPos];
        d_rxScriptPos++;
        return true;
    }
    return false; /* nothing to receive this cycle */
}

bool HAL_serial_recieveDataTimeout(HAL_serial_channel_E channel, uint8_t *const data, uint32_t len, uint32_t timeout_us)
{
    (void)channel; (void)data; (void)len; (void)timeout_us;
    return false; /* unused by IO_fullDuplexSerial.c; stub to satisfy the link */
}

/* ====================================================================== *
 * Fixture                                                                *
 * ====================================================================== */

#define CH IO_FULLDUPLEXSERIAL_CHANNEL_MAIN

static void fds_init(void)
{
    doubles_reset();
    IO_fullDuplexSerial_init(HAL_lock_create());
    /* init() does not clear the static per-channel indices, so reset them
     * directly (the .c's static data is visible in this TU via #include). */
    IO_fullDuplexSerial_data.channel[CH].rxBufferIndex = 0U;
    IO_fullDuplexSerial_data.channel[CH].txBufferIndex = 0U;
}

void setUp(void)
{
    HAL_lock_mock_reset();
    _stdio_debug_lock = HAL_lock_create();
}

void tearDown(void) {}

/* ====================================================================== *
 * init                                                                   *
 * ====================================================================== */

void test_init_startsEachChannelOnce(void)
{
    doubles_reset();
    IO_fullDuplexSerial_init(HAL_lock_create());

    TEST_ASSERT_EQUAL_UINT32((uint32_t)IO_FULLDUPLEXSERIAL_CHANNEL_COUNT, d_startCount);
    TEST_ASSERT_EQUAL_INT(HAL_SERIAL_CHANNEL_MAIN, d_lastStartChannel);
}

/* ====================================================================== *
 * send                                                                   *
 * ====================================================================== */

void test_send_appendsAndAccumulates(void)
{
    fds_init();

    const uint8_t a[3] = { 'A', 'B', 'C' };
    const uint8_t b[2] = { 'D', 'E' };

    TEST_ASSERT_TRUE(IO_fullDuplexSerial_send(CH, a, sizeof(a)));
    TEST_ASSERT_EQUAL_UINT32(3U, IO_fullDuplexSerial_data.channel[CH].txBufferIndex);

    TEST_ASSERT_TRUE(IO_fullDuplexSerial_send(CH, b, sizeof(b)));
    TEST_ASSERT_EQUAL_UINT32(5U, IO_fullDuplexSerial_data.channel[CH].txBufferIndex);

    /* The bytes landed contiguously in the channel's real tx buffer. */
    const uint8_t expect[5] = { 'A', 'B', 'C', 'D', 'E' };
    TEST_ASSERT_EQUAL_UINT8_ARRAY(expect, IO_fullDuplexSerial_channelConfig[CH].txBuffer, 5);
}

void test_send_rejectsOutOfRangeChannel(void)
{
    fds_init();
    const uint8_t x = 0x5A;
    TEST_ASSERT_FALSE(IO_fullDuplexSerial_send(IO_FULLDUPLEXSERIAL_CHANNEL_COUNT, &x, 1U));
    /* nothing was buffered */
    TEST_ASSERT_EQUAL_UINT32(0U, IO_fullDuplexSerial_data.channel[CH].txBufferIndex);
}

void test_send_rejectsWhenWouldNotFit(void)
{
    fds_init();

    const uint32_t cap = IO_fullDuplexSerial_channelConfig[CH].txBufferSize;
    static uint8_t big[16384];
    memset(big, 0x7E, sizeof(big));

    /* Accept condition is strict "<": a write of exactly `cap` does NOT fit
     * (cap < cap is false). This send hits the overflow/DEBUG_ERROR branch. */
    TEST_ASSERT_FALSE(IO_fullDuplexSerial_send(CH, big, cap));
    TEST_ASSERT_EQUAL_UINT32(0U, IO_fullDuplexSerial_data.channel[CH].txBufferIndex);

    /* The largest write that fits is cap-1. */
    TEST_ASSERT_TRUE(IO_fullDuplexSerial_send(CH, big, cap - 1U));
    TEST_ASSERT_EQUAL_UINT32(cap - 1U, IO_fullDuplexSerial_data.channel[CH].txBufferIndex);

    /* Now even a single further byte overflows (index+1 == cap, not < cap). */
    const uint8_t one = 0x11;
    TEST_ASSERT_FALSE(IO_fullDuplexSerial_send(CH, &one, 1U));
    TEST_ASSERT_EQUAL_UINT32(cap - 1U, IO_fullDuplexSerial_data.channel[CH].txBufferIndex);
}

/* ====================================================================== *
 * run — transmit path                                                    *
 * ====================================================================== */

void test_run_flushesPendingTxThenClears(void)
{
    fds_init();

    const uint8_t payload[4] = { 0xDE, 0xAD, 0xBE, 0xEF };
    TEST_ASSERT_TRUE(IO_fullDuplexSerial_send(CH, payload, sizeof(payload)));

    IO_fullDuplexSerial_run();

    /* One transmit, on the configured hardware channel, with the staged bytes. */
    TEST_ASSERT_EQUAL_UINT32(1U, d_txCallCount);
    TEST_ASSERT_EQUAL_INT(IO_fullDuplexSerial_channelConfig[CH].hardwareSerialChannel, d_lastTxChannel);
    TEST_ASSERT_EQUAL_UINT32(4U, d_lastTxLen);
    TEST_ASSERT_EQUAL_UINT8_ARRAY(payload, d_txCapture, 4);

    /* tx index cleared after flush. */
    TEST_ASSERT_EQUAL_UINT32(0U, IO_fullDuplexSerial_data.channel[CH].txBufferIndex);

    /* A second run with nothing pending does not transmit again. */
    IO_fullDuplexSerial_run();
    TEST_ASSERT_EQUAL_UINT32(1U, d_txCallCount);
}

void test_run_noTransmitWhenTxEmpty(void)
{
    fds_init();
    IO_fullDuplexSerial_run();
    TEST_ASSERT_EQUAL_UINT32(0U, d_txCallCount);
}

/* ====================================================================== *
 * run — receive path                                                     *
 * ====================================================================== */

void test_run_ingestsOneBytePerCycle(void)
{
    fds_init();

    const uint8_t stream[3] = { 'X', 'Y', 'Z' };
    rx_stage(stream, sizeof(stream));

    /* Each run() consumes at most one byte from the HAL. */
    IO_fullDuplexSerial_run();
    TEST_ASSERT_EQUAL_UINT32(1U, IO_fullDuplexSerial_available(CH));
    IO_fullDuplexSerial_run();
    TEST_ASSERT_EQUAL_UINT32(2U, IO_fullDuplexSerial_available(CH));
    IO_fullDuplexSerial_run();
    TEST_ASSERT_EQUAL_UINT32(3U, IO_fullDuplexSerial_available(CH));

    /* Script drained: further cycles add nothing. */
    IO_fullDuplexSerial_run();
    TEST_ASSERT_EQUAL_UINT32(3U, IO_fullDuplexSerial_available(CH));
}

void test_run_noIngestWhenHalHasNoByte(void)
{
    fds_init();
    /* empty script => recieveByte returns false */
    IO_fullDuplexSerial_run();
    TEST_ASSERT_EQUAL_UINT32(0U, IO_fullDuplexSerial_available(CH));
}

void test_run_stopsIngestingWhenRxFull(void)
{
    fds_init();

    /* Drive the index to the full mark directly (filling 8096 bytes one-per-run
     * would be wasteful); the overflow gate is `rxBufferIndex < rxBufferSize`. */
    const uint32_t cap = IO_fullDuplexSerial_channelConfig[CH].rxBufferSize;
    IO_fullDuplexSerial_data.channel[CH].rxBufferIndex = cap;

    const uint8_t stream[2] = { 1, 2 };
    rx_stage(stream, sizeof(stream));

    IO_fullDuplexSerial_run(); /* full -> overflow branch, no recieveByte */
    TEST_ASSERT_EQUAL_UINT32(cap, IO_fullDuplexSerial_available(CH));
    TEST_ASSERT_EQUAL_UINT32(0U, d_rxScriptPos); /* HAL not polled for rx */
}

/* ====================================================================== *
 * receive                                                                *
 * ====================================================================== */

void test_receive_emptyReturnsFalse(void)
{
    fds_init();
    uint8_t out[8] = {0};
    TEST_ASSERT_FALSE(IO_fullDuplexSerial_receive(CH, out, sizeof(out)));
    TEST_ASSERT_EQUAL_UINT32(0U, IO_fullDuplexSerial_available(CH));
}

void test_receive_drainsAllInFifoOrder(void)
{
    fds_init();

    const uint8_t stream[4] = { 'w', 'x', 'y', 'z' };
    rx_stage(stream, sizeof(stream));
    for (uint32_t i = 0U; i < sizeof(stream); i++)
    {
        IO_fullDuplexSerial_run();
    }
    TEST_ASSERT_EQUAL_UINT32(4U, IO_fullDuplexSerial_available(CH));

    uint8_t out[8] = {0};
    TEST_ASSERT_TRUE(IO_fullDuplexSerial_receive(CH, out, sizeof(out)));
    TEST_ASSERT_EQUAL_UINT8_ARRAY(stream, out, 4);
    TEST_ASSERT_EQUAL_UINT32(0U, IO_fullDuplexSerial_available(CH));

    /* Now empty again. */
    TEST_ASSERT_FALSE(IO_fullDuplexSerial_receive(CH, out, sizeof(out)));
}

void test_receive_partialLeavesTailShifted(void)
{
    fds_init();

    const uint8_t stream[5] = { 10, 20, 30, 40, 50 };
    rx_stage(stream, sizeof(stream));
    for (uint32_t i = 0U; i < sizeof(stream); i++)
    {
        IO_fullDuplexSerial_run();
    }
    TEST_ASSERT_EQUAL_UINT32(5U, IO_fullDuplexSerial_available(CH));

    /* Read only the first 2 bytes; the remaining 3 must be left-shifted. */
    uint8_t out[2] = {0};
    TEST_ASSERT_TRUE(IO_fullDuplexSerial_receive(CH, out, 2U));
    const uint8_t firstTwo[2] = { 10, 20 };
    TEST_ASSERT_EQUAL_UINT8_ARRAY(firstTwo, out, 2);
    TEST_ASSERT_EQUAL_UINT32(3U, IO_fullDuplexSerial_available(CH));

    /* The buffer head now starts at the shifted tail {30,40,50}. */
    const uint8_t tail[3] = { 30, 40, 50 };
    TEST_ASSERT_EQUAL_UINT8_ARRAY(tail, IO_fullDuplexSerial_channelConfig[CH].rxBuffer, 3);

    /* Draining the rest yields exactly the tail, in order. */
    uint8_t rest[3] = {0};
    TEST_ASSERT_TRUE(IO_fullDuplexSerial_receive(CH, rest, sizeof(rest)));
    TEST_ASSERT_EQUAL_UINT8_ARRAY(tail, rest, 3);
    TEST_ASSERT_EQUAL_UINT32(0U, IO_fullDuplexSerial_available(CH));
}

void test_receive_clampsToAvailableWhenMaxLargerThanCount(void)
{
    fds_init();

    const uint8_t stream[2] = { 0xA5, 0x3C };
    rx_stage(stream, sizeof(stream));
    IO_fullDuplexSerial_run();
    IO_fullDuplexSerial_run();
    TEST_ASSERT_EQUAL_UINT32(2U, IO_fullDuplexSerial_available(CH));

    /* maxLength far exceeds the 2 available => copy is clamped to 2. */
    uint8_t out[64];
    memset(out, 0xEE, sizeof(out));
    TEST_ASSERT_TRUE(IO_fullDuplexSerial_receive(CH, out, sizeof(out)));
    TEST_ASSERT_EQUAL_UINT8_ARRAY(stream, out, 2);
    TEST_ASSERT_EQUAL_UINT8(0xEE, out[2]); /* untouched beyond the clamp */
    TEST_ASSERT_EQUAL_UINT32(0U, IO_fullDuplexSerial_available(CH));
}

/* ====================================================================== *
 * round-trip                                                             *
 * ====================================================================== */

void test_roundTrip_runIngestsThenReceiveReturns(void)
{
    fds_init();

    const uint8_t msg[6] = { 'H', 'e', 'l', 'l', 'o', '!' };
    rx_stage(msg, sizeof(msg));
    for (uint32_t i = 0U; i < sizeof(msg); i++)
    {
        IO_fullDuplexSerial_run();
    }

    uint8_t out[6] = {0};
    TEST_ASSERT_TRUE(IO_fullDuplexSerial_receive(CH, out, sizeof(out)));
    TEST_ASSERT_EQUAL_UINT8_ARRAY(msg, out, 6);
}

/* ====================================================================== *
 * Runner                                                                 *
 * ====================================================================== */

int main(void)
{
    UNITY_BEGIN();
    RUN_TEST(test_init_startsEachChannelOnce);

    RUN_TEST(test_send_appendsAndAccumulates);
    RUN_TEST(test_send_rejectsOutOfRangeChannel);
    RUN_TEST(test_send_rejectsWhenWouldNotFit);

    RUN_TEST(test_run_flushesPendingTxThenClears);
    RUN_TEST(test_run_noTransmitWhenTxEmpty);

    RUN_TEST(test_run_ingestsOneBytePerCycle);
    RUN_TEST(test_run_noIngestWhenHalHasNoByte);
    RUN_TEST(test_run_stopsIngestingWhenRxFull);

    RUN_TEST(test_receive_emptyReturnsFalse);
    RUN_TEST(test_receive_drainsAllInFifoOrder);
    RUN_TEST(test_receive_partialLeavesTailShifted);
    RUN_TEST(test_receive_clampsToAvailableWhenMaxLargerThanCount);

    RUN_TEST(test_roundTrip_runIngestsThenReceiveReturns);
    return UNITY_END();
}
