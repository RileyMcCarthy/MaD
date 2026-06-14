/*
 * Unit tests for dev_stepper — the per-channel stepper state machine
 * (DISABLED -> STOPPED -> MOVING) layered over the HAL pulse-train + GPIO
 * direction pin.
 *
 * dev_stepper.c is #included directly (it is NOT in build_src_filter), so the
 * suite owns its module instance and the file-static dev_stepper_data. The four
 * HAL collaborators the module touches — HAL_pulseOut_start / _stop / _run and
 * HAL_GPIO_setActive — are replaced by controllable test doubles defined below
 * (call captures + a scriptable HAL_pulseOut_run). HAL_lock is the native mock
 * from test/mock_propeller2.c; the SM lock is created in setUp, and because the
 * module emits DEBUG_INFO on every state transition, _stdio_debug_lock is given
 * a real lock id too.
 *
 * Input cadence: dev_stepper_move()/enable() write a *staged* input that
 * dev_stepper_run() snapshots (processInputs) at the top of each cycle. Tests
 * therefore stage the input, then drive run() the right number of cycles to
 * observe the snapshot -> desiredState -> entry/run-action effects. requests
 * (stop / setPosition) are applied at the start of run() as well.
 *
 * Not covered (and why): the LOCK_REQ_BLOCK spin path is unreachable under the
 * mock (a held lock makes HAL_lock_try TEST_FAIL, so it degrades to a single
 * acquire) — no lock-contention tests. dev_stepper_init() only stores the lock
 * id and has no other observable behaviour.
 */

#include <unity.h>
#include <string.h>
#include <stdint.h>

#include "HAL_lock.h"

/* The module declares this as an extern it indexes by channel; provide it. */
#include "dev_stepper.h"
dev_stepper_channelConfig_S dev_stepper_channelConfig[DEV_STEPPER_CHANNEL_COUNT] = {
    [DEV_STEPPER_CHANNEL_MAIN] = {
        .pinEnable = 1U,
        .pinStep = 2U,
        .gpioDirection = HAL_GPIO_SERVO_DIR,
        .pulseChannel = HAL_PULSE_OUT_CHANNEL_SERVO,
    },
};

/* ====================================================================== *
 * Test doubles — controllable stand-ins for dev_stepper's HAL deps.      *
 * ====================================================================== */

/* HAL_pulseOut_run script + capture. */
static bool d_run_complete;        /* what HAL_pulseOut_run returns (move complete) */
static uint32_t d_run_delta;       /* deltaSteps it writes back */
static uint32_t d_runCount;

/* HAL_pulseOut_start capture. */
static uint32_t d_startCount;
static HAL_pulseOut_channel_E d_startChannel;
static uint32_t d_startPulses;
static uint32_t d_startFrequency;

/* HAL_pulseOut_stop capture. */
static uint32_t d_stopCount;
static HAL_pulseOut_channel_E d_stopChannel;

/* HAL_GPIO_setActive capture. */
static uint32_t d_gpioCount;
static HAL_GPIO_channel_E d_gpioChannel;
static bool d_gpioActive;

static void doubles_reset(void)
{
    d_run_complete = false;
    d_run_delta = 0U;
    d_runCount = 0U;

    d_startCount = 0U;
    d_startChannel = HAL_PULSE_OUT_CHANNEL_COUNT;
    d_startPulses = 0U;
    d_startFrequency = 0U;

    d_stopCount = 0U;
    d_stopChannel = HAL_PULSE_OUT_CHANNEL_COUNT;

    d_gpioCount = 0U;
    d_gpioChannel = HAL_GPIO_COUNT;
    d_gpioActive = false;
}

/* --- HAL_pulseOut --- */
void HAL_pulseOut_start(HAL_pulseOut_channel_E channel, uint32_t pulses, uint32_t frequency)
{
    d_startCount++;
    d_startChannel = channel;
    d_startPulses = pulses;
    d_startFrequency = frequency;
}

bool HAL_pulseOut_run(HAL_pulseOut_channel_E channel, uint32_t *pulses)
{
    (void)channel;
    d_runCount++;
    if (pulses != NULL)
    {
        *pulses = d_run_delta;
    }
    return d_run_complete;
}

