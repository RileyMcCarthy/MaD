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
#include "vibes_behaviour.h"
#include <string.h>
#include <stddef.h>
#include <stdbool.h>

#include "app_testManagement.h"
#include "app_motion.h"
#include "app_control.h"
#include "app_monitor.h"
#include "app_notification.h"
#include "IO_SDCard.h"
#include "HAL_lock.h"

extern void HAL_lock_mock_reset(void);
extern int _stdio_debug_lock;

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
    /* Matrix tests call tm_init many times per RUN_TEST; reset the mock lock
     * pool so the 8-slot HAL mock never exhausts mid-test. */
    HAL_lock_mock_reset();
    _stdio_debug_lock = HAL_lock_create();
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
    VIBES_BEHAVIOUR_WHY("test-run.second-start-refused-while-busy",
                        "src/APP/app_testManagement.c#app_testManagement_triggerTestStart",
                        "a start already accepted, then a second start before that test has finished",
                        "a second start is refused while the first is still waiting to begin, and refused again once that test is running",
                        "two tests must never run at once; a start already accepted already counts as a session under way");
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
    VIBES_BEHAVIOUR_WHY("test-run.start-waits-for-motion",
                        "src/APP/app_testManagement.c#app_testManagement_run",
                        "a start accepted while motion is still off for one cycle, then motion coming on",
                        "a start accepted while motion is still off stays waiting through that cycle, and the test begins once motion is on",
                        "motion enable is applied one cycle later than the start request, so the start has to wait");
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
    VIBES_BEHAVIOUR_WHY("test-run.jog-refused-while-start-pending",
                        "src/APP/app_testManagement.c#app_testManagement_addManualMove",
                        "a jog while idle, then a start, then another jog",
                        "a jog is accepted while idle, and refused once a test start is waiting to begin",
                        "a jog must not be mixed into a test that is about to run");
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
    VIBES_BEHAVIOUR_WHY("test-run.at-most-four-jogs-waiting",
                        "src/APP/app_testManagement.c#app_testManagement_addManualMove",
                        "five jogs issued before any has run",
                        "four jogs can wait to run; a fifth is refused, and the four waiting jogs run on the next cycle",
                        "jogs wait one cycle to run, so only a handful can be waiting");
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
    VIBES_BEHAVIOUR_WHY("test-run.completes-when-program-and-motion-finish",
                        "src/APP/app_testManagement.c#app_testManagement_run",
                        "a test started, the program finished, then the crosshead idle",
                        "a test runs until the program is finished and the crosshead is idle, then reports that the test is complete and becomes idle",
                        "the crosshead has to finish the last move before the test is called complete");
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
    VIBES_BEHAVIOUR_WHY("test-run.g122-ends-the-program",
                        "src/APP/app_testManagement.c#app_testManagement_run",
                        "a running test whose program has a linear move followed by G122",
                        "G122 marks the end of the program, so only the linear move is run, and once the crosshead is idle the test is reported complete",
                        "G122 is the end-of-program mark the firmware waits on before calling the test complete");
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
    VIBES_BEHAVIOUR_WHY("test-run.operator-stop-is-silent",
                        "src/APP/app_testManagement.c#app_testManagement_run",
                        "a running test, then the operator stopping it",
                        "an operator stop aborts the remaining moves and leaves the machine idle, with no toast",
                        "the operator already knows they stopped the test");
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
    VIBES_BEHAVIOUR_WHY("test-run.motion-off-aborts-with-warning",
                        "src/APP/app_testManagement.c#app_testManagement_run",
                        "a running test, then motion turned off",
                        "motion turning off mid-test aborts the remaining moves and warns that the test was aborted",
                        "the operator needs to know the test stopped because motion was turned off");
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
    VIBES_BEHAVIOUR_WHY("test-run.sample-limit-aborts-with-warning",
                        "src/APP/app_testManagement.c#app_testManagement_run",
                        "a running test, then the sample past its force limit",
                        "the sample going past its own limit mid-test aborts the remaining moves and warns that the test was stopped",
                        "the specimen's configured limit is what stops the test");
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
    VIBES_BEHAVIOUR_WHY("test-run.missing-program-fails-start",
                        "src/APP/app_testManagement.c#app_testManagement_run",
                        "a start whose motion program cannot be opened",
                        "a start whose motion program cannot be opened reports an error, aborts, and leaves the machine idle",
                        "a missing program must not leave the machine looking as if a test is running");
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

/* ====================================================================== *
 * M5 — lifecycle matrix: start / end / manual across session phases      *
 * ====================================================================== */

typedef enum
{
    M5_PHASE_IDLE = 0,
    M5_PHASE_PENDING_START,
    M5_PHASE_RUNNING,
    M5_PHASE_AFTER_USER_END,
    M5_PHASE_AFTER_MOTION_ABORT,
    M5_PHASE_AFTER_SAMPLE_LIMIT,
    M5_PHASE_AFTER_OPEN_FAIL,
} m5_phase_E;

