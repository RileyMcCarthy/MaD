// Unity unit-test suite for src/APP/app_monitor.c
//
// app_monitor aggregates per-tick sensor measurements (force/position/time/setpoint),
// drives a small SD-card logging state machine, and exposes thread-safe getters plus
// force/displacement limit flags derived from a loaded sample profile.
//
// The module reads ALL of its inputs once per app_monitor_run() (input snapshot),
// then acts on that snapshot. So: set double return values BEFORE the run() that
// snapshots them, and drive run() the right number of cycles.
//
// Library/ (lib_timer, lib_utility) are compiled for real and used for real.
// All peer dependencies below are local test doubles controllable via static globals.

#include <unity.h>
#include <string.h>
#include <stdint.h>
#include <stdbool.h>

#include "HAL_lock.h"
#include "app_gauge.h"          // app_gauge_coord_E
#include "dev_forceGauge_config.h" // dev_forceGauge_channel_E
#include "IO_SDCard.h"          // IO_SDCard_channel_E, IO_SDCard_mode_E
#include "IO_positionFeedback.h"// IO_positionFeedback_channel_E

#include "app_monitor.h"

/**********************************************************************
 * Shared HAL mock (test/mock_propeller2.c)
 **********************************************************************/
extern void HAL_lock_mock_reset(void);
extern uint32_t global_timeus; // microseconds; HAL_time_getUs() returns this
extern int _stdio_debug_lock; /* shared in mock_propeller2.c */          // app_monitor.c's DEBUG_INFO path locks this

/**********************************************************************
 * Test doubles for peer dependencies
 **********************************************************************/

/* --- app_gauge --- */
static int32_t dbl_force_machine;     // app_gauge_getForce(MACHINE)
static int32_t dbl_position_machine;  // app_gauge_getPosition(MACHINE)
static int32_t dbl_gaugeForce_mN;     // app_gauge_getGaugeForce_mN()
static int32_t dbl_gaugeLength_um;    // app_gauge_getGaugeLength_um()

int32_t app_gauge_getForce(app_gauge_coord_E coord)
{
    TEST_ASSERT_EQUAL_INT(APP_GAUGE_COORD_MACHINE, coord);
    return dbl_force_machine;
}
int32_t app_gauge_getPosition(app_gauge_coord_E coord)
{
    TEST_ASSERT_EQUAL_INT(APP_GAUGE_COORD_MACHINE, coord);
    return dbl_position_machine;
}
int32_t app_gauge_getGaugeForce_mN(void) { return dbl_gaugeForce_mN; }
int32_t app_gauge_getGaugeLength_um(void) { return dbl_gaugeLength_um; }

/* --- dev_forceGauge --- */
static uint32_t dbl_forceIndex; // dev_forceGauge_getIndex(MAIN)
uint32_t dev_forceGauge_getIndex(dev_forceGauge_channel_E channel)
{
    TEST_ASSERT_EQUAL_INT(DEV_FORCEGAUGE_CHANNEL_MAIN, channel);
    return dbl_forceIndex;
}

/* --- app_motion --- */
static int32_t dbl_setpoint; // app_motion_getSetpoint()
int32_t app_motion_getSetpoint(void) { return dbl_setpoint; }

/* --- app_testManagement --- */
static bool dbl_testRunning; // app_testManagement_isRunning()
bool app_testManagement_isRunning(void) { return dbl_testRunning; }

/* --- IO_positionFeedback --- */
static int dbl_setValue_calls;
static IO_positionFeedback_channel_E dbl_setValue_lastChannel;
static int32_t dbl_setValue_lastValue;
bool IO_positionFeedback_setValue(IO_positionFeedback_channel_E ch, int32_t positionUM)
{
    dbl_setValue_calls++;
    dbl_setValue_lastChannel = ch;
    dbl_setValue_lastValue = positionUM;
    return true;
}

/* --- IO_SDCard --- */
static int dbl_open_calls;
static bool dbl_open_returns;             // controllable success/failure of open
static IO_SDCard_channel_E dbl_open_lastChannel;
static char dbl_open_lastName[64];
static IO_SDCard_mode_E dbl_open_lastMode;