void HAL_pulseOut_stop(HAL_pulseOut_channel_E channel)
{
    d_stopCount++;
    d_stopChannel = channel;
}

/* --- HAL_GPIO --- */
void HAL_GPIO_setActive(HAL_GPIO_channel_E channel, bool active)
{
    d_gpioCount++;
    d_gpioChannel = channel;
    d_gpioActive = active;
}

/* Now pull in the module under test (after the doubles + the config it externs). */
#include "../../src/DEV/dev_stepper.c"

extern void HAL_lock_mock_reset(void);
extern int _stdio_debug_lock; /* defined in shared test/mock_propeller2.c */

#define CH DEV_STEPPER_CHANNEL_MAIN

void setUp(void)
{
    HAL_lock_mock_reset();
    doubles_reset();

    /* DEBUG_INFO fires on every transition -> needs a real lock id. */
    _stdio_debug_lock = HAL_lock_create();

    /* Fresh module state: the file-static dev_stepper_data persists across
     * tests in one binary, so wipe it before re-init. */
    memset(&dev_stepper_data, 0, sizeof(dev_stepper_data));
    dev_stepper_init(HAL_lock_create());
}

void tearDown(void) {}

/* Drive run() until the channel reaches MOVING (enable + a target distinct from
 * current). Returns having issued exactly the cycles needed. */
static void drive_to_moving(int32_t target, uint32_t sps)
{
    dev_stepper_enable(CH, true);
    TEST_ASSERT_TRUE(dev_stepper_move(CH, target, sps));
    /* Cycle 1: DISABLED -> STOPPED (snapshots enabled=true). */
    dev_stepper_run();
    TEST_ASSERT_EQUAL_INT(DEV_STEPPER_STATE_STOPPED, dev_stepper_getState(CH));
    /* Cycle 2: STOPPED -> MOVING (target != current). */
    dev_stepper_run();
    TEST_ASSERT_EQUAL_INT(DEV_STEPPER_STATE_MOVING, dev_stepper_getState(CH));
}

/* ====================================================================== *
 * Initial / getter contract                                             *
 * ====================================================================== */

void test_dev_stepper_initialStateDisabled(void)
{
    TEST_ASSERT_EQUAL_INT(DEV_STEPPER_STATE_DISABLED, dev_stepper_getState(CH));
    TEST_ASSERT_EQUAL_INT32(0, dev_stepper_getSteps(CH));
    TEST_ASSERT_EQUAL_INT32(0, dev_stepper_getTarget(CH));
    /* target(0) == current(0) -> atTarget. */
    TEST_ASSERT_TRUE(dev_stepper_atTarget(CH));
}

/* ====================================================================== *
 * move() argument validation + staging                                  *
 * ====================================================================== */

void test_dev_stepper_moveRejectsZeroSpeed(void)
{
    /* Zero steps-per-second is invalid and must not stage anything. */
    TEST_ASSERT_FALSE(dev_stepper_move(CH, 1000, 0U));
    TEST_ASSERT_EQUAL_INT32(0, dev_stepper_getTarget(CH));
}

void test_dev_stepper_moveStagesTarget(void)
{
    TEST_ASSERT_TRUE(dev_stepper_move(CH, 1234, 800U));
    /* getTarget reads the staged target directly (no run() needed). */
    TEST_ASSERT_EQUAL_INT32(1234, dev_stepper_getTarget(CH));
    /* Not yet at target. */
    TEST_ASSERT_FALSE(dev_stepper_atTarget(CH));
}

/* ====================================================================== *
 * enable gating: DISABLED <-> STOPPED                                   *
 * ====================================================================== */

void test_dev_stepper_enableEntersStopped(void)
{
    dev_stepper_enable(CH, true);
    /* Input is staged; not snapshotted until run(). */
    TEST_ASSERT_EQUAL_INT(DEV_STEPPER_STATE_DISABLED, dev_stepper_getState(CH));

    dev_stepper_run();
    TEST_ASSERT_EQUAL_INT(DEV_STEPPER_STATE_STOPPED, dev_stepper_getState(CH));
    /* No motion started simply by enabling. */
    TEST_ASSERT_EQUAL_UINT32(0U, d_startCount);
}

