/*
 * Unit tests for dev_forceGauge — per-channel INIT/RUNNING/ERROR state machine
 * that reads the ADS122U04 ADC, converts the bridge signal to milli-Newtons via
 * real lib_utility_muldiv64_signed, and recovers from / gives up on a stuck ADC.
 *
 * The conversion is intrinsic to the load cell:
 *   mN = (signal[nV/V] - zeroBalance[nV/V]) * capacity[mN] / sensitivity[nV/V]
 *
 * Doubles: dev_nvram_getChannelData (feeds the load-cell constants via a
 * MachineProfile), IO_ADS122U04_start/stop/receiveConversion. The real config
 * dev_forceGauge_config.c is NOT compiled; a fixture provides the channel->ADC
 * mapping. Outputs are observed through the staged getForce/getIndex/isReady.
 */
#include <unity.h>
#include <stdio.h>
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
static int32_t d_signal_nVV;
static int d_startCount, d_stopCount, d_recvCount;

bool dev_nvram_getChannelData(dev_nvram_channel_t channel, void *data, size_t size)
{
    (void)channel;
    memcpy(data, &d_profile, size < sizeof(d_profile) ? size : sizeof(d_profile));
    return true;
}
bool IO_ADS122U04_start(IO_ADS122U04_channel_E ch) { (void)ch; d_startCount++; return d_startReturn; }
void IO_ADS122U04_stop(IO_ADS122U04_channel_E ch) { (void)ch; d_stopCount++; }
bool IO_ADS122U04_receiveConversion(IO_ADS122U04_channel_E ch, int32_t *signal_nVV, uint32_t timeout_ms)
{
    (void)ch; (void)timeout_ms;
    d_recvCount++;
    *signal_nVV = d_signal_nVV;
    return d_responding;
}

static int s_lock;
static void init_with(int32_t zeroBalance_nVV, int32_t capacity_mN, int32_t sensitivity_nVV)
{
    HAL_lock_mock_reset();
    _stdio_debug_lock = HAL_lock_create();
    s_lock = HAL_lock_create();
    memset(&dev_forceGauge_data, 0, sizeof(dev_forceGauge_data)); /* init() does not clear staged index/output */
    memset(&d_profile, 0, sizeof(d_profile));
    d_profile.loadCellZeroBalance = zeroBalance_nVV;
    d_profile.loadCellCapacity = capacity_mN;
    d_profile.loadCellSensitivity = sensitivity_nVV;
    d_startReturn = true;
    d_responding = true;
    d_signal_nVV = 0;
    d_startCount = d_stopCount = d_recvCount = 0;
    dev_forceGauge_init(s_lock);
}

/* 10 kg cell: 100 000 mN at 2 000 000 nV/V (2 mV/V) => 1 mN per 20 nV/V. */
void setUp(void) { init_with(0, 100000, 2000000); }
void tearDown(void) {}

#define CH DEV_FORCEGAUGE_CHANNEL_MAIN

void test_first_run_enters_running_and_reads(void)
{
    d_signal_nVV = 100000; /* 100000 * 100000 / 2000000 = 5000 mN */
    dev_forceGauge_run();
    TEST_ASSERT_TRUE(dev_forceGauge_isReady(CH));
    TEST_ASSERT_EQUAL_UINT32(1, dev_forceGauge_getIndex(CH));
    TEST_ASSERT_EQUAL_INT32(5000, dev_forceGauge_getForce(CH));
}

void test_start_failure_stays_init_not_ready(void)
{
    d_startReturn = false;
    d_signal_nVV = 100000;
    dev_forceGauge_run();
    TEST_ASSERT_FALSE(dev_forceGauge_isReady(CH));
    TEST_ASSERT_EQUAL_UINT32(0, dev_forceGauge_getIndex(CH));
}

void test_force_conversion_with_zero_balance_and_polarity(void)
{
    /* Tare offset is subtracted first; a negative sensitivity flips polarity. */
    init_with(50000, 100000, -2000000);
    d_signal_nVV = -50000; /* normalized = -100000 -> +5000 mN */
    dev_forceGauge_run();
    TEST_ASSERT_EQUAL_INT32(5000, dev_forceGauge_getForce(CH));
}

void test_zero_sensitivity_yields_zero_force(void)
{
    init_with(0, 100000, 0); /* muldiv64_signed returns 0 on a zero divisor */
    d_signal_nVV = 100000;
    dev_forceGauge_run();
    TEST_ASSERT_EQUAL_INT32(0, dev_forceGauge_getForce(CH));
}