static int dbl_push_calls;
static IO_SDCard_channel_E dbl_push_lastChannel;
static uint32_t dbl_push_lastSize;
static app_monitor_sample_t dbl_push_lastSample;

static int dbl_close_calls;
static IO_SDCard_channel_E dbl_close_lastChannel;

bool IO_SDCard_open(IO_SDCard_channel_E channel, const char *fileName, IO_SDCard_mode_E mode)
{
    dbl_open_calls++;
    dbl_open_lastChannel = channel;
    dbl_open_lastMode = mode;
    if (fileName != NULL)
    {
        strncpy(dbl_open_lastName, fileName, sizeof(dbl_open_lastName) - 1);
        dbl_open_lastName[sizeof(dbl_open_lastName) - 1] = '\0';
    }
    return dbl_open_returns;
}
bool IO_SDCard_push(IO_SDCard_channel_E channel, void *data, uint32_t size)
{
    dbl_push_calls++;
    dbl_push_lastChannel = channel;
    dbl_push_lastSize = size;
    if (data != NULL && size <= sizeof(dbl_push_lastSample))
    {
        memcpy(&dbl_push_lastSample, data, size);
    }
    return true;
}
bool IO_SDCard_close(IO_SDCard_channel_E channel)
{
    dbl_close_calls++;
    dbl_close_lastChannel = channel;
    return true;
}

/* --- dev_cogManager introspection + app_notification peer mocks (app_monitor now
 * reports per-cog stack usage and emits notifications). No-op stubs so the suite
 * links; the existing assertions don't cover the new introspection path. */
#include "dev_cogManager.h"
#include "app_notification.h"
uint32_t dev_cogManager_getStackSize(dev_cogManager_channel_E channel) { (void)channel; return 0; }
uint32_t dev_cogManager_getStackPeak(dev_cogManager_channel_E channel) { (void)channel; return 0; }
const char *dev_cogManager_getName(dev_cogManager_channel_E channel) { (void)channel; return ""; }
void app_notification_send(app_notification_type_E type, const char *format, ...) { (void)type; (void)format; }

/**********************************************************************
 * Module under test (compiled in via #include of the .c)
 **********************************************************************/
#include "../../src/APP/app_monitor.c"

/**********************************************************************
 * Helpers
 **********************************************************************/

#define TEST_LOCK 1 /* HAL_lock_create() hands out 0,1,...; setUp creates _stdio_debug_lock=0 then this */

static void reset_doubles(void)
{
    dbl_force_machine = 0;
    dbl_position_machine = 0;
    dbl_gaugeForce_mN = 0;
    dbl_gaugeLength_um = 0;
    dbl_forceIndex = 0;
    dbl_setpoint = 0;
    dbl_testRunning = false;

    dbl_setValue_calls = 0;
    dbl_setValue_lastChannel = (IO_positionFeedback_channel_E)0;
    dbl_setValue_lastValue = 0;

    dbl_open_calls = 0;
    dbl_open_returns = true;
    dbl_open_lastChannel = (IO_SDCard_channel_E)0;
    dbl_open_lastName[0] = '\0';
    dbl_open_lastMode = IO_SDCARD_MODE_WRITE;

    dbl_push_calls = 0;
    dbl_push_lastChannel = (IO_SDCard_channel_E)0;
    dbl_push_lastSize = 0;
    memset(&dbl_push_lastSample, 0, sizeof(dbl_push_lastSample));

    dbl_close_calls = 0;
    dbl_close_lastChannel = (IO_SDCard_channel_E)0;
}

void setUp(void)
{
    HAL_lock_mock_reset();
    _stdio_debug_lock = HAL_lock_create(); /* id 0; DEBUG_INFO path needs a real lock */
    int lock = HAL_lock_create();          /* id 1 -> TEST_LOCK */
    reset_doubles();
    global_timeus = 0;
    app_monitor_init(lock);
}

void tearDown(void) {}

/* Drive the test into the RUNNING logging state. Leaves testRunning = true. */
static void enterRunning(uint32_t startTimeUs)
{
    app_monitor_setTestName("test_file");
    dbl_open_returns = true;
    dbl_testRunning = true;
    global_timeus = startTimeUs;
    app_monitor_run();
    TEST_ASSERT_EQUAL_INT(APP_MONITOR_LOGGING_STATE_RUNNING, app_monitor_data.loggingState);
}

