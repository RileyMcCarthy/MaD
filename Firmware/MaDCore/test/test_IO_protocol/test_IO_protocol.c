/*
 * Unit tests for IO_protocol — the byte-driven receive state machine
 * (SYNC->TYPE->COMMAND->[READ done | WRITE->LENGTH->DATA->CRC]) and the ACK/
 * NACK/DATA/NOTIFICATION response framers. The serial layer is doubled with a
 * controllable RX byte buffer + TX capture; lib_utility_CRC8 is the real impl.
 * IO_protocol_data is a non-static global, so the timeout test inspects state
 * directly.
 */
#include <unity.h>
#include <string.h>
#include <stdint.h>
#include <stdbool.h>
#include "../../src/IO/IO_protocol.c"

extern void HAL_lock_mock_reset(void);
extern uint32_t global_timeus;
extern bool global_timems_force;
extern uint32_t global_timems;

/* ---- IO_fullDuplexSerial doubles ---- */
static uint8_t d_rx[400];
static uint32_t d_rxLen, d_rxPos;
static uint8_t d_tx[400];
static uint32_t d_txLen;
static bool d_sendReturn;

bool IO_fullDuplexSerial_receive(IO_fullDuplexSerial_channel_E ch, uint8_t *data, uint32_t maxLength)
{
    (void)ch; (void)maxLength;
    if (d_rxPos < d_rxLen) { data[0] = d_rx[d_rxPos++]; return true; }
    return false;
}
uint32_t IO_fullDuplexSerial_available(IO_fullDuplexSerial_channel_E ch) { (void)ch; return d_rxLen - d_rxPos; }
bool IO_fullDuplexSerial_send(IO_fullDuplexSerial_channel_E ch, const uint8_t *data, uint32_t length)
{
    (void)ch;
    memcpy(d_tx + d_txLen, data, length);
    d_txLen += length;
    return d_sendReturn;
}

static void load_rx(const uint8_t *b, uint32_t n) { memcpy(d_rx, b, n); d_rxLen = n; d_rxPos = 0; }

void setUp(void)
{
    HAL_lock_mock_reset();
    _stdio_debug_lock = HAL_lock_create();
    /* Clock starts at 0. With the rollover-safe timeout fix, a near-zero clock no
     * longer triggers a spurious DATA-state timeout, so the multi-byte WRITE tests
     * below (which failed against the old unsigned getMs-100 underflow) double as
     * the regression guard for that fix. */
    global_timeus = 0;
    d_rxLen = d_rxPos = d_txLen = 0;
    d_sendReturn = true;
    memset(&IO_protocol_data, 0, sizeof(IO_protocol_data));
    IO_protocol_init();
}
void tearDown(void) {}

/* Pump the state machine up to `calls` times; stop at the first non-NONE result. */
static IO_protocol_incommingType_E drive(int calls, IO_protocol_readType_E *rt,
                                         IO_protocol_writeType_E *wt, void *data,
                                         uint32_t *size, uint16_t maxSize)
{
    IO_protocol_incommingType_E res = IO_PROTOCOL_INCOMMING_TYPE_NONE;
    for (int i = 0; i < calls; i++)
    {
        IO_protocol_incommingType_E t = IO_protocol_recieveRequest(rt, wt, data, size, maxSize);
        if (t != IO_PROTOCOL_INCOMMING_TYPE_NONE) { res = t; break; }
    }
    return res;
}

void test_read_request_returns_read_type(void)
{
    uint8_t msg[] = { 0x55, IO_PROTOCOL_INCOMMING_TYPE_READ, IO_PROTOCOL_READ_TYPE_MACHINE_CONFIGURATION };
    load_rx(msg, sizeof(msg));
    IO_protocol_readType_E rt = 0; IO_protocol_writeType_E wt = 0; uint8_t data[16]; uint32_t size = 0;
    TEST_ASSERT_EQUAL_INT(IO_PROTOCOL_INCOMMING_TYPE_READ, drive(6, &rt, &wt, data, &size, 16));
    TEST_ASSERT_EQUAL_INT(IO_PROTOCOL_READ_TYPE_MACHINE_CONFIGURATION, rt);
}

