#include <unity.h>
#include "HAL_time.h"
#include <string.h>
#include "watchdog.h"
#include "vibes_behaviour.h"

#define TIME_SEC_TO_US(sec) ((sec) * 1000000)

extern uint32_t global_timeus;

void test_watchdog(void)
{
    VIBES_BEHAVIOUR_WHY("watchdog.check-in-timeout-and-revive",
                        "src/DEV/watchdog.c#watchdog_run",
                        "every supervised loop starts checking in, then three seconds pass with no check-in, then only the monitor loop checks in, then every loop checks in",
                        "supervised loops that go three seconds without a check-in are all reported dead; a check-in from the monitor loop revives only that loop; a check-in from every loop reports them all alive",
                        "a wedged loop still counts as a running core, so the check-in is what catches a stall before the machine keeps moving unsupervised");
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
