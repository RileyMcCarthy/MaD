/*
 * Unit tests for app_testManagement — the test-session state machine
 * (IDLE → STARTING → RUNNING → ENDING → IDLE) and its isBusy contract.
 *
 * Focus: the race fixes from commit c081e6c8 ("fix isBusy race and test_run
 * self-cancel"), which had no direct coverage:
 *   - isBusy is true while a start/end request is *pending*, not only while the
 *     state is non-IDLE — so a second start (or a manual move) racing the first
 *     is rejected (test_doubleStartRejected, test_manualMoveGatedWhileBusy).
 *   - a start request is NOT dropped if motionEnabled lags one cycle — the test
 *     waits and starts once motion is enabled, rather than self-cancelling
 *     (test_startNotDroppedWhenMotionLags).
 *
 * The module's collaborators (app_motion / app_control / app_monitor /
 * app_notification / IO_SDCard) are replaced by controllable test doubles
 * defined below; only app_testManagement.c itself is under test. The SD-card
 * doubles model open/close state so the STARTING handshake advances
 * deterministically. HAL_lock is the native mock from mock_propeller2.c.
 */

#include <unity.h>
#include <string.h>

#include "app_testManagement.h"
#include "app_motion.h"
#include "app_control.h"
#include "app_monitor.h"
#include "app_notification.h"
#include "IO_SDCard.h"
#include "HAL_lock.h"

/* ====================================================================== *
 * Test doubles — controllable stand-ins for app_testManagement's deps.   *
 * ====================================================================== */

static bool d_motionEnabled;
static bool d_sdClosed;          /* models the gcode SD channel open/close state */
static bool d_sdLastOpenFailed;
static bool d_sdReadDone;
static bool d_forceExceeded;
static bool d_dispExceeded;
static bool d_motionIdle;
static bool d_addMoveReturn;     /* what app_motion_addMove reports (queue accept) */

static uint32_t d_addMoveCount;
static uint32_t d_abortCount;
static uint32_t d_sdOpenCount;
static uint32_t d_sdCloseCount;
static uint32_t d_clearOpenFailedCount;
static uint32_t d_notifyCount;
static app_notification_type_E d_lastNotifyType;

/* popMultiple script: the next refill yields d_popCount moves from d_popBuf. */
static app_motion_move_t d_popBuf[8];
static uint32_t d_popCount;

static void doubles_reset(void)
{
    memset(d_popBuf, 0, sizeof(d_popBuf));
    d_popCount = 0U;

    d_motionEnabled = true;
    d_sdClosed = true;           /* channel idle/closed at rest */
    d_sdLastOpenFailed = false;
    d_sdReadDone = false;
    d_forceExceeded = false;
    d_dispExceeded = false;
    d_motionIdle = false;
    d_addMoveReturn = true;

    d_addMoveCount = 0U;
    d_abortCount = 0U;
    d_sdOpenCount = 0U;
    d_sdCloseCount = 0U;
    d_clearOpenFailedCount = 0U;
    d_notifyCount = 0U;
    d_lastNotifyType = APP_NOTIFICATION_TYPE_COUNT;
}

/* --- app_control --- */
bool app_control_motionEnabled(void) { return d_motionEnabled; }

/* --- app_monitor --- */
bool app_monitor_isForceExceeded(void) { return d_forceExceeded; }
bool app_monitor_isDisplacementExceeded(void) { return d_dispExceeded; }

/* --- app_motion --- */
bool app_motion_addMove(const app_motion_move_t *move)
{
    (void)move;
    d_addMoveCount++;
    return d_addMoveReturn;
}
void app_motion_abortAndClear(void) { d_abortCount++; }
bool app_motion_isIdle(void) { return d_motionIdle; }

/* --- app_notification --- */
void app_notification_send(app_notification_type_E type, const char *format, ...)
{
    (void)format;
    d_notifyCount++;
    d_lastNotifyType = type;
}

/* --- IO_SDCard (models channel open/close so STARTING advances) --- */
bool IO_SDCard_isClosed(IO_SDCard_channel_E channel) { (void)channel; return d_sdClosed; }
bool IO_SDCard_lastOpenFailed(IO_SDCard_channel_E channel) { (void)channel; return d_sdLastOpenFailed; }
void IO_SDCard_clearLastOpenFailed(IO_SDCard_channel_E channel)
{
    (void)channel;
    d_clearOpenFailedCount++;
    d_sdLastOpenFailed = false;
}
bool IO_SDCard_isReadDone(IO_SDCard_channel_E channel) { (void)channel; return d_sdReadDone; }
bool IO_SDCard_close(IO_SDCard_channel_E channel)
{
    (void)channel;
    d_sdCloseCount++;
    d_sdClosed = true;
    return true;
}
bool IO_SDCard_open(IO_SDCard_channel_E channel, const char *fileName, IO_SDCard_mode_E mode)
{
    (void)channel;
    (void)fileName;
    (void)mode;
    d_sdOpenCount++;
    d_sdClosed = false;
    return true;
}
uint32_t IO_SDCard_popMultiple(IO_SDCard_channel_E channel, void *buffer, uint32_t maxCount)
{
    (void)channel;
    uint32_t n = (d_popCount < maxCount) ? d_popCount : maxCount;
    memcpy(buffer, d_popBuf, (size_t)n * sizeof(app_motion_move_t));
    d_popCount = 0U; /* drained */
    return n;
}

