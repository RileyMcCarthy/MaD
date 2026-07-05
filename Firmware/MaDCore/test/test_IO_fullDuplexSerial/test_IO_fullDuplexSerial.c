/*
 * Unit tests for IO_fullDuplexSerial — the buffered full-duplex serial layer
 * sitting on top of the (unbuffered) HAL_serial driver.
 *
 * The module owns two lock-free SPSC rings per channel (rx + tx) backed by the
 * buffers in IO_fullDuplexSerial_channelConfig (the real Config/ translation
 * unit is #included here so the production buffer sizes / wiring are exercised).
 * HAL_serial_* are replaced by controllable test doubles defined below; the
 * module itself is the only code under test.
 *
 * Behaviours pinned down:
 *   - init() starts the HAL serial channel(s) exactly once each.
 *   - send() enqueues into the tx ring (accumulating across calls), rejects an
 *     out-of-range channel, and rejects bytes once the ring is full (a ring of
 *     N slots holds N-1 bytes).
 *   - run() flushes all pending tx to the HAL (in FIFO order) then leaves the
 *     ring empty; with nothing pending it does not transmit.
 *   - run() burst-drains ALL bytes the HAL offers in a single pass (via
 *     HAL_serial_recieveBytes), not one-per-cycle, and ingests nothing when the
 *     HAL has no bytes.
 *   - receive() copies FIFO-ordered bytes out and decrements the count; a
 *     partial read leaves the remainder in order; an empty ring returns false.
 *   - available() mirrors the live rx count.
 *
 * run() pulls rx bytes through HAL_serial_recieveBytes (the batch drain), so the
 * bytes to be ingested are staged *before* the run() that consumes them.
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

/* transmitData capture: bytes are accumulated in order across calls (run()
 * flushes the tx ring one byte per HAL call). */
static uint32_t d_txCallCount;
static HAL_serial_channel_E d_lastTxChannel;
static uint32_t d_txTotal;
static uint8_t d_txCapture[DBL_TX_CAP];

/* recieveBytes script: a queue of bytes handed out (up to maxBytes) per call. */
static uint8_t d_rxScript[256];
static uint32_t d_rxScriptLen;
static uint32_t d_rxScriptPos;

static void doubles_reset(void)
{
    d_startCount = 0U;
    d_lastStartChannel = HAL_SERIAL_CHANNEL_COUNT;

    d_txCallCount = 0U;
    d_lastTxChannel = HAL_SERIAL_CHANNEL_COUNT;
    d_txTotal = 0U;
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
    for (uint32_t i = 0U; i < len; i++)
    {
        if (d_txTotal < DBL_TX_CAP)
        {
            d_txCapture[d_txTotal++] = data[i];
        }
    }
}

uint32_t HAL_serial_recieveBytes(HAL_serial_channel_E channel, uint8_t *const buf, uint32_t maxBytes)
{
    (void)channel;
    uint32_t n = 0U;
    while ((n < maxBytes) && (d_rxScriptPos < d_rxScriptLen))
    {
        buf[n] = d_rxScript[d_rxScriptPos];
        n++;
        d_rxScriptPos++;
    }
    return n;
}