void test_write_request_with_payload(void)
{
    uint8_t payload[2] = { 0xAA, 0xBB };
    uint8_t crc = lib_utility_CRC8(payload, 2);
    uint8_t msg[] = { 0x55, IO_PROTOCOL_INCOMMING_TYPE_WRITE, IO_PROTOCOL_WRITE_TYPE_TEST_RUN, 2, 0, 0xAA, 0xBB, crc };
    load_rx(msg, sizeof(msg));
    IO_protocol_readType_E rt = 0; IO_protocol_writeType_E wt = 0; uint8_t data[16]; uint32_t size = 0;
    TEST_ASSERT_EQUAL_INT(IO_PROTOCOL_INCOMMING_TYPE_WRITE, drive(10, &rt, &wt, data, &size, 16));
    TEST_ASSERT_EQUAL_INT(IO_PROTOCOL_WRITE_TYPE_TEST_RUN, wt);
    TEST_ASSERT_EQUAL_UINT32(2, size);
    TEST_ASSERT_EQUAL_HEX8(0xAA, data[0]);
    TEST_ASSERT_EQUAL_HEX8(0xBB, data[1]);
}

void test_write_zero_length_skips_data(void)
{
    uint8_t dummy = 0;
    uint8_t crc = lib_utility_CRC8(&dummy, 0); /* CRC over zero bytes */
    uint8_t msg[] = { 0x55, IO_PROTOCOL_INCOMMING_TYPE_WRITE, IO_PROTOCOL_WRITE_TYPE_MOTION_ENABLE, 0, 0, crc };
    load_rx(msg, sizeof(msg));
    IO_protocol_readType_E rt = 0; IO_protocol_writeType_E wt = 0; uint8_t data[16]; uint32_t size = 99;
    TEST_ASSERT_EQUAL_INT(IO_PROTOCOL_INCOMMING_TYPE_WRITE, drive(10, &rt, &wt, data, &size, 16));
    TEST_ASSERT_EQUAL_INT(IO_PROTOCOL_WRITE_TYPE_MOTION_ENABLE, wt);
    TEST_ASSERT_EQUAL_UINT32(0, size);
}

void test_crc_mismatch_is_rejected(void)
{
    uint8_t payload[2] = { 0xAA, 0xBB };
    uint8_t badCrc = (uint8_t)(lib_utility_CRC8(payload, 2) ^ 0xFF);
    uint8_t msg[] = { 0x55, IO_PROTOCOL_INCOMMING_TYPE_WRITE, IO_PROTOCOL_WRITE_TYPE_TEST_RUN, 2, 0, 0xAA, 0xBB, badCrc };
    load_rx(msg, sizeof(msg));
    IO_protocol_readType_E rt = 0; IO_protocol_writeType_E wt = 0; uint8_t data[16]; uint32_t size = 0;
    TEST_ASSERT_EQUAL_INT(IO_PROTOCOL_INCOMMING_TYPE_NONE, drive(10, &rt, &wt, data, &size, 16));
    TEST_ASSERT_EQUAL_INT(IO_PROTOCOL_RECIEVE_STATE_SYNC, IO_protocol_data.recieve.state);
}

void test_non_sync_leading_bytes_are_skipped(void)
{
    uint8_t msg[] = { 0x99, 0x12, 0x55, IO_PROTOCOL_INCOMMING_TYPE_READ, IO_PROTOCOL_READ_TYPE_STATE };
    load_rx(msg, sizeof(msg));
    IO_protocol_readType_E rt = 0; IO_protocol_writeType_E wt = 0; uint8_t data[16]; uint32_t size = 0;
    TEST_ASSERT_EQUAL_INT(IO_PROTOCOL_INCOMMING_TYPE_READ, drive(8, &rt, &wt, data, &size, 16));
    TEST_ASSERT_EQUAL_INT(IO_PROTOCOL_READ_TYPE_STATE, rt);
}

void test_length_is_clamped_to_maxSize(void)
{
    uint8_t payload[4] = { 1, 2, 3, 4 };
    uint8_t crc = lib_utility_CRC8(payload, 4);
    /* claims length 1000 but maxSize is 4 -> dataLength clamps to 4 */
    uint8_t msg[] = { 0x55, IO_PROTOCOL_INCOMMING_TYPE_WRITE, IO_PROTOCOL_WRITE_TYPE_TEST_MOVE,
                      0xE8, 0x03, 1, 2, 3, 4, crc };
    load_rx(msg, sizeof(msg));
    IO_protocol_readType_E rt = 0; IO_protocol_writeType_E wt = 0; uint8_t data[4]; uint32_t size = 0;
    TEST_ASSERT_EQUAL_INT(IO_PROTOCOL_INCOMMING_TYPE_WRITE, drive(12, &rt, &wt, data, &size, 4));
    TEST_ASSERT_EQUAL_UINT32(4, size);
    TEST_ASSERT_EQUAL_HEX8(1, data[0]);
    TEST_ASSERT_EQUAL_HEX8(4, data[3]);
}