void test_dev_stepper_disableFromStoppedReturnsToDisabled(void)
{
    dev_stepper_enable(CH, true);
    dev_stepper_run();
    TEST_ASSERT_EQUAL_INT(DEV_STEPPER_STATE_STOPPED, dev_stepper_getState(CH));

    dev_stepper_enable(CH, false);
    dev_stepper_run();
    TEST_ASSERT_EQUAL_INT(DEV_STEPPER_STATE_DISABLED, dev_stepper_getState(CH));
}

void test_dev_stepper_stoppedAtTargetStaysStopped(void)
{
    /* Enabled, but staged target (0) equals current (0): no move requested. */
    dev_stepper_enable(CH, true);
    dev_stepper_run(); /* -> STOPPED */
    dev_stepper_run(); /* target==current -> stays STOPPED */
    TEST_ASSERT_EQUAL_INT(DEV_STEPPER_STATE_STOPPED, dev_stepper_getState(CH));
    TEST_ASSERT_EQUAL_UINT32(0U, d_startCount);
}

/* ====================================================================== *
 * MOVING entry: direction + pulse-train kickoff                         *
 * ====================================================================== */

void test_dev_stepper_movePositiveIsCW(void)
{
    drive_to_moving(1000, 500U);

    /* Entry action fired exactly once: GPIO dir + pulseOut_start. */
    TEST_ASSERT_EQUAL_UINT32(1U, d_gpioCount);
    TEST_ASSERT_EQUAL_INT(HAL_GPIO_SERVO_DIR, d_gpioChannel);
    /* CW -> direction pin set inactive (false in the module). */
    TEST_ASSERT_FALSE(d_gpioActive);

    TEST_ASSERT_EQUAL_UINT32(1U, d_startCount);
    TEST_ASSERT_EQUAL_INT(HAL_PULSE_OUT_CHANNEL_SERVO, d_startChannel);
    /* |target - current| = 1000 pulses, at the requested 500 sps. */
    TEST_ASSERT_EQUAL_UINT32(1000U, d_startPulses);
    TEST_ASSERT_EQUAL_UINT32(500U, d_startFrequency);
}

void test_dev_stepper_moveNegativeIsCCW(void)
{
    /* Start at a known non-zero position so a negative target is CCW. */
    dev_stepper_setPosition(CH, 0);
    drive_to_moving(-750, 300U);

    TEST_ASSERT_EQUAL_UINT32(1U, d_gpioCount);
    /* CCW -> direction pin set active (true). */
    TEST_ASSERT_TRUE(d_gpioActive);

    /* |0 - (-750)| = 750 pulses. */
    TEST_ASSERT_EQUAL_UINT32(750U, d_startPulses);
    TEST_ASSERT_EQUAL_UINT32(300U, d_startFrequency);
}

void test_dev_stepper_moveFromNonZeroStart(void)
{
    /* setPosition request is applied by processRequests at the next run(). */
    dev_stepper_setPosition(CH, 200);
    dev_stepper_enable(CH, true);
    dev_stepper_run(); /* applies setPosition(200), DISABLED->STOPPED */
    TEST_ASSERT_EQUAL_INT32(200, dev_stepper_getSteps(CH));

    TEST_ASSERT_TRUE(dev_stepper_move(CH, 500, 400U));
    dev_stepper_run(); /* STOPPED -> MOVING */
    TEST_ASSERT_EQUAL_INT(DEV_STEPPER_STATE_MOVING, dev_stepper_getState(CH));

    /* CW (500 > 200), distance = 300 pulses. */
    TEST_ASSERT_FALSE(d_gpioActive);
    TEST_ASSERT_EQUAL_UINT32(300U, d_startPulses);
}

/* ====================================================================== *
 * MOVING run: step accounting from HAL_pulseOut_run deltas              *
 * ====================================================================== */