bool HAL_serial_recieveByte(HAL_serial_channel_E channel, uint8_t *const data)
{
    (void)channel; (void)data;
    return false; /* unused by IO_fullDuplexSerial.c now; stub to satisfy the link */
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
    /* init() re-inits both rings (front=rear=0), so each test starts clean. */
    IO_fullDuplexSerial_init(HAL_lock_create());
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

void test_send_accumulatesThenFlushesInOrder(void)
{
    fds_init();

    const uint8_t a[3] = { 'A', 'B', 'C' };
    const uint8_t b[2] = { 'D', 'E' };

    TEST_ASSERT_TRUE(IO_fullDuplexSerial_send(CH, a, sizeof(a)));
    TEST_ASSERT_TRUE(IO_fullDuplexSerial_send(CH, b, sizeof(b)));

    /* The accumulated bytes flush out, in order, on the next run(). */
    IO_fullDuplexSerial_run();
    const uint8_t expect[5] = { 'A', 'B', 'C', 'D', 'E' };
    TEST_ASSERT_EQUAL_UINT32(5U, d_txTotal);
    TEST_ASSERT_EQUAL_UINT8_ARRAY(expect, d_txCapture, 5);
    TEST_ASSERT_EQUAL_INT(IO_fullDuplexSerial_channelConfig[CH].hardwareSerialChannel, d_lastTxChannel);
}

void test_send_rejectsOutOfRangeChannel(void)
{
    fds_init();
    const uint8_t x = 0x5A;
    TEST_ASSERT_FALSE(IO_fullDuplexSerial_send(IO_FULLDUPLEXSERIAL_CHANNEL_COUNT, &x, 1U));
    /* nothing was buffered: a run() transmits nothing */
    IO_fullDuplexSerial_run();
    TEST_ASSERT_EQUAL_UINT32(0U, d_txTotal);
}

void test_send_rejectsWhenRingFull(void)
{
    fds_init();

    /* A ring of `size` slots holds size-1 bytes. */
    const uint32_t cap = IO_fullDuplexSerial_channelConfig[CH].txBufferSize;
    static uint8_t big[16384];
    memset(big, 0x7E, sizeof(big));

    /* The largest write that fits is cap-1. */
    TEST_ASSERT_TRUE(IO_fullDuplexSerial_send(CH, big, cap - 1U));

    /* Now full: even a single further byte is rejected. */
    const uint8_t one = 0x11;
    TEST_ASSERT_FALSE(IO_fullDuplexSerial_send(CH, &one, 1U));
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

    /* All staged bytes were transmitted, in order, on the hardware channel. */
    TEST_ASSERT_EQUAL_UINT32(4U, d_txTotal);
    TEST_ASSERT_EQUAL_UINT8_ARRAY(payload, d_txCapture, 4);
    TEST_ASSERT_EQUAL_INT(IO_fullDuplexSerial_channelConfig[CH].hardwareSerialChannel, d_lastTxChannel);

    /* A second run with nothing pending transmits nothing further. */
    const uint32_t callsAfterFirst = d_txCallCount;
    IO_fullDuplexSerial_run();
    TEST_ASSERT_EQUAL_UINT32(callsAfterFirst, d_txCallCount);
    TEST_ASSERT_EQUAL_UINT32(4U, d_txTotal);
}

void test_run_noTransmitWhenTxEmpty(void)
{
    fds_init();
    IO_fullDuplexSerial_run();
    TEST_ASSERT_EQUAL_UINT32(0U, d_txCallCount);
    TEST_ASSERT_EQUAL_UINT32(0U, d_txTotal);
}

/* ====================================================================== *
 * run — receive path                                                     *
 * ====================================================================== */

void test_run_burstDrainsAllAvailableInOnePass(void)
{
    fds_init();

    const uint8_t stream[3] = { 'X', 'Y', 'Z' };
    rx_stage(stream, sizeof(stream));

    /* A single run() drains everything the HAL offers (burst), not one byte. */
    IO_fullDuplexSerial_run();
    TEST_ASSERT_EQUAL_UINT32(3U, IO_fullDuplexSerial_available(CH));

    /* Script drained: further cycles add nothing. */
    IO_fullDuplexSerial_run();
    TEST_ASSERT_EQUAL_UINT32(3U, IO_fullDuplexSerial_available(CH));
}

void test_run_noIngestWhenHalHasNoByte(void)
{
    fds_init();
    /* empty script => recieveBytes returns 0 */
    IO_fullDuplexSerial_run();
    TEST_ASSERT_EQUAL_UINT32(0U, IO_fullDuplexSerial_available(CH));
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
    IO_fullDuplexSerial_run();
    TEST_ASSERT_EQUAL_UINT32(4U, IO_fullDuplexSerial_available(CH));

    uint8_t out[8] = {0};
    TEST_ASSERT_TRUE(IO_fullDuplexSerial_receive(CH, out, sizeof(out)));
    TEST_ASSERT_EQUAL_UINT8_ARRAY(stream, out, 4);
    TEST_ASSERT_EQUAL_UINT32(0U, IO_fullDuplexSerial_available(CH));

    /* Now empty again. */
    TEST_ASSERT_FALSE(IO_fullDuplexSerial_receive(CH, out, sizeof(out)));
}

void test_receive_partialLeavesRemainderInOrder(void)
{
    fds_init();

    const uint8_t stream[5] = { 10, 20, 30, 40, 50 };
    rx_stage(stream, sizeof(stream));
    IO_fullDuplexSerial_run();
    TEST_ASSERT_EQUAL_UINT32(5U, IO_fullDuplexSerial_available(CH));

    /* Read only the first 2 bytes; the remaining 3 stay queued, in order. */
    uint8_t out[2] = {0};
    TEST_ASSERT_TRUE(IO_fullDuplexSerial_receive(CH, out, 2U));
    const uint8_t firstTwo[2] = { 10, 20 };
    TEST_ASSERT_EQUAL_UINT8_ARRAY(firstTwo, out, 2);
    TEST_ASSERT_EQUAL_UINT32(3U, IO_fullDuplexSerial_available(CH));

    /* Draining the rest yields exactly the tail, in order. */
    uint8_t rest[3] = {0};
    TEST_ASSERT_TRUE(IO_fullDuplexSerial_receive(CH, rest, sizeof(rest)));
    const uint8_t tail[3] = { 30, 40, 50 };
    TEST_ASSERT_EQUAL_UINT8_ARRAY(tail, rest, 3);
    TEST_ASSERT_EQUAL_UINT32(0U, IO_fullDuplexSerial_available(CH));
}

void test_receive_clampsToAvailableWhenMaxLargerThanCount(void)
{
    fds_init();

    const uint8_t stream[2] = { 0xA5, 0x3C };
    rx_stage(stream, sizeof(stream));
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
    IO_fullDuplexSerial_run();

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

    RUN_TEST(test_send_accumulatesThenFlushesInOrder);
    RUN_TEST(test_send_rejectsOutOfRangeChannel);
    RUN_TEST(test_send_rejectsWhenRingFull);

    RUN_TEST(test_run_flushesPendingTxThenClears);
    RUN_TEST(test_run_noTransmitWhenTxEmpty);

    RUN_TEST(test_run_burstDrainsAllAvailableInOnePass);
    RUN_TEST(test_run_noIngestWhenHalHasNoByte);

    RUN_TEST(test_receive_emptyReturnsFalse);
    RUN_TEST(test_receive_drainsAllInFifoOrder);
    RUN_TEST(test_receive_partialLeavesRemainderInOrder);
    RUN_TEST(test_receive_clampsToAvailableWhenMaxLargerThanCount);

    RUN_TEST(test_roundTrip_runIngestsThenReceiveReturns);
    return UNITY_END();
}