void test_timeout_resets_to_sync(void)
{
    uint8_t msg[] = { 0x55 }; /* sync only, then the stream goes quiet */
    load_rx(msg, sizeof(msg));
    IO_protocol_readType_E rt = 0; IO_protocol_writeType_E wt = 0; uint8_t data[16]; uint32_t size = 0;
    IO_protocol_recieveRequest(&rt, &wt, data, &size, 16); /* SYNC -> TYPE, startms = 0 */
    TEST_ASSERT_EQUAL_INT(IO_PROTOCOL_RECIEVE_STATE_TYPE, IO_protocol_data.recieve.state);
    global_timeus = 200000; /* elapsed 200 ms > 100 ms timeout -> reset to SYNC */
    IO_protocol_recieveRequest(&rt, &wt, data, &size, 16); /* TYPE times out -> SYNC */
    TEST_ASSERT_EQUAL_INT(IO_PROTOCOL_RECIEVE_STATE_SYNC, IO_protocol_data.recieve.state);
}

/* Regression for 86b657ec: the old form `(getMs() - 100) > startms` underflows
 * when getMs < 100 and spuriously times out. With startms = 0 and now = 50 ms
 * the bad form yields (UINT32_MAX-49) > 0 → true (false timeout); the fixed form
 * yields (50 - 0) > 100 → false (keep waiting). */
void test_near_zero_clock_does_not_spurious_timeout(void)
{
    uint8_t msg[] = { 0x55 }; /* SYNC only — leave the machine waiting for TYPE */
    load_rx(msg, sizeof(msg));
    global_timeus = 0;
    IO_protocol_readType_E rt = 0; IO_protocol_writeType_E wt = 0; uint8_t data[16]; uint32_t size = 0;
    IO_protocol_recieveRequest(&rt, &wt, data, &size, 16); /* SYNC → TYPE, startms = 0 */
    TEST_ASSERT_EQUAL_INT(IO_PROTOCOL_RECIEVE_STATE_TYPE, IO_protocol_data.recieve.state);

    global_timeus = 50000; /* 50 ms elapsed, still under the 100 ms timeout */
    IO_protocol_recieveRequest(&rt, &wt, data, &size, 16);
    TEST_ASSERT_EQUAL_INT(IO_PROTOCOL_RECIEVE_STATE_TYPE, IO_protocol_data.recieve.state);

    /* Multi-byte WRITE still completes under a near-zero clock (startms latched
     * near 0; the whole frame finishes well under 100 ms of simulated time). */
    uint8_t payload[2] = { 0xAA, 0xBB };
    uint8_t crc = lib_utility_CRC8(payload, 2);
    uint8_t frame[] = { IO_PROTOCOL_INCOMMING_TYPE_WRITE, IO_PROTOCOL_WRITE_TYPE_TEST_RUN,
                        2, 0, 0xAA, 0xBB, crc };
    load_rx(frame, sizeof(frame));
    TEST_ASSERT_EQUAL_INT(IO_PROTOCOL_INCOMMING_TYPE_WRITE, drive(12, &rt, &wt, data, &size, 16));
    TEST_ASSERT_EQUAL_UINT32(2, size);
}

void test_timeout_survives_uint32_ms_wrap(void)
{
    uint8_t msg[] = { 0x55 };
    load_rx(msg, sizeof(msg));
    global_timems_force = true;
    global_timems = UINT32_MAX - 20U; /* startms latched here on TYPE entry */
    IO_protocol_readType_E rt = 0; IO_protocol_writeType_E wt = 0; uint8_t data[16]; uint32_t size = 0;
    IO_protocol_recieveRequest(&rt, &wt, data, &size, 16);
    TEST_ASSERT_EQUAL_INT(IO_PROTOCOL_RECIEVE_STATE_TYPE, IO_protocol_data.recieve.state);

    /* 50 ms modular elapsed — still under the 100 ms timeout. */
    global_timems = 30U; /* (30 - (MAX-20)) mod 2^32 = 51 */
    IO_protocol_recieveRequest(&rt, &wt, data, &size, 16);
    TEST_ASSERT_EQUAL_INT(IO_PROTOCOL_RECIEVE_STATE_TYPE, IO_protocol_data.recieve.state);

    /* >100 ms modular elapsed → SYNC. */
    global_timems = 90U; /* elapsed ≈ 111 */
    IO_protocol_recieveRequest(&rt, &wt, data, &size, 16);
    TEST_ASSERT_EQUAL_INT(IO_PROTOCOL_RECIEVE_STATE_SYNC, IO_protocol_data.recieve.state);
    global_timems_force = false;
}

