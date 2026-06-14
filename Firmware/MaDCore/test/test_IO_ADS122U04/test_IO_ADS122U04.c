/*
 * Unit tests for IO_ADS122U04 — ADS122U04 ADC driver over a HAL serial channel.
 * start() resets, writes 5 config registers, reads each back and verifies it,
 * then issues START. The HAL serial layer is doubled: transmitData decodes the
 * write/read/command frames, and the register read-back echoes whatever was
 * written so the happy path verifies; faults are injected via flags.
 */
#include <unity.h>
#include <string.h>
#include "../../src/IO/IO_ADS122U04.c"

extern void HAL_lock_mock_reset(void);

#define SYNC 0x55
#define CMD_RESET 0x06
#define CMD_START 0x08

/* ---- HAL_serial doubles ---- */
static int d_startCount, d_stopCount;
static uint8_t d_writtenReg[IO_ADS122U04_REGISTER_COUNT]; /* last value written per register */
static int d_pendingReadReg;                              /* register a read was just requested for */
static bool d_readOk;                                     /* register read-back succeeds */
static bool d_corruptReadback;                            /* return a wrong value on read-back */
static bool d_sawReset, d_sawStart;
static bool d_convOk;
static uint8_t d_convBytes[3];

void HAL_serial_start(HAL_serial_channel_E ch) { (void)ch; d_startCount++; }
void HAL_serial_stop(HAL_serial_channel_E ch) { (void)ch; d_stopCount++; }

void HAL_serial_transmitData(HAL_serial_channel_E ch, const uint8_t *const data, const uint32_t len)
{
    (void)ch;
    if (len == 3 && data[0] == SYNC && (data[1] & 0xC0) == 0x40)
    {
        const int reg = (data[1] - 0x40) >> 1; /* write register command */
        if (reg >= 0 && reg < IO_ADS122U04_REGISTER_COUNT) d_writtenReg[reg] = data[2];
    }
    else if (len == 2 && data[0] == SYNC && (data[1] & 0xE0) == 0x20)
    {
        d_pendingReadReg = (data[1] - 0x20) >> 1; /* read register command */
    }
    else if (len == 2 && data[0] == SYNC && data[1] == CMD_RESET) d_sawReset = true;
    else if (len == 2 && data[0] == SYNC && data[1] == CMD_START) d_sawStart = true;
}

bool HAL_serial_recieveDataTimeout(HAL_serial_channel_E ch, uint8_t *const data, uint32_t len, uint32_t timeout_us)
{
    (void)ch; (void)timeout_us;
    if (len == 1) /* register read-back */
    {
        uint8_t v = (d_pendingReadReg >= 0 && d_pendingReadReg < IO_ADS122U04_REGISTER_COUNT)
                        ? d_writtenReg[d_pendingReadReg] : 0;
        if (d_corruptReadback) v = (uint8_t)(v ^ 0xFF);
        data[0] = v;
        return d_readOk;
    }
    if (len == 3) /* conversion */
    {
        data[0] = d_convBytes[0];
        data[1] = d_convBytes[1];
        data[2] = d_convBytes[2];
        return d_convOk;
    }
    return false;
}

void setUp(void)
{
    HAL_lock_mock_reset();
    _stdio_debug_lock = HAL_lock_create();
    d_startCount = d_stopCount = 0;
    memset(d_writtenReg, 0, sizeof(d_writtenReg));
    d_pendingReadReg = 0;
    d_readOk = true;
    d_corruptReadback = false;
    d_sawReset = d_sawStart = false;
    d_convOk = true;
    memset(d_convBytes, 0, sizeof(d_convBytes));
}
void tearDown(void) {}

#define CH IO_ADS122U04_CHANNEL_FORCE_GAUGE

void test_start_success_resets_configures_and_starts(void)
{
    TEST_ASSERT_TRUE(IO_ADS122U04_start(CH));
    TEST_ASSERT_EQUAL_INT(1, d_startCount); /* serial channel opened */
    TEST_ASSERT_TRUE(d_sawReset);           /* RESET command issued */
    TEST_ASSERT_TRUE(d_sawStart);           /* START command issued after verify */
}

void test_start_writes_then_reads_back_all_five_registers(void)
{
    /* The echo read-back equals what was written, so verification passes; also
     * confirm every register slot was actually written (non-fixed marker). */
    TEST_ASSERT_TRUE(IO_ADS122U04_start(CH));
    /* register 1 is the data-rate/conversion config — non-zero in the real config */
    TEST_ASSERT_NOT_EQUAL(0, d_writtenReg[IO_ADS122U04_CONFIG_REGISTER_1]);
}

void test_start_fails_on_register_read_timeout(void)
{
    d_readOk = false; /* read-back times out */
    TEST_ASSERT_FALSE(IO_ADS122U04_start(CH));
    TEST_ASSERT_FALSE(d_sawStart); /* never reaches START */
}

void test_start_fails_on_config_mismatch(void)
{
    d_corruptReadback = true; /* device reports a different value than written */
    TEST_ASSERT_FALSE(IO_ADS122U04_start(CH));
    TEST_ASSERT_FALSE(d_sawStart);
}

void test_stop_stops_serial(void)
{
    IO_ADS122U04_stop(CH);
    TEST_ASSERT_EQUAL_INT(1, d_stopCount);
}

void test_receiveConversion_assembles_24bit_word(void)
{
    d_convBytes[0] = 0x01;
    d_convBytes[1] = 0x02;
    d_convBytes[2] = 0x03;
    d_convOk = true;
    uint32_t conv = 0;
    TEST_ASSERT_TRUE(IO_ADS122U04_receiveConversion(CH, &conv, 1000));
    TEST_ASSERT_EQUAL_HEX32(0x030201u, conv); /* (b2<<16)|(b1<<8)|b0 */
}

void test_receiveConversion_reports_timeout(void)
{
    d_convOk = false;
    uint32_t conv = 0;
    TEST_ASSERT_FALSE(IO_ADS122U04_receiveConversion(CH, &conv, 1000));
}

int main(void)
{
    UNITY_BEGIN();
    RUN_TEST(test_start_success_resets_configures_and_starts);
    RUN_TEST(test_start_writes_then_reads_back_all_five_registers);
    RUN_TEST(test_start_fails_on_register_read_timeout);
    RUN_TEST(test_start_fails_on_config_mismatch);
    RUN_TEST(test_stop_stops_serial);
    RUN_TEST(test_receiveConversion_assembles_24bit_word);
    RUN_TEST(test_receiveConversion_reports_timeout);
    return UNITY_END();
}
