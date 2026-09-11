/*
 * Unit tests for lib_timer — a millisecond one-shot timer over HAL_time_getMs.
 *
 * lib_timer.c is compiled globally (build_src_filter +<Library/>), so this suite
 * calls it as a real dependency (no #include) and drives the clock through the
 * mock. Ordinary cases use global_timeus (us → ms via /1000). The uint32 ms
 * wraparound path uses global_timems_force + global_timems so the full 49-day
 * modular range is reachable (us cannot represent full ms wrap).
 */
#include <unity.h>
#include <stdint.h>
#include <stdbool.h>
#include "lib_timer.h"
#include "vibes_behaviour.h"

extern uint32_t global_timeus;          /* mock_propeller2.c virtual clock (us) */
extern bool global_timems_force;
extern uint32_t global_timems;
extern void HAL_lock_mock_reset(void);

static void set_ms(uint32_t ms)
{
    global_timems_force = false;
    global_timeus = ms * 1000U;
}

/** Direct ms clock — required for values beyond UINT32_MAX/1000 us. */
static void set_ms_direct(uint32_t ms)
{
    global_timems_force = true;
    global_timems = ms;
}

void setUp(void)
{
    HAL_lock_mock_reset();
    global_timeus = 0U;
    global_timems_force = false;
    global_timems = 0U;
}
void tearDown(void) {}

void test_lib_timer_initIsOff(void)
{
    VIBES_BEHAVIOUR("timer.init-is-off",
                    "src/Library/lib_timer.c#lib_timer_init",
                    "a newly created one-shot timer with a 100 millisecond period",
                    "a newly created one-shot timer is off and has not expired");
    lib_timer_S t;
    lib_timer_init(&t, 100U);
    TEST_ASSERT_EQUAL_INT(lib_timer_STATE_OFF, lib_timer_state(&t));
    TEST_ASSERT_FALSE(lib_timer_expired(&t));
}

void test_lib_timer_startRuns(void)
{
    VIBES_BEHAVIOUR("timer.start-runs",
                    "src/Library/lib_timer.c#lib_timer_start",
                    "an off one-shot timer that is started",
                    "a started one-shot timer is running");
    lib_timer_S t;
    lib_timer_init(&t, 100U);
    set_ms(1000U);
    lib_timer_start(&t);
    TEST_ASSERT_EQUAL_INT(lib_timer_STATE_RUNNING, lib_timer_state(&t));
}

void test_lib_timer_expiresStrictlyAfterPeriod(void)
{
    VIBES_BEHAVIOUR_WHY("timer.expires-strictly-after-period",
                        "src/Library/lib_timer.c#lib_timer_expired",
                        "a 100 millisecond one-shot timer checked at exactly 100 milliseconds and again at 101",
                        "a one-shot timer checked at exactly its period is still running, and has expired one millisecond later",
                        "expiry uses a strict greater-than so a timer never fires early");
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
    VIBES_BEHAVIOUR_WHY("timer.expired-is-sticky",
                        "src/Library/lib_timer.c#lib_timer_expired",
                        "an expired one-shot timer whose clock then appears to go backwards",
                        "an expired one-shot timer stays expired even if the clock appears to go backwards",
                        "a fired timeout is a latch; a clock glitch must not un-fire it");
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
    VIBES_BEHAVIOUR("timer.stop-is-off",
                    "src/Library/lib_timer.c#lib_timer_stop",
                    "a running one-shot timer that is stopped, then left well past its period",
                    "a stopped one-shot timer is off and does not expire, even after its period has passed");
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
    VIBES_BEHAVIOUR("timer.restart-rearms",
                    "src/Library/lib_timer.c#lib_timer_start",
                    "an expired one-shot timer that is started again from a later clock",
                    "starting an expired one-shot timer re-arms that timer from now, so expiry waits a full period from the new start");
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

/* 49-day uint32 ms wrap: start near MAX, advance past wrap; modular elapsed. */
void test_lib_timer_expires_across_uint32_ms_wrap(void)
{
    VIBES_BEHAVIOUR_WHY("timer.expires-across-uint32-ms-wrap",
                        "src/Library/lib_timer.c#lib_timer_expired",
                        "a 100 millisecond one-shot timer started 20 milliseconds before the millisecond clock wraps, then checked 51 and 111 milliseconds later",
                        "a one-shot timer started just before the millisecond clock wraps expires only after a full period of modular elapsed time",
                        "the millisecond clock wraps after about 49 days; unsigned wrap-around is how elapsed time is measured");
    lib_timer_S t;
    lib_timer_init(&t, 100U);
    set_ms_direct(UINT32_MAX - 20U);
    lib_timer_start(&t);

    set_ms_direct(30U); /* modular elapsed = 51 — still running */
    TEST_ASSERT_EQUAL_INT(lib_timer_STATE_RUNNING, lib_timer_state(&t));
    TEST_ASSERT_FALSE(lib_timer_expired(&t));

    set_ms_direct(90U); /* modular elapsed = 111 > 100 */
    TEST_ASSERT_TRUE(lib_timer_expired(&t));
}

void test_lib_timer_near_zero_start_no_spurious_expiry(void)
{
    VIBES_BEHAVIOUR_WHY("timer.near-zero-start-no-spurious-expiry",
                        "src/Library/lib_timer.c#lib_timer_expired",
                        "a 100 millisecond one-shot timer started at time zero and checked at 50 milliseconds, then at 101",
                        "a one-shot timer started at time zero has not expired at 50 milliseconds, and has expired one millisecond past its period",
                        "subtracting the period from a smaller now would wrap and look expired immediately after start");
    /* Class coverage for the underflow footgun: (now - period) > start with
     * now=50, period=100, start=0 underflows; (now - start) > period does not. */
    lib_timer_S t;
    lib_timer_init(&t, 100U);
    set_ms_direct(0U);
    lib_timer_start(&t);
    set_ms_direct(50U);
    TEST_ASSERT_FALSE(lib_timer_expired(&t));
    set_ms_direct(101U);
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
    RUN_TEST(test_lib_timer_expires_across_uint32_ms_wrap);
    RUN_TEST(test_lib_timer_near_zero_start_no_spurious_expiry);
    return UNITY_END();
}
