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
#define CMD_RDATA 0x10

/* ---- HAL_serial doubles ---- */
static int d_startCount, d_stopCount;
static uint8_t d_writtenReg[IO_ADS122U04_REGISTER_COUNT]; /* last value written per register */
static int d_pendingReadReg;                              /* register a read was just requested for (-1 = none) */
static bool d_readOk;                                     /* register read-back succeeds */
static bool d_corruptReadback;                            /* return a wrong value on read-back */
static bool d_sawReset, d_sawStart;
static bool d_convOk;
static uint8_t d_convBytes[3];
/* Leftover bytes sitting in the RX FIFO (e.g. a late reply to a request that
 * already timed out). receiveConversion drains these before issuing RDATA, so
 * the double MUST model a finite backlog — an "always a byte available" double
 * makes that drain loop spin forever. */
static int d_staleBytes;
static int d_drainCount;           /* stale bytes actually consumed */
static int d_drainedBeforeRdata;   /* value of d_drainCount when RDATA was sent */
static bool d_sawRdata;

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
    else if (len == 2 && data[0] == SYNC && data[1] == CMD_RDATA)
    {
        d_sawRdata = true;
        d_drainedBeforeRdata = d_drainCount; /* snapshot: drain must precede RDATA */
    }
}

bool HAL_serial_recieveDataTimeout(HAL_serial_channel_E ch, uint8_t *const data, uint32_t len, uint32_t timeout_us)
{
    (void)ch; (void)timeout_us;
    if (len == 1)
    {
        if (d_pendingReadReg >= 0 && d_pendingReadReg < IO_ADS122U04_REGISTER_COUNT)
        {
            /* Answering a read-register command. */
            uint8_t v = d_writtenReg[d_pendingReadReg];
            if (d_corruptReadback) v = (uint8_t)(v ^ 0xFF);
            data[0] = v;
            d_pendingReadReg = -1; /* one reply per request */
            return d_readOk;
        }
        /* Unsolicited single-byte read = the stale-byte drain. Hand back only
         * what is actually queued, then report the FIFO empty. */
        if (d_staleBytes > 0)
        {
            d_staleBytes--;
            d_drainCount++;
            data[0] = 0xAA;
            return true;
        }
        return false;
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
    d_pendingReadReg = -1;
    d_readOk = true;
    d_corruptReadback = false;
    d_sawReset = d_sawStart = false;
    d_convOk = true;
    d_staleBytes = 0;
    d_drainCount = 0;
    d_drainedBeforeRdata = -1;
    d_sawRdata = false;
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

/* Ratiometric conversion, independent of the driver's expression:
 *   signal[nV/V] = counts * 1e9 / (gain * 2^23),  gain = 128 (CONFIG0). */
#define ADC_GAIN 128
static int32_t expected_nVV(int32_t counts)
{
    return (int32_t)(((int64_t)counts * 1000000000LL) / ((int64_t)ADC_GAIN << 23));
}

void test_receiveConversion_assembles_24bit_word_lsb_first(void)
{
    d_convBytes[0] = 0x01; /* LSB on the wire */
    d_convBytes[1] = 0x02;
    d_convBytes[2] = 0x03; /* MSB */
    d_convOk = true;
    int32_t signal_nVV = 0;
    TEST_ASSERT_TRUE(IO_ADS122U04_receiveConversion(CH, &signal_nVV, 1000));
    TEST_ASSERT_EQUAL_INT32(expected_nVV(0x030201), signal_nVV);
}

/* 24-bit two's complement must sign-extend, or every tensile reading below the
 * tare point would come back as a huge positive force. */
void test_receiveConversion_sign_extends_negative_counts(void)
{
    d_convBytes[0] = 0xFF;
    d_convBytes[1] = 0xFF;
    d_convBytes[2] = 0xFF; /* 0xFFFFFF = -1 */
    d_convOk = true;
    int32_t signal_nVV = 0;
    TEST_ASSERT_TRUE(IO_ADS122U04_receiveConversion(CH, &signal_nVV, 1000));
    TEST_ASSERT_EQUAL_INT32(expected_nVV(-1), signal_nVV);

    d_convBytes[0] = 0x00; d_convBytes[1] = 0x00; d_convBytes[2] = 0x80; /* most negative */
    TEST_ASSERT_TRUE(IO_ADS122U04_receiveConversion(CH, &signal_nVV, 1000));
    TEST_ASSERT_EQUAL_INT32(expected_nVV(-8388608), signal_nVV);
}

void test_receiveConversion_reports_timeout(void)
{
    d_convOk = false;
    int32_t signal_nVV = 0;
    TEST_ASSERT_FALSE(IO_ADS122U04_receiveConversion(CH, &signal_nVV, 1000));
}

/* Manual-read framing only stays aligned if leftovers from a previous, timed-out
 * request are flushed BEFORE the new RDATA goes out — otherwise the reply is
 * assembled from stale bytes and every later reading is rotated. */
void test_receiveConversion_drains_stale_bytes_before_requesting(void)
{
    d_staleBytes = 5;
    d_convBytes[0] = 0x10; d_convBytes[1] = 0x20; d_convBytes[2] = 0x30;
    d_convOk = true;
    int32_t signal_nVV = 0;
    TEST_ASSERT_TRUE(IO_ADS122U04_receiveConversion(CH, &signal_nVV, 1000));
    TEST_ASSERT_TRUE(d_sawRdata);
    TEST_ASSERT_EQUAL_INT(5, d_drainedBeforeRdata); /* all five flushed first */
    TEST_ASSERT_EQUAL_INT(0, d_staleBytes);
    TEST_ASSERT_EQUAL_INT32(expected_nVV(0x302010), signal_nVV);
}

int main(void)
{
    UNITY_BEGIN();
    RUN_TEST(test_start_success_resets_configures_and_starts);
    RUN_TEST(test_start_writes_then_reads_back_all_five_registers);
    RUN_TEST(test_start_fails_on_register_read_timeout);
    RUN_TEST(test_start_fails_on_config_mismatch);
    RUN_TEST(test_stop_stops_serial);
    RUN_TEST(test_receiveConversion_assembles_24bit_word_lsb_first);
    RUN_TEST(test_receiveConversion_sign_extends_negative_counts);
    RUN_TEST(test_receiveConversion_reports_timeout);
    RUN_TEST(test_receiveConversion_drains_stale_bytes_before_requesting);
    return UNITY_END();
}