void test_index_increments_each_running_cycle(void)
{
    d_signal_nVV = 10;
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

/* Regression: the retry budget is PER error episode. It used to be a lifetime
 * counter that was never reset, so once a first outage had exhausted it every
 * later blip — however brief — skipped the retries and tore the ADC down (stop
 * + full re-init), turning a one-tick hiccup into a multi-second outage that
 * faulted the machine and aborted any running test. */
void test_retry_budget_rearms_after_recovery(void)
{
    dev_forceGauge_run();              /* RUNNING */

    /* Episode 1: exhaust the budget so the ADC is torn down and re-inited. */
    d_responding = false;
    for (int i = 0; i < 8; i++) dev_forceGauge_run();
    TEST_ASSERT_TRUE(d_stopCount >= 1);
    d_responding = true;
    dev_forceGauge_run();
    dev_forceGauge_run();              /* back to RUNNING */
    TEST_ASSERT_TRUE(dev_forceGauge_isReady(CH));

    /* Episode 2: a single missed conversion must be retried, NOT torn down. */
    const int stopsBefore = d_stopCount;
    d_responding = false;
    dev_forceGauge_run();              /* runAction observes the miss */
    dev_forceGauge_run();              /* getState -> ERROR (budget re-armed) */
    d_responding = true;
    dev_forceGauge_run();              /* ERROR runAction sees the ADC answer */
    dev_forceGauge_run();              /* getState -> RUNNING */
    TEST_ASSERT_EQUAL_INT(stopsBefore, d_stopCount); /* no teardown */
    TEST_ASSERT_TRUE(dev_forceGauge_isReady(CH));
}


/* M1 — unit-scale matrix (ported from the counts-per-force era to the intrinsic
 * load-cell model). Guards silent unit mistakes in
 *   force_mN = (signal - zeroBalance)[nV/V] * capacity[mN] / sensitivity[nV/V]
 * — an N<->mN or mV/V<->nV/V slip anywhere here is a 1000x force error, and the
 * machine's tension limits are enforced on this number. */
typedef struct
{
    int32_t zeroBalance_nVV;
    int32_t capacity_mN;
    int32_t sensitivity_nVV;
    int32_t signal_nVV;
    int32_t expectForce_mN;
} force_scale_case_t;

void test_force_scale_matrix(void)
{
    /* Reference cell: 100 N (100000 mN) rated at 2 mV/V (2000000 nV/V). */
    static const force_scale_case_t cases[] = {
        /* tare, capacity, sensitivity, signal, expect_mN */
        {0, 100000, 2000000, 0, 0},               /* no signal, no force      */
        {0, 100000, 2000000, 2000000, 100000},    /* full scale => capacity   */
        {0, 100000, 2000000, 1000000, 50000},     /* half scale              */
        {0, 100000, 2000000, -2000000, -100000},  /* compression             */
        {0, 100000, 2000000, 20000, 1000},        /* 1% of scale => 1 N      */
        {500000, 100000, 2000000, 500000, 0},     /* tare cancels the offset  */
        {500000, 100000, 2000000, 2500000, 100000},
        {0, 100000, -2000000, 2000000, -100000},  /* sign encodes polarity    */
        {0, 100000, 0, 2000000, 0},               /* zero divisor => 0        */
    };

    for (unsigned i = 0; i < (sizeof(cases) / sizeof(cases[0])); i++)
    {
        const force_scale_case_t *c = &cases[i];
        init_with(c->zeroBalance_nVV, c->capacity_mN, c->sensitivity_nVV);
        d_signal_nVV = c->signal_nVV;
        dev_forceGauge_run();
        char msg[96];
        snprintf(msg, sizeof(msg), "case %u: signal=%d", i, c->signal_nVV);
        TEST_ASSERT_EQUAL_INT32_MESSAGE(c->expectForce_mN, dev_forceGauge_getForce(CH), msg);
    }
}

int main(void)
{
    UNITY_BEGIN();
    RUN_TEST(test_first_run_enters_running_and_reads);
    RUN_TEST(test_start_failure_stays_init_not_ready);
    RUN_TEST(test_force_conversion_with_zero_balance_and_polarity);
    RUN_TEST(test_zero_sensitivity_yields_zero_force);
    RUN_TEST(test_index_increments_each_running_cycle);
    RUN_TEST(test_running_to_error_when_not_responding);
    RUN_TEST(test_error_recovers_to_running);
    RUN_TEST(test_error_retry_exhaustion_reinits_and_stops_adc);
    RUN_TEST(test_retry_budget_rearms_after_recovery);
    RUN_TEST(test_force_scale_matrix);
    return UNITY_END();
}