/**********************************************************************
 * Tests: input snapshot + sample derivation
 **********************************************************************/

/* sample fields are derived from the snapshot minus gauge offsets / start time. */
void test_sample_derivation_subtracts_offsets_and_starttime(void)
{
    dbl_force_machine = 5000;
    dbl_position_machine = 12000;
    dbl_setpoint = 15000;
    dbl_gaugeForce_mN = 1200;
    dbl_gaugeLength_um = 2000;
    global_timeus = 0; /* startTime stays 0 (no test running) */
    dbl_testRunning = false;

    app_monitor_run();

    /* sample.force = force - gaugeForce_mN */
    TEST_ASSERT_EQUAL_INT32(5000 - 1200, app_monitor_data.sample.force);
    /* sample.position = position - gaugeLength_um */
    TEST_ASSERT_EQUAL_INT32(12000 - 2000, app_monitor_data.sample.position);
    /* sample.setpoint = setpoint - gaugeLength_um */
    TEST_ASSERT_EQUAL_INT32(15000 - 2000, app_monitor_data.sample.setpoint);
    /* startTime is 0 here, so sample.time == input.time */
    TEST_ASSERT_EQUAL_UINT32(0U, app_monitor_data.sample.time);
}

/* When a test starts the startTime latches input.time, so subsequent sample.time is relative. */
void test_sample_time_is_relative_to_test_start(void)
{
    /* Tick 1: start a test at t = 1_000_000 us -> startTime latches there. */
    enterRunning(1000000U);
    TEST_ASSERT_EQUAL_UINT32(1000000U, app_monitor_data.startTime);

    /* Tick 2: time advances; sample.time should be (now - startTime). */
    global_timeus = 1000000U + 750U;
    app_monitor_run();
    TEST_ASSERT_EQUAL_UINT32(750U, app_monitor_data.sample.time);
}

/* Outputs mirror the raw (machine-frame) input force/position, not the sample frame. */
void test_setOutput_publishes_raw_machine_force_and_position(void)
{
    dbl_force_machine = 8888;
    dbl_position_machine = -4321;
    dbl_gaugeForce_mN = 1000;  /* should NOT affect out.force */
    dbl_gaugeLength_um = 500;  /* should NOT affect out.position */

    app_monitor_run();

    TEST_ASSERT_EQUAL_INT32(8888, app_monitor_data.out.force);
    TEST_ASSERT_EQUAL_INT32(-4321, app_monitor_data.out.position);
}

/**********************************************************************
 * Tests: request processing (zero / set position, sample profile)
 **********************************************************************/

void test_zeroPosition_request_calls_setValue_zero_once(void)
{
    app_monitor_zeroPosition();

    /* Request is latched, not acted on until run(). */
    TEST_ASSERT_EQUAL_INT(0, dbl_setValue_calls);

    app_monitor_run();
    TEST_ASSERT_EQUAL_INT(1, dbl_setValue_calls);
    TEST_ASSERT_EQUAL_INT(IO_POSITION_FEEDBACK_CHANNEL_SERVO_FEEDBACK, dbl_setValue_lastChannel);
    TEST_ASSERT_EQUAL_INT32(0, dbl_setValue_lastValue);

    /* Request is one-shot: a second run() does NOT re-fire it. */
    app_monitor_run();
    TEST_ASSERT_EQUAL_INT(1, dbl_setValue_calls);
}

void test_setPosition_request_passes_value_through(void)
{
    app_monitor_setPosition(-1234567);
    app_monitor_run();
    TEST_ASSERT_EQUAL_INT(1, dbl_setValue_calls);
    TEST_ASSERT_EQUAL_INT32(-1234567, dbl_setValue_lastValue);
    TEST_ASSERT_EQUAL_INT(IO_POSITION_FEEDBACK_CHANNEL_SERVO_FEEDBACK, dbl_setValue_lastChannel);
}

