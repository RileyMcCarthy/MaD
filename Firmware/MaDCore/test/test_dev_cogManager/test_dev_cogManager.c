/*
 * Unit tests for dev_cogManager — per-channel INITIALIZE->BOOT->RUNNING bring-up
 * with a stack-canary CRC guard that trips to ERROR on corruption.
 *
 * The real DEV/Config/dev_cogManager_config.c (which wires every app/dev/io init)
 * is NOT compiled; a fixture config supplies test task callbacks and mutable
 * canary buffers. HAL_system_startThread is the mock (returns a cog id WITHOUT
 * running the while(1) cog wrapper), so bring-up never blocks. The 8-lock mock
 * budget is exactly: 1 manager lock + 7 channel locks, so no separate debug lock
 * is created (DEBUG paths are not exercised on the happy path).
 */
#include <unity.h>
#include <string.h>
#include "../../src/DEV/dev_cogManager.c"

extern void HAL_lock_mock_reset(void);

/* ---- task callbacks + watchdog double (wrapper references watchdog_kick) ---- */
static int d_initCallCount;
static void test_cogInit(int lock) { (void)lock; d_initCallCount++; }
static void test_cogRun(void *arg) { (void)arg; }
void watchdog_kick(watchdog_channel_t channel) { (void)channel; }

/* ---- fixture config (replaces dev_cogManager_config.c) ---- */
static uint8_t s_lower[DEV_COGMANAGER_CHANNEL_COUNT][DEV_COGMANAGER_STACK_CANARY_SIZE];
static uint8_t s_upper[DEV_COGMANAGER_CHANNEL_COUNT][DEV_COGMANAGER_STACK_CANARY_SIZE];
static uint8_t s_stack[DEV_COGMANAGER_CHANNEL_COUNT][16];
#define CH(i) { test_cogInit, test_cogRun, s_stack[i], (uint32_t)sizeof(s_stack[i]), s_lower[i], s_upper[i], 0U, (watchdog_channel_t)0, "t" }
const dev_cogManager_config_S dev_cogManager_config = {
    { CH(0), CH(1), CH(2), CH(3), CH(4), CH(5), CH(6) },
};

static int s_lock;

void setUp(void)
{
    HAL_lock_mock_reset();
    s_lock = HAL_lock_create(); /* lock 0; init creates 7 channel locks -> 1..7 (8 total) */
    d_initCallCount = 0;
    memset(s_lower, 0, sizeof(s_lower));
    memset(s_upper, 0, sizeof(s_upper));
    memset(&dev_cogManager_data, 0, sizeof(dev_cogManager_data));
}
void tearDown(void) {}

void test_init_calls_each_channel_init(void)
{
    dev_cogManager_init(s_lock);
    TEST_ASSERT_EQUAL_INT(DEV_COGMANAGER_CHANNEL_COUNT, d_initCallCount);
}

void test_not_all_running_until_booted(void)
{
    dev_cogManager_init(s_lock);
    TEST_ASSERT_FALSE(dev_cogManager_isAllRunning()); /* all INITIALIZE */
    dev_cogManager_run();
    TEST_ASSERT_FALSE(dev_cogManager_isAllRunning()); /* all BOOT */
}

void test_all_channels_reach_running(void)
{
    dev_cogManager_init(s_lock);
    dev_cogManager_run(); /* INITIALIZE -> BOOT */
    dev_cogManager_run(); /* BOOT -> RUNNING */
    TEST_ASSERT_TRUE(dev_cogManager_isAllRunning());
}

void test_running_stays_running_with_intact_canary(void)
{
    dev_cogManager_init(s_lock);
    dev_cogManager_run();
    dev_cogManager_run();
    for (int i = 0; i < 5; i++) dev_cogManager_run();
    TEST_ASSERT_TRUE(dev_cogManager_isAllRunning());
}

void test_stack_overflow_trips_channel_to_error(void)
{
    dev_cogManager_init(s_lock);
    dev_cogManager_run();
    dev_cogManager_run();
    TEST_ASSERT_TRUE(dev_cogManager_isAllRunning());

    s_lower[DEV_COGMANAGER_CHANNEL_MOTOR][0] ^= 0xFF; /* corrupt one channel's canary */
    dev_cogManager_run();
    TEST_ASSERT_FALSE(dev_cogManager_isAllRunning()); /* that channel detected + ERROR */
}

void test_stack_underflow_trips_channel_to_error(void)
{
    dev_cogManager_init(s_lock);
    dev_cogManager_run();
    dev_cogManager_run();

    s_upper[DEV_COGMANAGER_CHANNEL_CONTROL][3] ^= 0xAA; /* corrupt upper canary */
    dev_cogManager_run();
    TEST_ASSERT_FALSE(dev_cogManager_isAllRunning());
}

int main(void)
{
    UNITY_BEGIN();
    RUN_TEST(test_init_calls_each_channel_init);
    RUN_TEST(test_not_all_running_until_booted);
    RUN_TEST(test_all_channels_reach_running);
    RUN_TEST(test_running_stays_running_with_intact_canary);
    RUN_TEST(test_stack_overflow_trips_channel_to_error);
    RUN_TEST(test_stack_underflow_trips_channel_to_error);
    return UNITY_END();
}
