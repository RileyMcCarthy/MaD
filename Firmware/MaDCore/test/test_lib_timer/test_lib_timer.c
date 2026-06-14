/*
 * Unit tests for lib_timer — a millisecond one-shot timer over HAL_time_getMs.
 *
 * lib_timer.c is compiled globally (build_src_filter +<Library/>), so this suite
 * calls it as a real dependency (no #include) and drives the clock through the
 * mock's `global_timeus` (microseconds; HAL_time_getMs returns it / 1000).
 *
 * Note the mock clock caps ms at ~4.29M (UINT32_MAX us), so the documented
 * 49-day uint32 ms-rollover path is not reachable here; the strict ">" expiry
 * boundary and the state transitions are what these tests pin down.
 */
#include <unity.h>
#include "lib_timer.h"

extern uint32_t global_timeus;          /* mock_propeller2.c virtual clock (us) */
extern void HAL_lock_mock_reset(void);

static void set_ms(uint32_t ms) { global_timeus = ms * 1000U; }

void setUp(void)
{
    HAL_lock_mock_reset();
    global_timeus = 0U;
}
void tearDown(void) {}

void test_lib_timer_initIsOff(void)
{
    lib_timer_S t;
    lib_timer_init(&t, 100U);
    TEST_ASSERT_EQUAL_INT(lib_timer_STATE_OFF, lib_timer_state(&t));
    TEST_ASSERT_FALSE(lib_timer_expired(&t));
}

void test_lib_timer_startRuns(void)
{
    lib_timer_S t;
    lib_timer_init(&t, 100U);
    set_ms(1000U);
    lib_timer_start(&t);
    TEST_ASSERT_EQUAL_INT(lib_timer_STATE_RUNNING, lib_timer_state(&t));
}

void test_lib_timer_expiresStrictlyAfterPeriod(void)
{
    lib_timer_S t;
    lib_timer_init(&t, 100U);
    set_ms(1000U);
    lib_timer_start(&t);

    set_ms(1100U); /* exactly periodms elapsed -> still running (comparison is >) */
    TEST_ASSERT_EQUAL_INT(lib_timer_STATE_RUNNING, lib_timer_state(&t));
    TEST_ASSERT_FALSE(lib_timer_expired(&t));

    set_ms(1101U); /* one ms past -> expired */
    TEST_ASSERT_TRUE(lib_timer_expired(&t));
}

void test_lib_timer_expiredIsSticky(void)
{
    lib_timer_S t;
    lib_timer_init(&t, 50U);
    set_ms(0U);
    lib_timer_start(&t);
    set_ms(1000U);
    TEST_ASSERT_TRUE(lib_timer_expired(&t));

    set_ms(0U); /* clock moving backwards must not un-expire a fired timer */
    TEST_ASSERT_EQUAL_INT(lib_timer_STATE_EXPIRED, lib_timer_state(&t));
}

void test_lib_timer_stopReturnsToOff(void)
{
    lib_timer_S t;
    lib_timer_init(&t, 100U);
    set_ms(1000U);
    lib_timer_start(&t);
    lib_timer_stop(&t);
    TEST_ASSERT_EQUAL_INT(lib_timer_STATE_OFF, lib_timer_state(&t));

    set_ms(99999U); /* an OFF timer never expires */
    TEST_ASSERT_FALSE(lib_timer_expired(&t));
}

void test_lib_timer_restartReArms(void)
{
    lib_timer_S t;
    lib_timer_init(&t, 100U);
    set_ms(0U);
    lib_timer_start(&t);
    set_ms(200U);
    TEST_ASSERT_TRUE(lib_timer_expired(&t));

    set_ms(500U);
    lib_timer_start(&t); /* restart re-arms from the new now */
    TEST_ASSERT_EQUAL_INT(lib_timer_STATE_RUNNING, lib_timer_state(&t));
    set_ms(550U); /* 50 < 100 */
    TEST_ASSERT_FALSE(lib_timer_expired(&t));
    set_ms(601U); /* 101 > 100 */
    TEST_ASSERT_TRUE(lib_timer_expired(&t));
}

int main(void)
{
    UNITY_BEGIN();
    RUN_TEST(test_lib_timer_initIsOff);
    RUN_TEST(test_lib_timer_startRuns);
    RUN_TEST(test_lib_timer_expiresStrictlyAfterPeriod);
    RUN_TEST(test_lib_timer_expiredIsSticky);
    RUN_TEST(test_lib_timer_stopReturnsToOff);
    RUN_TEST(test_lib_timer_restartReArms);
    return UNITY_END();
}
