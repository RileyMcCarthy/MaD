/*
 * Unit tests for dev_forceGauge — per-channel INIT/RUNNING/ERROR state machine
 * that reads the ADS122U04 ADC, converts counts to milli-Newtons via real
 * lib_utility_muldiv64_signed, and recovers from / gives up on a stuck ADC.
 *
 * Doubles: dev_nvram_getChannelData (feeds zeroForceCount + countPerForce via a
 * MachineProfile), IO_ADS122U04_start/stop/receiveConversion. The real config
 * dev_forceGauge_config.c is NOT compiled; a fixture provides the channel->ADC
 * mapping. Outputs are observed through the staged getForce/getIndex/isReady.
 */
#include <unity.h>
#include <stddef.h>
#include "../../src/DEV/dev_forceGauge.c"

extern void HAL_lock_mock_reset(void);

/* ---- fixture config (replaces dev_forceGauge_config.c) ---- */
const dev_forceGauge_channelConfig_S dev_forceGauge_channelConfig[DEV_FORCEGAUGE_CHANNEL_COUNT] = {
    { IO_ADS122U04_CHANNEL_FORCE_GAUGE },
};

/* ---- doubles ---- */
static MachineProfile d_profile;
static bool d_startReturn;
static bool d_responding;
static uint32_t d_rawADC;
static int d_startCount, d_stopCount, d_recvCount;

bool dev_nvram_getChannelData(dev_nvram_channel_t channel, void *data, size_t size)
{
    (void)channel;
    memcpy(data, &d_profile, size < sizeof(d_profile) ? size : sizeof(d_profile));
    return true;
}
bool IO_ADS122U04_start(IO_ADS122U04_channel_E ch) { (void)ch; d_startCount++; return d_startReturn; }
void IO_ADS122U04_stop(IO_ADS122U04_channel_E ch) { (void)ch; d_stopCount++; }
bool IO_ADS122U04_receiveConversion(IO_ADS122U04_channel_E ch, uint32_t *conversion, uint32_t timeout_ms)
{
    (void)ch; (void)timeout_ms;
    d_recvCount++;
    *conversion = d_rawADC;
    return d_responding;
}

static int s_lock;
static void init_with(int32_t zero, int32_t countPerForce)
{
    HAL_lock_mock_reset();
    _stdio_debug_lock = HAL_lock_create();
    s_lock = HAL_lock_create();
    memset(&dev_forceGauge_data, 0, sizeof(dev_forceGauge_data)); /* init() does not clear staged index/output */
    memset(&d_profile, 0, sizeof(d_profile));
    d_profile.forceGaugeZeroOffset = zero;
    d_profile.forceGaugeNPerStep = countPerForce;
    d_startReturn = true;
    d_responding = true;
    d_rawADC = 0;
    d_startCount = d_stopCount = d_recvCount = 0;
    dev_forceGauge_init(s_lock);
}

void setUp(void) { init_with(0, 100); }
void tearDown(void) {}

#define CH DEV_FORCEGAUGE_CHANNEL_MAIN

void test_first_run_enters_running_and_reads(void)
{
    d_rawADC = 500; /* (500 - 0) * 1000 / 100 = 5000 mN */
    dev_forceGauge_run();
    TEST_ASSERT_TRUE(dev_forceGauge_isReady(CH));
    TEST_ASSERT_EQUAL_UINT32(1, dev_forceGauge_getIndex(CH));
    TEST_ASSERT_EQUAL_INT32(5000, dev_forceGauge_getForce(CH));
}

void test_start_failure_stays_init_not_ready(void)
{
    d_startReturn = false;
    d_rawADC = 500;
    dev_forceGauge_run();
    TEST_ASSERT_FALSE(dev_forceGauge_isReady(CH));
    TEST_ASSERT_EQUAL_UINT32(0, dev_forceGauge_getIndex(CH));
}

void test_force_conversion_with_offset_and_polarity(void)
{
    init_with(1000, -658); /* normalized = rawADC - 1000 ; force = n*1000/-658 */
    d_rawADC = 342;        /* normalized = -658 -> force = +1000 mN */
    dev_forceGauge_run();
    TEST_ASSERT_EQUAL_INT32(1000, dev_forceGauge_getForce(CH));
}

