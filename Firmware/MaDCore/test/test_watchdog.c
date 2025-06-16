#include <unity.h>
#include <propeller2.h>
#include <string.h>
#include "watchdog.h"

#define TIME_SEC_TO_US(sec) ((sec) * 1000000)

extern uint32_t global_timeus;

void test_watchdog(void)
{
    TEST_ASSERT_TRUE(watchdog_isAllAlive());
    watchdog_run();
    watchdog_run();

    TEST_ASSERT_TRUE(watchdog_isAllAlive());
    global_timeus += TIME_SEC_TO_US(1);
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