/* ====================================================================== *
 * Helpers                                                                *
 * ====================================================================== */

static void tm_init(void)
{
    doubles_reset();
    app_testManagement_init(HAL_lock_create());
}

/* IDLE → STARTING → RUNNING, given motion enabled and the channel closed.
 * Cycle 1: processRequests starts the test (closes WRITE), STARTING opens READ.
 * Cycle 2: STARTING sees the channel open → RUNNING. */
static void tm_driveToRunning(void)
{
    TEST_ASSERT_TRUE(app_testManagement_triggerTestStart("gc0001"));
    app_testManagement_run();
    app_testManagement_run();
    TEST_ASSERT_TRUE(app_testManagement_isRunning());
}

/* ====================================================================== *
 * Race-fix regressions (the reason this file exists)                     *
 * ====================================================================== */

void test_app_testManagement_doubleStartRejected(void)
{
    tm_init();

    /* First start is accepted and immediately marks the module busy — even
     * though the state is still IDLE, the pending request counts as busy. */
    TEST_ASSERT_TRUE(app_testManagement_triggerTestStart("first1"));
    TEST_ASSERT_TRUE(app_testManagement_isBusy());

    /* A second start racing the first (before any run cycle) is rejected. */
    TEST_ASSERT_FALSE(app_testManagement_triggerTestStart("secnd1"));

    /* Once running, a start is still rejected (state non-IDLE). */
    app_testManagement_run();
    app_testManagement_run();
    TEST_ASSERT_TRUE(app_testManagement_isRunning());
    TEST_ASSERT_FALSE(app_testManagement_triggerTestStart("third1"));
}

void test_app_testManagement_startNotDroppedWhenMotionLags(void)
{
    tm_init();

    TEST_ASSERT_TRUE(app_testManagement_triggerTestStart("lag001"));

    /* Lag cycle: motionEnabled reads false the cycle the request is processed.
     * The request must be preserved (NOT consumed/dropped) — no self-cancel. */
    d_motionEnabled = false;
    app_testManagement_run();
    TEST_ASSERT_TRUE(app_testManagement_isBusy());      /* still pending */
    TEST_ASSERT_FALSE(app_testManagement_isRunning());
    TEST_ASSERT_EQUAL_UINT32(0U, d_sdCloseCount);        /* start not consumed */

    /* Motion now enabled: the preserved request starts the test. */
    d_motionEnabled = true;
    app_testManagement_run();
    TEST_ASSERT_EQUAL_UINT32(1U, d_sdCloseCount);        /* start consumed → STARTING */
    TEST_ASSERT_TRUE(app_testManagement_isBusy());
}

void test_app_testManagement_manualMoveGatedWhileBusy(void)
{
    tm_init();

    const app_motion_move_t move = { .g = (uint8_t)G0_RAPID_MOVE, .x = 100, .f = 50, .p = 0 };

    /* Idle: manual move accepted. */
    TEST_ASSERT_TRUE(app_testManagement_addManualMove(&move));

    /* A pending start makes the module busy → manual moves are rejected. */
    TEST_ASSERT_TRUE(app_testManagement_triggerTestStart("busy01"));
    TEST_ASSERT_FALSE(app_testManagement_addManualMove(&move));
}

void test_app_testManagement_manualMoveSlotsBounded(void)
{
    tm_init();

    const app_motion_move_t move = { .g = (uint8_t)G0_RAPID_MOVE, .x = 1, .f = 1, .p = 0 };

    /* APP_TESTMANAGEMENT_MANUAL_MOVE_SLOTS == 4: the 5th staged move (before any
     * run cycle drains them) is rejected. */
    TEST_ASSERT_TRUE(app_testManagement_addManualMove(&move));
    TEST_ASSERT_TRUE(app_testManagement_addManualMove(&move));
    TEST_ASSERT_TRUE(app_testManagement_addManualMove(&move));
    TEST_ASSERT_TRUE(app_testManagement_addManualMove(&move));
    TEST_ASSERT_FALSE(app_testManagement_addManualMove(&move));

    /* The run cycle drains the four staged moves into the motion queue. */
    app_testManagement_run();
    TEST_ASSERT_EQUAL_UINT32(4U, d_addMoveCount);
}

/* ====================================================================== *
 * State-machine lifecycle coverage                                       *
 * ====================================================================== */

