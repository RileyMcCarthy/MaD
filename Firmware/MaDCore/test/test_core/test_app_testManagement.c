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
 *   - manual moves (jogs) pressed while motion is disabled are rejected at the
 *     gate and any already-staged slots are discarded on the next CONTROL cycle
 *     so re-enabling never replays them (test_manualMoveRejectedWhenMotionDisabled,
 *     test_manualMoveDiscardedWhenMotionDisabled).
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
    VIBES_TEST("test-run.second-start-refused-while-busy",
               "src/APP/app_testManagement.c#app_testManagement_triggerTestStart",
               "a start already accepted, then a second start while the first is still waiting to begin, and another once that test is running");
    VIBES_EXPECT_WHY("busy-once-accepted",
                     "the machine counts itself busy as soon as the first start is accepted",
                     "two tests must never run at once; a start already accepted already counts as a session under way");
    VIBES_EXPECT("later-starts-refused", "both later starts are refused");
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
    VIBES_TEST("test-run.start-waits-for-motion",
               "src/APP/app_testManagement.c#app_testManagement_run",
               "a start accepted while motion is still off for one cycle, then motion coming on");
    VIBES_EXPECT_WHY("start-still-waiting",
                     "the start is still waiting at the end of that cycle",
                     "motion enable is applied one cycle later than the start request, so the start has to wait");
    VIBES_EXPECT("begins-once-motion-on", "the test begins once motion is on");
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
    VIBES_TEST("test-run.jog-refused-while-start-pending",
               "src/APP/app_testManagement.c#app_testManagement_addManualMove",
               "a jog while idle, then a start, then another jog");
    VIBES_EXPECT("idle-jog-accepted", "the first jog is accepted");
    VIBES_EXPECT_WHY("later-jog-refused",
                     "the second jog is refused",
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
    VIBES_TEST("test-run.at-most-four-jogs-waiting",
               "src/APP/app_testManagement.c#app_testManagement_addManualMove",
               "five jogs issued before any has run");
    VIBES_EXPECT("four-accepted", "the first four are accepted");
    VIBES_EXPECT_WHY("fifth-refused",
                     "the fifth is refused",
                     "jogs wait one cycle to run, so only a handful can be waiting");
    VIBES_EXPECT("all-four-queued", "the next cycle queues all four for motion");
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

/* A jog while motion is disabled is rejected immediately (same gate as
 * triggerTestStart). The host sees NACK; nothing is staged for later. */
void test_app_testManagement_manualMoveRejectedWhenMotionDisabled(void)
{
    VIBES_TEST("test-run.jog-refused-while-motion-disabled",
               "src/APP/app_testManagement.c#app_testManagement_addManualMove",
               "a jog while the machine is idle but motion is disabled");
    VIBES_EXPECT_WHY("jog-refused",
                     "the jog is refused",
                     "a jog pressed while motion is off must not sit waiting to fire when the operator re-enables motion");
    tm_init();

    const app_motion_move_t move = { .g = (uint8_t)G0_RAPID_MOVE, .x = 100, .f = 50, .p = 0 };

    d_motionEnabled = false;
    TEST_ASSERT_FALSE(app_testManagement_addManualMove(&move));

    /* Re-enable and run: nothing was staged, so the motion queue stays empty. */
    d_motionEnabled = true;
    d_addMoveCount = 0U;
    app_testManagement_run();
    TEST_ASSERT_EQUAL_UINT32(0U, d_addMoveCount);
}

/* A jog staged while motion was enabled, then motion disabled before the next
 * CONTROL cycle, must be discarded — not drained into app_motion — so enabling
 * later never replays it (issue #2). */
void test_app_testManagement_manualMoveDiscardedWhenMotionDisabled(void)
{
    VIBES_TEST("test-run.staged-jog-dropped-when-motion-disabled",
               "src/APP/app_testManagement.c#app_testManagement_private_processRequests",
               "a jog accepted while motion was on, then motion disabled before the next control cycle, then motion re-enabled");
    VIBES_EXPECT_WHY("jog-not-queued",
                     "the staged jog is never queued for motion",
                     "changing motion status must never cause travel from a leftover jog");
    VIBES_EXPECT("still-empty-after-enable",
                 "re-enabling motion still leaves the motion queue empty");
    tm_init();

    const app_motion_move_t move = { .g = (uint8_t)G0_RAPID_MOVE, .x = 100, .f = 50, .p = 0 };

    /* Stage while enabled (simulates COMMUNICATION cog accepting the jog). */
    d_motionEnabled = true;
    TEST_ASSERT_TRUE(app_testManagement_addManualMove(&move));

    /* Motion drops before processRequests drains the slot. */
    d_motionEnabled = false;
    d_addMoveCount = 0U;
    app_testManagement_run();
    TEST_ASSERT_EQUAL_UINT32(0U, d_addMoveCount);

    /* Re-enable: the discarded slot must not be replayed. */
    d_motionEnabled = true;
    app_testManagement_run();
    TEST_ASSERT_EQUAL_UINT32(0U, d_addMoveCount);
}

/* ====================================================================== *
 * State-machine lifecycle coverage                                       *
 * ====================================================================== */

void test_app_testManagement_happyPathLifecycle(void)
{
    VIBES_TEST("test-run.completes-when-program-and-motion-finish",
               "src/APP/app_testManagement.c#app_testManagement_run",
               "a test started, the program finished, then the gantry idle");
    VIBES_EXPECT_WHY("runs-while-gantry-finishes",
                     "the test keeps running while the gantry finishes",
                     "the gantry has to finish the last move before the test is called complete");
    VIBES_EXPECT("completion-announced", "the machine announces the test complete");
    VIBES_EXPECT("goes-idle", "the machine goes idle");
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
    VIBES_TEST("test-run.g122-ends-the-program",
               "src/APP/app_testManagement.c#app_testManagement_run",
               "a running test whose program has a linear move followed by G122");
    VIBES_EXPECT("only-linear-move-queued", "only the linear move is queued");
    VIBES_EXPECT_WHY("complete-once-gantry-idle",
                     "the test is reported complete once the gantry is idle",
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
    VIBES_TEST("test-run.operator-stop-is-silent",
               "src/APP/app_testManagement.c#app_testManagement_run",
               "a running test, then the operator stopping it");
    VIBES_EXPECT("moves-cleared", "the remaining moves are cleared");
    VIBES_EXPECT("returns-to-idle", "the machine returns to idle");
    VIBES_EXPECT_WHY("no-operator-notice",
                     "no notice is raised for the operator",
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
    VIBES_TEST("test-run.motion-off-aborts-with-warning",
               "src/APP/app_testManagement.c#app_testManagement_run",
               "a running test, then motion turned off");
    VIBES_EXPECT("moves-cleared", "the test stops and the remaining moves are cleared");
    VIBES_EXPECT_WHY("operator-warned",
                     "the operator is warned that the test was aborted",
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
    VIBES_TEST("test-run.sample-limit-aborts-with-warning",
               "src/APP/app_testManagement.c#app_testManagement_run",
               "a running test, then the sample past its force limit");
    VIBES_EXPECT("moves-cleared", "the test stops and the remaining moves are cleared");
    VIBES_EXPECT_WHY("operator-warned",
                     "the operator is warned that the test was stopped",
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
    VIBES_TEST("test-run.missing-program-fails-start",
               "src/APP/app_testManagement.c#app_testManagement_run",
               "a start whose motion program cannot be opened");
    VIBES_EXPECT("error-raised", "the machine raises an error notice");
    VIBES_EXPECT("moves-cleared", "the queued moves are cleared");
    VIBES_EXPECT_WHY("returns-to-idle",
                     "the machine returns to idle",
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
    VIBES_TEST("test-run.start-and-jog-only-while-idle",
               "src/APP/app_testManagement.c#app_testManagement_isBusy",
               "a start and a jog attempted while idle, while a start is waiting to begin, while a test is running, and after every way a test can finish");
    VIBES_EXPECT("refused-while-busy", "both are refused while a start is waiting to begin or a test is running");
    VIBES_EXPECT("accepted-otherwise", "both are accepted in every other phase");
    VIBES_EXPECT("busy-matches-phase", "the machine reports itself busy in exactly those two phases");
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
    VIBES_TEST("test-run.restart-reaches-running-after-every-finish",
               "src/APP/app_testManagement.c#app_testManagement_run",
               "a test finished in turn by an operator stop, a motion-off abort, a sample-limit stop, and a failed open");
    VIBES_EXPECT_WHY("left-idle",
                     "the machine is left idle after each",
                     "a finished session has to fully return to idle, or the next test would never start");
    VIBES_EXPECT("restart-reaches-running", "a fresh start drives it back to a running test");
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
