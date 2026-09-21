#include <unity.h>
#include "HAL_time.h"
#include <string.h>
#include "watchdog.h"
#include "vibes_behaviour.h"

#define TIME_SEC_TO_US(sec) ((sec) * 1000000)

extern uint32_t global_timeus;

void test_watchdog(void)
{
    VIBES_TEST("watchdog.check-in-timeout-and-revive",
               "src/DEV/watchdog.c#watchdog_run",
               "every supervised loop starts checking in, then three seconds pass with no check-in, then only the monitor loop checks in, then every loop checks in");
    VIBES_EXPECT_WHY("all-dead-after-silence",
                     "all the loops are reported dead after the silence",
                     "a wedged loop still counts as a running core, so the check-in is what catches a stall before the machine keeps moving unsupervised");
    VIBES_EXPECT("only-monitor-alive",
                 "only the monitor loop is then reported alive");
    VIBES_EXPECT("all-alive-again",
                 "all of them are alive again");
    TEST_ASSERT_TRUE(watchdog_isAllAlive());
    watchdog_run();
    watchdog_run();

    TEST_ASSERT_TRUE(watchdog_isAllAlive());
    global_timeus += TIME_SEC_TO_US(3);
    watchdog_run();

    TEST_ASSERT_FALSE(watchdog_isAllAlive());
    for (int i = 0; i < WATCHDOG_CHANNEL_COUNT; i++)
    {
        TEST_ASSERT_FALSE(watchdog_isAlive(i));
    }

    watchdog_kick(WATCHDOG_CHANNEL_MONITOR);
    watchdog_run();

    TEST_ASSERT_FALSE(watchdog_isAllAlive());
    TEST_ASSERT_TRUE(watchdog_isAlive(WATCHDOG_CHANNEL_MONITOR));

    for (int i = 0; i < WATCHDOG_CHANNEL_COUNT; i++)
    {
        watchdog_kick(i);
    }
    watchdog_run();

    TEST_ASSERT_TRUE(watchdog_isAllAlive());
}

void test_watchdog_toleratesOutOfRangeChannel(void)
{
    VIBES_TEST("watchdog.unknown-channel-tolerated",
               "src/DEV/watchdog.c#watchdog_isAlive",
               "a check-in and a liveness query on a supervised loop at the channel count, and on a negative channel index");
    VIBES_EXPECT_WHY("reported-dead",
                     "each query reports the loop dead",
                     "the channel array is indexed by this value, so an unknown loop has no liveness to report");
    VIBES_EXPECT("other-loops-unchanged", "every real loop keeps its previous liveness");

    const watchdog_channel_t pastEnd = (watchdog_channel_t)WATCHDOG_CHANNEL_COUNT;
    const watchdog_channel_t negative = (watchdog_channel_t)-1;

    /* Establish a known-alive baseline for every real channel. */
    for (int i = 0; i < WATCHDOG_CHANNEL_COUNT; i++)
    {
        watchdog_kick(i);
    }
    watchdog_run();
    TEST_ASSERT_TRUE(watchdog_isAllAlive());

    /* Out-of-range kicks must be ignored; real channels stay alive. */
    watchdog_kick(pastEnd);
    watchdog_kick(negative);
    watchdog_run();
    TEST_ASSERT_TRUE(watchdog_isAllAlive());
    for (int i = 0; i < WATCHDOG_CHANNEL_COUNT; i++)
    {
        TEST_ASSERT_TRUE(watchdog_isAlive(i));
    }

    /* Out-of-range liveness queries report dead without touching real channels. */
    TEST_ASSERT_FALSE(watchdog_isAlive(pastEnd));
    TEST_ASSERT_FALSE(watchdog_isAlive(negative));
    TEST_ASSERT_TRUE(watchdog_isAllAlive());
}