void test_dev_stepper_movingAccumulatesStepsCW(void)
{
    drive_to_moving(1000, 500U);
    /* The cycle that entered MOVING also ran runAction once with default
     * (complete=false, delta=0) so currentSteps stayed at startSteps(0). */
    TEST_ASSERT_EQUAL_INT32(0, dev_stepper_getSteps(CH));

    /* Pulse train reports 250 pulses emitted so far, not yet complete. */
    d_run_delta = 250U;
    d_run_complete = false;
    dev_stepper_run();
    TEST_ASSERT_EQUAL_INT32(250, dev_stepper_getSteps(CH)); /* start(0) + 250 */
    TEST_ASSERT_EQUAL_INT(DEV_STEPPER_STATE_MOVING, dev_stepper_getState(CH));

    /* More pulses; currentSteps tracks startSteps + delta (absolute, not incremental). */
    d_run_delta = 800U;
    dev_stepper_run();
    TEST_ASSERT_EQUAL_INT32(800, dev_stepper_getSteps(CH));
}

void test_dev_stepper_movingAccumulatesStepsCCW(void)
{
    dev_stepper_setPosition(CH, 0);
    drive_to_moving(-1000, 500U);

    /* CCW: currentSteps = startSteps - delta. */
    d_run_delta = 300U;
    d_run_complete = false;
    dev_stepper_run();
    TEST_ASSERT_EQUAL_INT32(-300, dev_stepper_getSteps(CH));
}

void test_dev_stepper_moveCompletesToStopped(void)
{
    drive_to_moving(1000, 500U);

    /* Pulse train reports completion with the full delta. */
    d_run_delta = 1000U;
    d_run_complete = true;
    dev_stepper_run(); /* runAction sets moveComplete=true and final steps */
    TEST_ASSERT_EQUAL_INT32(1000, dev_stepper_getSteps(CH));
    /* Still MOVING this cycle (desiredState evaluated before runAction). */
    TEST_ASSERT_EQUAL_INT(DEV_STEPPER_STATE_MOVING, dev_stepper_getState(CH));

    /* Next cycle: getDesiredState sees moveComplete -> STOPPED, exit stops train. */
    dev_stepper_run();
    TEST_ASSERT_EQUAL_INT(DEV_STEPPER_STATE_STOPPED, dev_stepper_getState(CH));
    TEST_ASSERT_EQUAL_UINT32(1U, d_stopCount);
    TEST_ASSERT_EQUAL_INT(HAL_PULSE_OUT_CHANNEL_SERVO, d_stopChannel);
    /* Now at target. */
    TEST_ASSERT_TRUE(dev_stepper_atTarget(CH));
}

/* ====================================================================== *
 * Disable / stop during a move -> exit action stops the train          *
 * ====================================================================== */

void test_dev_stepper_disableDuringMoveStopsTrain(void)
{
    drive_to_moving(1000, 500U);
    TEST_ASSERT_EQUAL_UINT32(0U, d_stopCount);

    dev_stepper_enable(CH, false);
    dev_stepper_run(); /* MOVING -> DISABLED, exit stops train */
    TEST_ASSERT_EQUAL_INT(DEV_STEPPER_STATE_DISABLED, dev_stepper_getState(CH));
    TEST_ASSERT_EQUAL_UINT32(1U, d_stopCount);
}

void test_dev_stepper_stopRequestEndsMove(void)
{
    drive_to_moving(1000, 500U);

    /* dev_stepper_stop stages target=current and sets the stop request, which
     * processRequests turns into moveComplete=true at the next run(). */
    dev_stepper_stop(CH);
    dev_stepper_run(); /* request applied; moveComplete -> STOPPED, train stopped */
    TEST_ASSERT_EQUAL_INT(DEV_STEPPER_STATE_STOPPED, dev_stepper_getState(CH));
    TEST_ASSERT_EQUAL_UINT32(1U, d_stopCount);
}

/* ====================================================================== *
 * setPosition / zeroPosition requests                                   *
 * ====================================================================== */

void test_dev_stepper_setPositionAppliedOnRun(void)
{
    dev_stepper_setPosition(CH, 4242);
    /* Request is not applied until the next run() (processRequests). */
    TEST_ASSERT_EQUAL_INT32(0, dev_stepper_getSteps(CH));
    dev_stepper_run();
    TEST_ASSERT_EQUAL_INT32(4242, dev_stepper_getSteps(CH));
}