static void m5_enter_phase(m5_phase_E phase)
{
    tm_init();
    switch (phase)
    {
    case M5_PHASE_IDLE:
        break;
    case M5_PHASE_PENDING_START:
        TEST_ASSERT_TRUE(app_testManagement_triggerTestStart("pend01"));
        break;
    case M5_PHASE_RUNNING:
        tm_driveToRunning();
        break;
    case M5_PHASE_AFTER_USER_END:
        tm_driveToRunning();
        TEST_ASSERT_TRUE(app_testManagement_triggerTestEnd());
        app_testManagement_run(); /* RUNNING → ENDING */
        app_testManagement_run(); /* ENDING → IDLE */
        break;
    case M5_PHASE_AFTER_MOTION_ABORT:
        tm_driveToRunning();
        d_motionEnabled = false;
        app_testManagement_run();
        app_testManagement_run(); /* ENDING → IDLE */
        d_motionEnabled = true;
        break;
    case M5_PHASE_AFTER_SAMPLE_LIMIT:
        tm_driveToRunning();
        d_forceExceeded = true;
        app_testManagement_run();
        app_testManagement_run();
        d_forceExceeded = false;
        break;
    case M5_PHASE_AFTER_OPEN_FAIL:
        TEST_ASSERT_TRUE(app_testManagement_triggerTestStart("nofile"));
        app_testManagement_run();
        d_sdLastOpenFailed = true;
        app_testManagement_run();
        app_testManagement_run();
        d_sdLastOpenFailed = false;
        break;
    default:
        break;
    }
}

void test_m5_lifecycle_start_manual_matrix(void)
{
    VIBES_BEHAVIOUR("test-run.start-and-jog-only-while-idle",
                    "src/APP/app_testManagement.c#app_testManagement_isBusy",
                    "idle, a start waiting to begin, a running test, and after every way a test can finish",
                    "a new start and a jog are accepted while idle, including after every way a test can finish, and refused while a start is waiting to begin or a test is running");
    /* Columns: phase → expectStartAccepted, expectManualAccepted, expectBusy */
    typedef struct
    {
        m5_phase_E phase;
        bool startOk;
        bool manualOk;
        bool busy;
    } cell_t;

    static const cell_t cells[] = {
        {M5_PHASE_IDLE, true, true, false},
        {M5_PHASE_PENDING_START, false, false, true},
        {M5_PHASE_RUNNING, false, false, true},
        {M5_PHASE_AFTER_USER_END, true, true, false},
        {M5_PHASE_AFTER_MOTION_ABORT, true, true, false},
        {M5_PHASE_AFTER_SAMPLE_LIMIT, true, true, false},
        {M5_PHASE_AFTER_OPEN_FAIL, true, true, false},
    };

    const app_motion_move_t move = { .g = (uint8_t)G0_RAPID_MOVE, .x = 1, .f = 1, .p = 0 };

    for (size_t i = 0; i < sizeof(cells) / sizeof(cells[0]); i++)
    {
        const cell_t *c = &cells[i];
        m5_enter_phase(c->phase);

        TEST_ASSERT_EQUAL_INT(c->busy ? 1 : 0, app_testManagement_isBusy() ? 1 : 0);

        if (c->manualOk)
        {
            TEST_ASSERT_TRUE(app_testManagement_addManualMove(&move));
        }
        else
        {
            TEST_ASSERT_FALSE(app_testManagement_addManualMove(&move));
        }

        /* Fresh start attempt after the phase is established. */
        const bool started = app_testManagement_triggerTestStart("mtx001");
        if (c->startOk)
        {
            TEST_ASSERT_TRUE(started);
            TEST_ASSERT_TRUE(app_testManagement_isBusy());
        }
        else
        {
            TEST_ASSERT_FALSE(started);
        }
    }
}

/* After any terminal path, a full restart must reach RUNNING. */
void test_m5_restart_reaches_running_after_each_terminal(void)
{
    VIBES_BEHAVIOUR_WHY("test-run.restart-reaches-running-after-every-finish",
                        "src/APP/app_testManagement.c#app_testManagement_run",
                        "after an operator stop, a motion-off abort, a sample-limit stop, and a failed open, in turn",
                        "after every way a test can finish, a new start reaches a running test",
                        "a finished session has to fully return to idle, or the next test would never start");
    static const m5_phase_E terminals[] = {
        M5_PHASE_AFTER_USER_END,
        M5_PHASE_AFTER_MOTION_ABORT,
        M5_PHASE_AFTER_SAMPLE_LIMIT,
        M5_PHASE_AFTER_OPEN_FAIL,
    };
    for (size_t i = 0; i < sizeof(terminals) / sizeof(terminals[0]); i++)
    {
        m5_enter_phase(terminals[i]);
        TEST_ASSERT_FALSE(app_testManagement_isBusy());
        tm_driveToRunning();
        TEST_ASSERT_TRUE(app_testManagement_isRunning());
        TEST_ASSERT_TRUE(app_testManagement_isBusy());
    }
}