void test_zero_countPerForce_yields_zero_force(void)
{
    init_with(0, 0);
    d_rawADC = 500;
    dev_forceGauge_run();
    TEST_ASSERT_EQUAL_INT32(0, dev_forceGauge_getForce(CH));
}

void test_index_increments_each_running_cycle(void)
{
    d_rawADC = 10;
    dev_forceGauge_run();
    dev_forceGauge_run();
    dev_forceGauge_run();
    TEST_ASSERT_EQUAL_UINT32(3, dev_forceGauge_getIndex(CH));
}

void test_running_to_error_when_not_responding(void)
{
    dev_forceGauge_run();              /* -> RUNNING, ready */
    TEST_ASSERT_TRUE(dev_forceGauge_isReady(CH));
    d_responding = false;
    dev_forceGauge_run();              /* runAction sets responding=false */
    dev_forceGauge_run();              /* getState -> ERROR, ready=false */
    TEST_ASSERT_FALSE(dev_forceGauge_isReady(CH));
}

void test_error_recovers_to_running(void)
{
    dev_forceGauge_run();
    d_responding = false;
    dev_forceGauge_run();
    dev_forceGauge_run();              /* now in ERROR */
    TEST_ASSERT_FALSE(dev_forceGauge_isReady(CH));
    d_responding = true;
    dev_forceGauge_run();              /* ERROR runAction sees responding=true */
    dev_forceGauge_run();              /* getState ERROR -> RUNNING, ready again */
    TEST_ASSERT_TRUE(dev_forceGauge_isReady(CH));
}

void test_error_retry_exhaustion_reinits_and_stops_adc(void)
{
    dev_forceGauge_run();              /* RUNNING */
    d_responding = false;
    for (int i = 0; i < 8; i++) dev_forceGauge_run(); /* drive ERROR retries past the limit */
    TEST_ASSERT_TRUE(d_stopCount >= 1);   /* retry-exhaustion path stopped the ADC */
    TEST_ASSERT_TRUE(d_startCount >= 2);  /* and re-INIT re-started it */
}

/* M1 — unit-scale matrix: force_mN = (raw - zero) * 1000 / countPerForce
 * (lib_utility_muldiv64_signed). Guards silent N↔mN mistakes. */
typedef struct
{
    int32_t zero;
    int32_t countPerForce;
    uint32_t rawADC;
    int32_t expectForce_mN;
} force_scale_case_t;

void test_force_scale_matrix(void)
{
    static const force_scale_case_t cases[] = {
        /* zero, countPerForce, raw, expect_mN */
        {0, 100, 0, 0},
        {0, 100, 500, 5000},          /* 500*1000/100 */
        {0, 100, 1, 10},              /* 1*1000/100 */
        {1000, -658, 342, 1000},      /* (-658)*1000/(-658) */
        {0, 200, 200, 1000},          /* 200*1000/200 */
        {50, 100, 150, 1000},         /* (100)*1000/100 */
        {0, 1, 3, 3000},              /* 3*1000/1 */
    };
    for (size_t i = 0; i < sizeof(cases) / sizeof(cases[0]); i++)
    {
        const force_scale_case_t *c = &cases[i];
        init_with(c->zero, c->countPerForce);
        d_rawADC = c->rawADC;
        dev_forceGauge_run();
        TEST_ASSERT_EQUAL_INT32_MESSAGE(
            c->expectForce_mN,
            dev_forceGauge_getForce(CH),
            "M1 force scale matrix cell failed");
        /* Sanity: mN magnitude for these fixtures stays out of "double-scaled" range */
        TEST_ASSERT_TRUE(dev_forceGauge_getForce(CH) > -200000);
        TEST_ASSERT_TRUE(dev_forceGauge_getForce(CH) < 200000);
    }
}

int main(void)
{
    UNITY_BEGIN();
    RUN_TEST(test_first_run_enters_running_and_reads);
    RUN_TEST(test_start_failure_stays_init_not_ready);
    RUN_TEST(test_force_conversion_with_offset_and_polarity);
    RUN_TEST(test_zero_countPerForce_yields_zero_force);
    RUN_TEST(test_index_increments_each_running_cycle);
    RUN_TEST(test_running_to_error_when_not_responding);
    RUN_TEST(test_error_recovers_to_running);
    RUN_TEST(test_error_retry_exhaustion_reinits_and_stops_adc);
    RUN_TEST(test_force_scale_matrix);
    return UNITY_END();
}