void test_respondACK_frames_correctly(void)
{
    TEST_ASSERT_TRUE(IO_protocol_respondACK(IO_PROTOCOL_WRITE_TYPE_TEST_RUN));
    TEST_ASSERT_EQUAL_UINT32(3, d_txLen);
    TEST_ASSERT_EQUAL_HEX8(0x55, d_tx[0]);
    TEST_ASSERT_EQUAL_HEX8(IO_PROTOCOL_OUTGOING_TYPE_ACK, d_tx[1]);
    TEST_ASSERT_EQUAL_HEX8(IO_PROTOCOL_WRITE_TYPE_TEST_RUN, d_tx[2]);
}

void test_respondNACK_frames_correctly(void)
{
    TEST_ASSERT_TRUE(IO_protocol_respondNACK(IO_PROTOCOL_WRITE_TYPE_MANUAL_MOVE));
    TEST_ASSERT_EQUAL_HEX8(0x55, d_tx[0]);
    TEST_ASSERT_EQUAL_HEX8(IO_PROTOCOL_OUTGOING_TYPE_NACK, d_tx[1]);
    TEST_ASSERT_EQUAL_HEX8(IO_PROTOCOL_WRITE_TYPE_MANUAL_MOVE, d_tx[2]);
}

void test_respondData_frames_header_payload_crc(void)
{
    uint8_t payload[3] = { 0x10, 0x20, 0x30 };
    TEST_ASSERT_TRUE(IO_protocol_respondData(IO_PROTOCOL_READ_TYPE_STATE, payload, 3));
    /* header(5) + payload(3) + crc(1) = 9 */
    TEST_ASSERT_EQUAL_UINT32(9, d_txLen);
    TEST_ASSERT_EQUAL_HEX8(0x55, d_tx[0]);
    TEST_ASSERT_EQUAL_HEX8(IO_PROTOCOL_OUTGOING_TYPE_DATA, d_tx[1]);
    TEST_ASSERT_EQUAL_HEX8(IO_PROTOCOL_READ_TYPE_STATE, d_tx[2]);
    TEST_ASSERT_EQUAL_HEX8(3, d_tx[3]); /* size low */
    TEST_ASSERT_EQUAL_HEX8(0, d_tx[4]); /* size high */
    TEST_ASSERT_EQUAL_HEX8(0x10, d_tx[5]);
    TEST_ASSERT_EQUAL_HEX8(lib_utility_CRC8(payload, 3), d_tx[8]);
}

void test_sendNotification_frames_with_zero_command(void)
{
    uint8_t payload[2] = { 0xDE, 0xAD };
    TEST_ASSERT_TRUE(IO_protocol_sendNotification(payload, 2));
    TEST_ASSERT_EQUAL_HEX8(0x55, d_tx[0]);
    TEST_ASSERT_EQUAL_HEX8(IO_PROTOCOL_OUTGOING_TYPE_NOTIFICATION, d_tx[1]);
    TEST_ASSERT_EQUAL_HEX8(0, d_tx[2]); /* command field is 0 for notifications */
    TEST_ASSERT_EQUAL_HEX8(2, d_tx[3]);
    /* header(5) + payload(2) -> crc at index 7 */
    TEST_ASSERT_EQUAL_HEX8(lib_utility_CRC8(payload, 2), d_tx[7]);
}

int main(void)
{
    UNITY_BEGIN();
    RUN_TEST(test_read_request_returns_read_type);
    RUN_TEST(test_write_request_with_payload);
    RUN_TEST(test_write_zero_length_skips_data);
    RUN_TEST(test_crc_mismatch_is_rejected);
    RUN_TEST(test_non_sync_leading_bytes_are_skipped);
    RUN_TEST(test_length_is_clamped_to_maxSize);
    RUN_TEST(test_timeout_resets_to_sync);
    RUN_TEST(test_near_zero_clock_does_not_spurious_timeout);
    RUN_TEST(test_timeout_survives_uint32_ms_wrap);
    RUN_TEST(test_respondACK_frames_correctly);
    RUN_TEST(test_respondNACK_frames_correctly);
    RUN_TEST(test_respondData_frames_header_payload_crc);
    RUN_TEST(test_sendNotification_frames_with_zero_command);
    return UNITY_END();
}