void test_app_testManagement_happyPathLifecycle(void)
{
    tm_init();

    /* Idle initially. */
    TEST_ASSERT_FALSE(app_testManagement_isBusy());
    TEST_ASSERT_FALSE(app_testManagement_isRunning());

    tm_driveToRunning();
    TEST_ASSERT_TRUE(app_testManagement_isBusy());

    /* Reader reports EOF with nothing left to pop → all moves fed. */
    d_sdReadDone = true;
    d_popCount = 0U;
    app_testManagement_run();
    TEST_ASSERT_TRUE(app_testManagement_isRunning()); /* still draining motion */

    /* Motion drains → COMPLETE: abort/clear, "Test Complete!" INFO, ENDING. */
    d_motionIdle = true;
    app_testManagement_run();
    TEST_ASSERT_FALSE(app_testManagement_isRunning());
    TEST_ASSERT_EQUAL_UINT32(1U, d_abortCount);
    TEST_ASSERT_EQUAL_UINT32(1U, d_notifyCount);
    TEST_ASSERT_EQUAL_INT(APP_NOTIFICATION_TYPE_INFO, d_lastNotifyType);

    /* ENDING → IDLE once the channel is closed. */
    app_testManagement_run();
    TEST_ASSERT_FALSE(app_testManagement_isBusy());
}

void test_app_testManagement_g122TerminatesFeed(void)
{
    tm_init();
    tm_driveToRunning();

    /* Stream a real move followed by the G122 terminator. */
    d_popBuf[0] = (app_motion_move_t){ .g = (uint8_t)G1_LINEAR_MOVE, .x = 500, .f = 100, .p = 0 };
    d_popBuf[1] = (app_motion_move_t){ .g = (uint8_t)G122_STOP, .x = 0, .f = 0, .p = 0 };
    d_popCount = 2U;

    app_testManagement_run(); /* refill staged buffer */
    TEST_ASSERT_TRUE(app_testManagement_isRunning());

    app_testManagement_run(); /* feed G1, then hit G122 → all moves fed */
    TEST_ASSERT_EQUAL_UINT32(1U, d_addMoveCount); /* only the G1 was queued */
    TEST_ASSERT_TRUE(app_testManagement_isRunning());

    d_motionIdle = true;
    app_testManagement_run(); /* motion idle → COMPLETE */
    TEST_ASSERT_FALSE(app_testManagement_isRunning());
    TEST_ASSERT_EQUAL_INT(APP_NOTIFICATION_TYPE_INFO, d_lastNotifyType);
}

void test_app_testManagement_userEndStopsRun(void)
{
    tm_init();
    tm_driveToRunning();

    /* User stop: aborts the queue, no user-facing notification. */
    TEST_ASSERT_TRUE(app_testManagement_triggerTestEnd());
    app_testManagement_run();
    TEST_ASSERT_FALSE(app_testManagement_isRunning());
    TEST_ASSERT_EQUAL_UINT32(1U, d_abortCount);
    TEST_ASSERT_EQUAL_UINT32(0U, d_notifyCount);

    app_testManagement_run(); /* ENDING → IDLE */
    TEST_ASSERT_FALSE(app_testManagement_isBusy());
}

void test_app_testManagement_motionDisabledAbortsRun(void)
{
    tm_init();
    tm_driveToRunning();

    /* Disabling motion mid-run aborts with a WARNING. */
    d_motionEnabled = false;
    app_testManagement_run();
    TEST_ASSERT_FALSE(app_testManagement_isRunning());
    TEST_ASSERT_EQUAL_UINT32(1U, d_abortCount);
    TEST_ASSERT_EQUAL_UINT32(1U, d_notifyCount);
    TEST_ASSERT_EQUAL_INT(APP_NOTIFICATION_TYPE_WARNING, d_lastNotifyType);
}

void test_app_testManagement_sampleLimitAbortsRun(void)
{
    tm_init();
    tm_driveToRunning();

    /* Sample force/displacement limit trips → stop with a WARNING. */
    d_forceExceeded = true;
    app_testManagement_run();
    TEST_ASSERT_FALSE(app_testManagement_isRunning());
    TEST_ASSERT_EQUAL_UINT32(1U, d_abortCount);
    TEST_ASSERT_EQUAL_INT(APP_NOTIFICATION_TYPE_WARNING, d_lastNotifyType);
}

void test_app_testManagement_openFailureEndsStart(void)
{
    tm_init();

    TEST_ASSERT_TRUE(app_testManagement_triggerTestStart("nofile"));
    app_testManagement_run(); /* IDLE → STARTING, opens READ */
    TEST_ASSERT_FALSE(app_testManagement_isRunning());

    /* The READ open is reported as failed → ERROR notification, end the start. */
    d_sdLastOpenFailed = true;
    app_testManagement_run();
    TEST_ASSERT_EQUAL_UINT32(1U, d_notifyCount);
    TEST_ASSERT_EQUAL_INT(APP_NOTIFICATION_TYPE_ERROR, d_lastNotifyType);
    TEST_ASSERT_EQUAL_UINT32(1U, d_abortCount);
    TEST_ASSERT_FALSE(app_testManagement_isRunning());

    app_testManagement_run(); /* ENDING → IDLE */
    TEST_ASSERT_FALSE(app_testManagement_isBusy());
}