void test_setSampleProfile_loads_on_run_and_is_readable(void)
{
    TEST_ASSERT_FALSE(app_monitor_isSampleProfileLoaded());

    app_monitor_sampleProfile_S p = {
        .maxForce = 50000,
        .maxVelocity = 10,
        .maxDisplacement = 200,
        .sampleWidth = 5,
        .sampleThickness = 2,
    };
    TEST_ASSERT_TRUE(app_monitor_setSampleProfile(&p));

    /* Not loaded until a run() processes the request. */
    TEST_ASSERT_FALSE(app_monitor_isSampleProfileLoaded());

    app_monitor_run();
    TEST_ASSERT_TRUE(app_monitor_isSampleProfileLoaded());

    app_monitor_sampleProfile_S got;
    memset(&got, 0, sizeof(got));
    app_monitor_getSampleProfile(&got);
    TEST_ASSERT_EQUAL_UINT32(50000, got.maxForce);
    TEST_ASSERT_EQUAL_UINT32(200, got.maxDisplacement);
    TEST_ASSERT_EQUAL_UINT32(5, got.sampleWidth);
    TEST_ASSERT_EQUAL_UINT32(2, got.sampleThickness);
}

void test_setSampleProfile_null_returns_false(void)
{
    TEST_ASSERT_FALSE(app_monitor_setSampleProfile(NULL));
}

void test_getSampleProfile_null_is_safe_noop(void)
{
    /* Should simply return without dereferencing. */
    app_monitor_getSampleProfile(NULL);
    TEST_PASS();
}

/**********************************************************************
 * Tests: test name set/get + truncation
 **********************************************************************/

void test_setTestName_getTestName_roundtrip(void)
{
    app_monitor_setTestName("sample42");
    char out[32];
    memset(out, 'X', sizeof(out));
    app_monitor_getTestName(out, sizeof(out));
    TEST_ASSERT_EQUAL_STRING("sample42", out);
}

void test_getTestName_truncates_to_buffer_size(void)
{
    app_monitor_setTestName("abcdefgh");
    char out[4]; /* only 3 chars + NUL fit */
    app_monitor_getTestName(out, sizeof(out));
    TEST_ASSERT_EQUAL_STRING("abc", out);
    TEST_ASSERT_EQUAL_CHAR('\0', out[3]);
}

void test_setTestName_truncates_to_internal_buffer(void)
{
    /* Internal buffer is DEV_NVRAM_MAX_SAMPLE_PROFILE_NAME (45) incl NUL. */
    char longName[80];
    memset(longName, 'A', sizeof(longName));
    longName[sizeof(longName) - 1] = '\0';

    app_monitor_setTestName(longName);

    char out[80];
    app_monitor_getTestName(out, sizeof(out));
    /* stored string is at most DEV_NVRAM_MAX_SAMPLE_PROFILE_NAME-1 chars. */
    TEST_ASSERT_EQUAL_UINT(DEV_NVRAM_MAX_SAMPLE_PROFILE_NAME - 1, (unsigned)strlen(out));
}

/**********************************************************************
 * Tests: logging state machine
 **********************************************************************/

void test_logging_idle_stays_idle_when_no_test(void)
{
    dbl_testRunning = false;
    app_monitor_run();
    TEST_ASSERT_EQUAL_INT(APP_MONITOR_LOGGING_STATE_IDLE, app_monitor_data.loggingState);
    TEST_ASSERT_EQUAL_INT(0, dbl_open_calls);
}

void test_logging_idle_to_running_opens_sample_channel_write(void)
{
    app_monitor_setTestName("mytest");
    dbl_open_returns = true;
    dbl_testRunning = true;
    global_timeus = 42;

    app_monitor_run();

    TEST_ASSERT_EQUAL_INT(APP_MONITOR_LOGGING_STATE_RUNNING, app_monitor_data.loggingState);
    TEST_ASSERT_EQUAL_INT(1, dbl_open_calls);
    TEST_ASSERT_EQUAL_INT(IO_SDCARD_CHANNEL_SAMPLE_DATA, dbl_open_lastChannel);
    TEST_ASSERT_EQUAL_INT(IO_SDCARD_MODE_WRITE, dbl_open_lastMode);
    TEST_ASSERT_EQUAL_STRING("mytest", dbl_open_lastName);
    /* startTime latched to snapshot time. */
    TEST_ASSERT_EQUAL_UINT32(42U, app_monitor_data.startTime);
}