void test_dev_stepper_zeroPositionResetsSteps(void)
{
    dev_stepper_setPosition(CH, 999);
    dev_stepper_run();
    TEST_ASSERT_EQUAL_INT32(999, dev_stepper_getSteps(CH));

    dev_stepper_zeroPosition(CH);
    dev_stepper_run();
    TEST_ASSERT_EQUAL_INT32(0, dev_stepper_getSteps(CH));
}

/* ====================================================================== *
 * Output staging: isReady                                               *
 * ====================================================================== */

void test_dev_stepper_isReadyStagedByRun(void)
{
    /* Before any run(), the staged output ready flag is its zero-init value. */
    TEST_ASSERT_FALSE(dev_stepper_isReady(CH));

    /* DISABLED runAction sets ready=true, stageOutput publishes it. */
    dev_stepper_run();
    TEST_ASSERT_TRUE(dev_stepper_isReady(CH));
}

/* ====================================================================== *
 * Full round-trip lifecycle                                             *
 * ====================================================================== */

void test_dev_stepper_fullMoveLifecycle(void)
{
    /* Enable, command a move, watch it run to completion and return to STOPPED
     * at the commanded target. */
    dev_stepper_enable(CH, true);
    TEST_ASSERT_TRUE(dev_stepper_move(CH, 600, 1000U));

    dev_stepper_run(); /* -> STOPPED */
    dev_stepper_run(); /* -> MOVING (start train, 600 pulses) */
    TEST_ASSERT_EQUAL_INT(DEV_STEPPER_STATE_MOVING, dev_stepper_getState(CH));
    TEST_ASSERT_EQUAL_UINT32(600U, d_startPulses);

    /* Partial progress. */
    d_run_delta = 300U;
    d_run_complete = false;
    dev_stepper_run();
    TEST_ASSERT_EQUAL_INT32(300, dev_stepper_getSteps(CH));
    TEST_ASSERT_FALSE(dev_stepper_atTarget(CH));

    /* Completion. */
    d_run_delta = 600U;
    d_run_complete = true;
    dev_stepper_run();           /* finishes; still MOVING */
    dev_stepper_run();           /* MOVING -> STOPPED */
    TEST_ASSERT_EQUAL_INT(DEV_STEPPER_STATE_STOPPED, dev_stepper_getState(CH));
    TEST_ASSERT_EQUAL_INT32(600, dev_stepper_getSteps(CH));
    TEST_ASSERT_TRUE(dev_stepper_atTarget(CH));
    TEST_ASSERT_EQUAL_UINT32(1U, d_startCount);
    TEST_ASSERT_EQUAL_UINT32(1U, d_stopCount);
}

int main(void)
{
    UNITY_BEGIN();
    RUN_TEST(test_dev_stepper_initialStateDisabled);
    RUN_TEST(test_dev_stepper_moveRejectsZeroSpeed);
    RUN_TEST(test_dev_stepper_moveStagesTarget);
    RUN_TEST(test_dev_stepper_enableEntersStopped);
    RUN_TEST(test_dev_stepper_disableFromStoppedReturnsToDisabled);
    RUN_TEST(test_dev_stepper_stoppedAtTargetStaysStopped);
    RUN_TEST(test_dev_stepper_movePositiveIsCW);
    RUN_TEST(test_dev_stepper_moveNegativeIsCCW);
    RUN_TEST(test_dev_stepper_moveFromNonZeroStart);
    RUN_TEST(test_dev_stepper_movingAccumulatesStepsCW);
    RUN_TEST(test_dev_stepper_movingAccumulatesStepsCCW);
    RUN_TEST(test_dev_stepper_moveCompletesToStopped);
    RUN_TEST(test_dev_stepper_disableDuringMoveStopsTrain);
    RUN_TEST(test_dev_stepper_stopRequestEndsMove);
    RUN_TEST(test_dev_stepper_setPositionAppliedOnRun);
    RUN_TEST(test_dev_stepper_zeroPositionResetsSteps);
    RUN_TEST(test_dev_stepper_isReadyStagedByRun);
    RUN_TEST(test_dev_stepper_fullMoveLifecycle);
    return UNITY_END();
}