void test_logging_idle_stays_idle_when_open_fails(void)
{
    app_monitor_setTestName("mytest");
    dbl_open_returns = false; /* header missing -> open fails */
    dbl_testRunning = true;

    app_monitor_run();

    TEST_ASSERT_EQUAL_INT(1, dbl_open_calls);
    /* Open failed -> remain IDLE, will retry next tick. */
    TEST_ASSERT_EQUAL_INT(APP_MONITOR_LOGGING_STATE_IDLE, app_monitor_data.loggingState);

    /* Next tick retries the open. */
    app_monitor_run();
    TEST_ASSERT_EQUAL_INT(2, dbl_open_calls);
}

void test_logging_running_pushes_only_on_index_update(void)
{
    enterRunning(0U);
    int pushesAfterEntry = dbl_push_calls;

    /* No index change -> no push. */
    dbl_forceIndex = app_monitor_data.input.forceIndex; /* unchanged */
    app_monitor_run();
    TEST_ASSERT_EQUAL_INT(pushesAfterEntry, dbl_push_calls);

    /* Index changes -> exactly one push of one sample struct. */
    dbl_forceIndex = app_monitor_data.input.forceIndex + 1;
    app_monitor_run();
    TEST_ASSERT_EQUAL_INT(pushesAfterEntry + 1, dbl_push_calls);
    TEST_ASSERT_EQUAL_INT(IO_SDCARD_CHANNEL_SAMPLE_DATA, dbl_push_lastChannel);
    TEST_ASSERT_EQUAL_UINT32(sizeof(app_monitor_sample_t), dbl_push_lastSize);
}

void test_logging_running_pushes_current_sample_contents(void)
{
    enterRunning(0U);

    /* Set up a fresh sample, advance the index so it's logged. */
    dbl_force_machine = 9000;
    dbl_gaugeForce_mN = 1000;       /* sample.force = 8000 */
    dbl_position_machine = 6000;
    dbl_gaugeLength_um = 1000;      /* sample.position = 5000 */
    dbl_setpoint = 7000;            /* sample.setpoint = 6000 */
    global_timeus = 250;           /* sample.time = 250 (startTime 0) */
    dbl_forceIndex = app_monitor_data.input.forceIndex + 1;

    int before = dbl_push_calls;
    app_monitor_run();
    TEST_ASSERT_EQUAL_INT(before + 1, dbl_push_calls);

    TEST_ASSERT_EQUAL_INT32(8000, dbl_push_lastSample.force);
    TEST_ASSERT_EQUAL_INT32(5000, dbl_push_lastSample.position);
    TEST_ASSERT_EQUAL_INT32(6000, dbl_push_lastSample.setpoint);
    TEST_ASSERT_EQUAL_UINT32(250U, dbl_push_lastSample.time);
}

void test_logging_running_to_stopping_starts_tail_timer(void)
{
    enterRunning(0U);

    dbl_testRunning = false; /* test ended */
    app_monitor_run();

    TEST_ASSERT_EQUAL_INT(APP_MONITOR_LOGGING_STATE_STOPPING, app_monitor_data.loggingState);
    /* close has NOT happened yet (tail timer still running). */
    TEST_ASSERT_EQUAL_INT(0, dbl_close_calls);
    TEST_ASSERT_EQUAL_INT(lib_timer_STATE_RUNNING, app_monitor_data.stopLoggingTail.state);
}

void test_logging_stopping_flushes_then_closes_after_tail(void)
{
    enterRunning(0U);

    /* End the test at t=0 -> enter STOPPING, tail timer started (100ms). */
    dbl_testRunning = false;
    global_timeus = 0;
    app_monitor_run();
    TEST_ASSERT_EQUAL_INT(APP_MONITOR_LOGGING_STATE_STOPPING, app_monitor_data.loggingState);

    /* While stopping and before tail expiry, late samples still flush on index update. */
    int before = dbl_push_calls;
    dbl_forceIndex = app_monitor_data.input.forceIndex + 1;
    global_timeus = 50U * 1000U; /* 50ms < 100ms tail */
    app_monitor_run();
    TEST_ASSERT_EQUAL_INT(before + 1, dbl_push_calls);
    TEST_ASSERT_EQUAL_INT(APP_MONITOR_LOGGING_STATE_STOPPING, app_monitor_data.loggingState);
    TEST_ASSERT_EQUAL_INT(0, dbl_close_calls);

    /* Once the tail elapses, the channel is closed and we return to IDLE. */
    global_timeus = 150U * 1000U; /* 150ms > 100ms tail */
    app_monitor_run();
    TEST_ASSERT_EQUAL_INT(1, dbl_close_calls);
    TEST_ASSERT_EQUAL_INT(IO_SDCARD_CHANNEL_SAMPLE_DATA, dbl_close_lastChannel);
    TEST_ASSERT_EQUAL_INT(APP_MONITOR_LOGGING_STATE_IDLE, app_monitor_data.loggingState);
    TEST_ASSERT_EQUAL_INT(lib_timer_STATE_OFF, app_monitor_data.stopLoggingTail.state);
}

void test_logging_full_cycle_can_restart(void)
{
    /* Run a complete IDLE->RUNNING->STOPPING->IDLE, then start a second test. */
    enterRunning(0U);
    dbl_testRunning = false;
    global_timeus = 0;
    app_monitor_run(); /* -> STOPPING */
    global_timeus = 200U * 1000U;
    app_monitor_run(); /* -> IDLE (closed) */
    TEST_ASSERT_EQUAL_INT(APP_MONITOR_LOGGING_STATE_IDLE, app_monitor_data.loggingState);

    int opensBefore = dbl_open_calls;
    dbl_testRunning = true;
    global_timeus = 300U * 1000U;
    app_monitor_run();
    TEST_ASSERT_EQUAL_INT(APP_MONITOR_LOGGING_STATE_RUNNING, app_monitor_data.loggingState);
    TEST_ASSERT_EQUAL_INT(opensBefore + 1, dbl_open_calls);
    /* startTime re-latched to the new start. */
    TEST_ASSERT_EQUAL_UINT32(300U * 1000U, app_monitor_data.startTime);
}

/**********************************************************************
 * Tests: limit checking (force / displacement / velocity)
 **********************************************************************/

void test_no_profile_means_no_limits_exceeded(void)
{
    /* Big force/displacement but no profile loaded -> all flags false. */
    dbl_force_machine = 1000000;
    dbl_position_machine = 1000000;
    app_monitor_run();
    TEST_ASSERT_FALSE(app_monitor_isForceExceeded());
    TEST_ASSERT_FALSE(app_monitor_isVelocityExceeded());
    TEST_ASSERT_FALSE(app_monitor_isDisplacementExceeded());
}

void test_force_limit_boundary_and_exceed(void)
{
    app_monitor_sampleProfile_S p = {0};
    p.maxForce = 10000;        /* mN */
    p.maxDisplacement = 100000;/* mm (huge, won't trigger) */
    app_monitor_setSampleProfile(&p);
    app_monitor_run(); /* loads profile */

    /* sample.force = force - gaugeForce_mN. Make it exactly == maxForce: NOT exceeded (strict >). */
    dbl_gaugeForce_mN = 0;
    dbl_force_machine = 10000;
    app_monitor_run();
    TEST_ASSERT_FALSE(app_monitor_isForceExceeded());

    /* One above the limit -> exceeded. */
    dbl_force_machine = 10001;
    app_monitor_run();
    TEST_ASSERT_TRUE(app_monitor_isForceExceeded());

    /* Negative force of larger magnitude also exceeds (abs is used). */
    dbl_force_machine = -10001;
    app_monitor_run();
    TEST_ASSERT_TRUE(app_monitor_isForceExceeded());
}

void test_displacement_limit_uses_mm_to_um_conversion(void)
{
    app_monitor_sampleProfile_S p = {0};
    p.maxForce = 0xFFFFFFFFU; /* never trips force */
    p.maxDisplacement = 2;    /* 2 mm == 2000 um */
    app_monitor_setSampleProfile(&p);
    app_monitor_run();

    dbl_gaugeLength_um = 0;

    /* Exactly 2000 um == limit -> NOT exceeded (strict >). */
    dbl_position_machine = 2000;
    app_monitor_run();
    TEST_ASSERT_FALSE(app_monitor_isDisplacementExceeded());

    /* 2001 um -> exceeded. */
    dbl_position_machine = 2001;
    app_monitor_run();
    TEST_ASSERT_TRUE(app_monitor_isDisplacementExceeded());

    /* Negative displacement of larger magnitude also exceeds (abs is used). */
    dbl_position_machine = -2001;
    app_monitor_run();
    TEST_ASSERT_TRUE(app_monitor_isDisplacementExceeded());
}

void test_velocity_exceeded_always_false_even_with_profile(void)
{
    app_monitor_sampleProfile_S p = {0};
    p.maxVelocity = 1; /* tiny */
    app_monitor_setSampleProfile(&p);
    app_monitor_run();

    /* Velocity check is unimplemented; flag must stay false. */
    app_monitor_run();
    TEST_ASSERT_FALSE(app_monitor_isVelocityExceeded());
}

void test_force_flag_clears_when_back_under_limit(void)
{
    app_monitor_sampleProfile_S p = {0};
    p.maxForce = 1000;
    p.maxDisplacement = 0xFFFFFFFFU;
    app_monitor_setSampleProfile(&p);
    app_monitor_run();

    dbl_force_machine = 5000; /* over */
    app_monitor_run();
    TEST_ASSERT_TRUE(app_monitor_isForceExceeded());

    dbl_force_machine = 500;  /* under */
    app_monitor_run();
    TEST_ASSERT_FALSE(app_monitor_isForceExceeded());
}

/**********************************************************************
 * Tests: init defaults
 **********************************************************************/

void test_init_sets_idle_and_no_profile(void)
{
    /* setUp already called app_monitor_init. */
    TEST_ASSERT_EQUAL_INT(APP_MONITOR_LOGGING_STATE_IDLE, app_monitor_data.loggingState);
    TEST_ASSERT_FALSE(app_monitor_isSampleProfileLoaded());
    TEST_ASSERT_EQUAL_INT(lib_timer_STATE_OFF, app_monitor_data.stopLoggingTail.state);
}

/**********************************************************************
 * main
 **********************************************************************/

int main(void)
{
    UNITY_BEGIN();

    RUN_TEST(test_init_sets_idle_and_no_profile);

    RUN_TEST(test_sample_derivation_subtracts_offsets_and_starttime);
    RUN_TEST(test_sample_time_is_relative_to_test_start);
    RUN_TEST(test_setOutput_publishes_raw_machine_force_and_position);

    RUN_TEST(test_zeroPosition_request_calls_setValue_zero_once);
    RUN_TEST(test_setPosition_request_passes_value_through);
    RUN_TEST(test_setSampleProfile_loads_on_run_and_is_readable);
    RUN_TEST(test_setSampleProfile_null_returns_false);
    RUN_TEST(test_getSampleProfile_null_is_safe_noop);

    RUN_TEST(test_setTestName_getTestName_roundtrip);
    RUN_TEST(test_getTestName_truncates_to_buffer_size);
    RUN_TEST(test_setTestName_truncates_to_internal_buffer);

    RUN_TEST(test_logging_idle_stays_idle_when_no_test);
    RUN_TEST(test_logging_idle_to_running_opens_sample_channel_write);
    RUN_TEST(test_logging_idle_stays_idle_when_open_fails);
    RUN_TEST(test_logging_running_pushes_only_on_index_update);
    RUN_TEST(test_logging_running_pushes_current_sample_contents);
    RUN_TEST(test_logging_running_to_stopping_starts_tail_timer);
    RUN_TEST(test_logging_stopping_flushes_then_closes_after_tail);
    RUN_TEST(test_logging_full_cycle_can_restart);

    RUN_TEST(test_no_profile_means_no_limits_exceeded);
    RUN_TEST(test_force_limit_boundary_and_exceed);
    RUN_TEST(test_displacement_limit_uses_mm_to_um_conversion);
    RUN_TEST(test_velocity_exceeded_always_false_even_with_profile);
    RUN_TEST(test_force_flag_clears_when_back_under_limit);

    return UNITY_END();
}
