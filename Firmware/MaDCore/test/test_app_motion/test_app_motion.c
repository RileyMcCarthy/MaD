// Unity unit-test suite for src/APP/app_motion.c
//
// app_motion is a pure motion executor: it snapshots all external inputs once
// per app_motion_run() (via processInputs), runs a small state machine
// (DISABLED -> WAITING -> MOVING), pops moves from an internal lib_staticQueue,
// and drives the stepper via the dev_stepper API. It also owns the G28 homing
// sub-state-machine and converts steps<->um for the setpoint/position getters.
//
// INPUT-SNAPSHOT cadence: the module reads ALL inputs once at the top of
// app_motion_run() and the rest of the tick operates on that snapshot. So set
// double values BEFORE the run() that should observe them, and drive run() the
// right number of cycles. In particular, WAITING pops a move + calls
// moveManager_start in the SAME run that transitions to MOVING; the next run
// (state MOVING) calls moveManager_run.
//
// Library/ (lib_staticQueue, lib_timer, lib_utility) is compiled for real and
// used for real. All peer dependencies are local controllable test doubles.
//
// The module under test is pulled in via #include of its .c so we can reach its
// public API; its private state machine is exercised purely through that API.

#include <unity.h>
#include <string.h>
#include <stdint.h>
#include <stdbool.h>

#include "HAL_lock.h"
#include "dev_stepper.h"              // dev_stepper_channel_E, DEV_STEPPER_CHANNEL_MAIN
#include "dev_nvram.h"                // dev_nvram_channel_t, DEV_NVRAM_CHANNEL_MACHINE_PROFILE
#include "dev_nvram_machineProfile.h" // MachineProfile
#include "HAL_GPIO.h"                 // HAL_GPIO_channel_E, HAL_GPIO_ENDSTOP_UPPER
#include "IO_positionFeedback.h"      // IO_positionFeedback_channel_E

#include "app_motion.h"

/**********************************************************************
 * Shared HAL mock (test/mock_propeller2.c)
 **********************************************************************/
extern void HAL_lock_mock_reset(void);
extern uint32_t global_timeus;  // microseconds; HAL_time_getMs() == us/1000
extern int _stdio_debug_lock;   // app_motion.c's DEBUG_* path locks this

/**********************************************************************
 * Test doubles for peer dependencies
 **********************************************************************/

/* --- app_control --- */
static bool d_motionEnabled;
static bool d_speedLimited;

bool app_control_motionEnabled(void) { return d_motionEnabled; }
bool app_control_speedLimited(void) { return d_speedLimited; }

/* --- dev_stepper inputs --- */
static int32_t d_steps;       // dev_stepper_getSteps(MAIN)
static bool d_atTarget;       // dev_stepper_atTarget(MAIN)
static int32_t d_target;      // dev_stepper_getTarget(MAIN)

int32_t dev_stepper_getSteps(dev_stepper_channel_E ch)
{
    TEST_ASSERT_EQUAL_INT(DEV_STEPPER_CHANNEL_MAIN, ch);
    return d_steps;
}
bool dev_stepper_atTarget(dev_stepper_channel_E ch)
{
    TEST_ASSERT_EQUAL_INT(DEV_STEPPER_CHANNEL_MAIN, ch);
    return d_atTarget;
}
int32_t dev_stepper_getTarget(dev_stepper_channel_E ch)
{
    TEST_ASSERT_EQUAL_INT(DEV_STEPPER_CHANNEL_MAIN, ch);
    return d_target;
}

/* --- HAL_GPIO inputs --- */
static bool d_endstopUpperActive; // HAL_GPIO_getActive(ENDSTOP_UPPER)

bool HAL_GPIO_getActive(HAL_GPIO_channel_E channel)
{
    TEST_ASSERT_EQUAL_INT(HAL_GPIO_ENDSTOP_UPPER, channel);
    return d_endstopUpperActive;
}

/* --- dev_stepper outputs (record the last call + counts) --- */
static uint32_t d_moveCount;
static int32_t d_lastMoveTarget;
static uint32_t d_lastMoveStepsPerSecond;
static uint32_t d_stopCount;
static uint32_t d_enableCount;
static bool d_lastEnable;
static uint32_t d_setPositionCount;
static int32_t d_lastSetPosition;

bool dev_stepper_move(dev_stepper_channel_E ch, int32_t targetSteps, uint32_t stepsPerSecond)
{
    TEST_ASSERT_EQUAL_INT(DEV_STEPPER_CHANNEL_MAIN, ch);
    d_moveCount++;
    d_lastMoveTarget = targetSteps;
    d_lastMoveStepsPerSecond = stepsPerSecond;
    return true;
}

/* --- dev_stepper velocity (NCO) mode (record the last call + count) --- */
static uint32_t d_setVelocityCount;
static int32_t d_lastSetVelocity;

void dev_stepper_setVelocity(dev_stepper_channel_E ch, int32_t signedStepsPerSecond)
{
    TEST_ASSERT_EQUAL_INT(DEV_STEPPER_CHANNEL_MAIN, ch);
    d_setVelocityCount++;
    d_lastSetVelocity = signedStepsPerSecond;
}
void dev_stepper_stop(dev_stepper_channel_E ch)
{
    TEST_ASSERT_EQUAL_INT(DEV_STEPPER_CHANNEL_MAIN, ch);
    d_stopCount++;
}
void dev_stepper_enable(dev_stepper_channel_E ch, bool enabled)
{
    TEST_ASSERT_EQUAL_INT(DEV_STEPPER_CHANNEL_MAIN, ch);
    d_enableCount++;
    d_lastEnable = enabled;
}
void dev_stepper_setPosition(dev_stepper_channel_E ch, int32_t positionSteps)
{
    TEST_ASSERT_EQUAL_INT(DEV_STEPPER_CHANNEL_MAIN, ch);
    d_setPositionCount++;
    d_lastSetPosition = positionSteps;
}

/* --- IO_positionFeedback output (record last call) --- */
static uint32_t d_setValueCount;
static int32_t d_lastSetValueUM;

bool IO_positionFeedback_setValue(IO_positionFeedback_channel_E ch, int32_t positionUM)
{
    TEST_ASSERT_EQUAL_INT(IO_POSITION_FEEDBACK_CHANNEL_SERVO_FEEDBACK, ch);
    d_setValueCount++;
    d_lastSetValueUM = positionUM;
    return true;
}

/* --- dev_nvram (feeds the MachineProfile consumed by app_motion_init) --- */
static MachineProfile d_machineProfile;

bool dev_nvram_getChannelData(dev_nvram_channel_t channel, void *data, size_t size)
{
    TEST_ASSERT_EQUAL_INT(DEV_NVRAM_CHANNEL_MACHINE_PROFILE, channel);
    TEST_ASSERT_EQUAL_UINT(sizeof(MachineProfile), size);
    memcpy(data, &d_machineProfile, sizeof(MachineProfile));
    return true;
}

/* --- dev_servo peer mock (app_motion now drives closed-loop motion via this API).
 * No-op stubs so the suite links; motion assertions here still exercise the
 * dev_stepper path (see mocks above). */
#include "dev_servo.h"
void dev_servo_enable(dev_servo_channel_E ch, bool enable) { (void)ch; (void)enable; }
void dev_servo_moveTo(dev_servo_channel_E ch, int32_t targetCounts, int32_t feedrateCountsPerSec) { (void)ch; (void)targetCounts; (void)feedrateCountsPerSec; }
void dev_servo_setVelocity(dev_servo_channel_E ch, int32_t velCountsPerSec) { (void)ch; (void)velCountsPerSec; }
void dev_servo_stop(dev_servo_channel_E ch) { (void)ch; }
void dev_servo_setPosition(dev_servo_channel_E ch, int32_t counts) { (void)ch; (void)counts; }
int32_t dev_servo_getPosition(dev_servo_channel_E ch) { (void)ch; return 0; }
int32_t dev_servo_getTarget(dev_servo_channel_E ch) { (void)ch; return 0; }
bool dev_servo_atTarget(dev_servo_channel_E ch) { (void)ch; return false; }

/**********************************************************************
 * Module under test
 **********************************************************************/
#include "../../src/APP/app_motion.c"

/**********************************************************************
 * Fixture helpers
 **********************************************************************/

/* Reset all doubles to a benign baseline. */
static void doubles_reset(void)
{
    d_motionEnabled = true;
    d_speedLimited = false;
    d_steps = 0;
    d_atTarget = false;
    d_target = 0;
    d_endstopUpperActive = false;

    d_moveCount = 0U;
    d_lastMoveTarget = 0;
    d_lastMoveStepsPerSecond = 0U;
    d_setVelocityCount = 0U;
    d_lastSetVelocity = 0;
    d_stopCount = 0U;
    d_enableCount = 0U;
    d_lastEnable = false;
    d_setPositionCount = 0U;
    d_lastSetPosition = 0;

    d_setValueCount = 0U;
    d_lastSetValueUM = 0;

    /* A representative, easy-to-reason-about machine profile.
     * 100 steps/mm keeps step<->um math exact for round numbers. */
    memset(&d_machineProfile, 0, sizeof(d_machineProfile));
    d_machineProfile.servoStepsPerMM = 100;
    d_machineProfile.maxPosition = 200;     // mm
    d_machineProfile.homingVelocity = 5;    // mm/s
    d_machineProfile.homingOffset = 10;     // mm
    d_machineProfile.jawOffset = 3;         // mm
}

/* Full init with the current doubles + a fresh lock id.
 *
 * app_motion_data is a file-static that app_motion_init() only partially
 * initialises (it never resets .state / .currentMove / timers). On real
 * hardware that is fine because it starts zeroed at boot; in a single test
 * binary the struct persists across tests, so we zero it here to reproduce the
 * fresh-boot state (state == APP_MOTION_DISABLED == 0, empty queue). */
static void motion_init(void)
{
    memset(&app_motion_data, 0, sizeof(app_motion_data));
    app_motion_init(HAL_lock_create());
}

/* Drive the module from a freshly-initialised state (DISABLED) into WAITING:
 *   run 1: motionEnabled -> DISABLED handler enables the stepper -> WAITING. */
static void motion_driveToWaiting(void)
{
    d_motionEnabled = true;
    app_motion_run();
    TEST_ASSERT_TRUE(app_motion_isIdle()); /* WAITING + empty queue */
}

static app_motion_move_t make_move(uint8_t g, int32_t x, int32_t f, uint32_t p)
{
    app_motion_move_t m;
    m.g = g;
    m.x = x;
    m.f = f;
    m.p = p;
    return m;
}

/**********************************************************************
 * setUp / tearDown
 **********************************************************************/
void setUp(void)
{
    HAL_lock_mock_reset();
    _stdio_debug_lock = HAL_lock_create(); /* module emits DEBUG_* */
    global_timeus = 0U;
    doubles_reset();
    motion_init();
}

void tearDown(void) {}

/**********************************************************************
 * Tests: state-machine transitions
 **********************************************************************/

/* After init the module is DISABLED: the first enabled run enables the stepper
 * exactly once and lands in WAITING (idle). */
void test_init_then_enabled_run_enables_stepper_and_waits(void)
{
    /* Not idle before the first run: state is DISABLED, not WAITING. */
    TEST_ASSERT_FALSE(app_motion_isIdle());

    d_motionEnabled = true;
    app_motion_run();

    TEST_ASSERT_EQUAL_UINT32(1U, d_enableCount);
    TEST_ASSERT_TRUE(d_lastEnable);
    TEST_ASSERT_TRUE(app_motion_isIdle());
}

/* Disabling motion from any state forces DISABLED: it stops the stepper,
 * disables it, and empties the queue (so a queued move is dropped). */
void test_disable_stops_disables_and_clears_queue(void)
{
    motion_driveToWaiting();

    /* Queue a move that will be discarded by the disable path. */
    app_motion_move_t mv = make_move((uint8_t)G1_LINEAR_MOVE, 1000, 100, 0);
    TEST_ASSERT_TRUE(app_motion_addMove(&mv));
    TEST_ASSERT_FALSE(app_motion_isIdle()); /* queue non-empty */

    d_motionEnabled = false;
    app_motion_run();

    TEST_ASSERT_TRUE(d_stopCount >= 1U);
    TEST_ASSERT_TRUE(d_enableCount >= 1U);
    TEST_ASSERT_FALSE(d_lastEnable);             /* last enable call disabled */

    /* Re-enable: queue was emptied, so we go straight back to idle WAITING. */
    d_motionEnabled = true;
    app_motion_run();
    TEST_ASSERT_TRUE(app_motion_isIdle());
}

/* WAITING with a queued G0 pops it and issues the move in the SAME run that
 * transitions to MOVING; isIdle becomes false. */
void test_waiting_pops_and_starts_move_then_moving(void)
{
    motion_driveToWaiting();
    d_moveCount = 0U; /* ignore any earlier moves */

    /* Absolute mode (init default): target 2.000mm @ 50.000mm/s, 100 steps/mm
     *   steps = 2000um * 100 / 1000 = 200
     *   feed  = 50000(um/s) * 100 / 1000 = 5000 steps/s */
    app_motion_move_t mv = make_move((uint8_t)G0_RAPID_MOVE, 2000, 50000, 0);
    TEST_ASSERT_TRUE(app_motion_addMove(&mv));

    app_motion_run(); /* WAITING -> pop+start -> MOVING */

    TEST_ASSERT_EQUAL_UINT32(1U, d_moveCount);
    TEST_ASSERT_EQUAL_INT32(200, d_lastMoveTarget);
    TEST_ASSERT_EQUAL_UINT32(5000U, d_lastMoveStepsPerSecond);
    TEST_ASSERT_FALSE(app_motion_isIdle()); /* now MOVING */
}

/* A linear move completes (back to WAITING/idle) only once dev_stepper reports
 * atTarget; before that it stays MOVING. */
void test_moving_completes_only_when_at_target(void)
{
    motion_driveToWaiting();

    app_motion_move_t mv = make_move((uint8_t)G1_LINEAR_MOVE, 1000, 100, 0);
    TEST_ASSERT_TRUE(app_motion_addMove(&mv));

    d_atTarget = false;
    app_motion_run(); /* WAITING -> MOVING (start) */
    TEST_ASSERT_FALSE(app_motion_isIdle());

    app_motion_run(); /* MOVING, not at target -> stays MOVING */
    TEST_ASSERT_FALSE(app_motion_isIdle());

    d_atTarget = true;
    app_motion_run(); /* MOVING, at target -> WAITING */
    TEST_ASSERT_TRUE(app_motion_isIdle());
}

/**********************************************************************
 * Tests: move arithmetic (steps/feed scaling, absolute vs incremental)
 **********************************************************************/

/* Zero-feedrate G0/G1 is rejected: no dev_stepper_move is issued, but the
 * move still "completes" via the MOVING path once atTarget is reported. */
void test_zero_feedrate_move_issues_no_stepper_move(void)
{
    motion_driveToWaiting();
    d_moveCount = 0U;

    app_motion_move_t mv = make_move((uint8_t)G1_LINEAR_MOVE, 1000, 0, 0);
    TEST_ASSERT_TRUE(app_motion_addMove(&mv));

    app_motion_run(); /* start: zero feedrate -> no move issued */
    TEST_ASSERT_EQUAL_UINT32(0U, d_moveCount);

    d_atTarget = true;
    app_motion_run(); /* completes */
    TEST_ASSERT_TRUE(app_motion_isIdle());
}

/* In incremental mode (G91) the target is offset by the snapshotted current
 * position. The snapshot is taken at the top of the run that starts the move. */
void test_incremental_mode_adds_current_position(void)
{
    motion_driveToWaiting();

    /* Switch to incremental mode: G91 starts+completes in two runs. */
    app_motion_move_t g91 = make_move((uint8_t)G91_INCREMENTAL, 0, 0, 0);
    TEST_ASSERT_TRUE(app_motion_addMove(&g91));
    app_motion_run(); /* WAITING -> MOVING (G91 start, no-op move) */
    app_motion_run(); /* MOVING -> WAITING (G91 completes immediately) */
    TEST_ASSERT_TRUE(app_motion_isIdle());

    /* Current position snapshot = 1500 steps. Relative target 1.000mm:
     *   relSteps = 1000um*100/1000 = 100; absolute = 100 + 1500 = 1600. */
    d_steps = 1500;
    d_moveCount = 0U;
    app_motion_move_t mv = make_move((uint8_t)G1_LINEAR_MOVE, 1000, 100, 0);
    TEST_ASSERT_TRUE(app_motion_addMove(&mv));

    app_motion_run(); /* snapshots d_steps=1500, then starts move */
    TEST_ASSERT_EQUAL_UINT32(1U, d_moveCount);
    TEST_ASSERT_EQUAL_INT32(1600, d_lastMoveTarget);
}

/* Re-asserting absolute mode (G90) makes the target independent of the current
 * position (defends the absolute branch and G90 toggling incremental back). */
void test_absolute_mode_ignores_current_position(void)
{
    motion_driveToWaiting();

    /* Go incremental, then back to absolute, draining each in two runs. */
    app_motion_move_t g91 = make_move((uint8_t)G91_INCREMENTAL, 0, 0, 0);
    TEST_ASSERT_TRUE(app_motion_addMove(&g91));
    app_motion_run();
    app_motion_run();
    app_motion_move_t g90 = make_move((uint8_t)G90_ABSOLUTE, 0, 0, 0);
    TEST_ASSERT_TRUE(app_motion_addMove(&g90));
    app_motion_run();
    app_motion_run();
    TEST_ASSERT_TRUE(app_motion_isIdle());

    d_steps = 9999; /* would shift target if (wrongly) added */
    d_moveCount = 0U;
    app_motion_move_t mv = make_move((uint8_t)G0_RAPID_MOVE, 1000, 100, 0);
    TEST_ASSERT_TRUE(app_motion_addMove(&mv));

    app_motion_run();
    TEST_ASSERT_EQUAL_UINT32(1U, d_moveCount);
    TEST_ASSERT_EQUAL_INT32(100, d_lastMoveTarget); /* 1000um*100/1000, no offset */
}

/**********************************************************************
 * Tests: dwell (G4) timing
 **********************************************************************/

/* A G4 dwell holds in MOVING until the dwell period elapses (driven by the
 * lib_timer real implementation backed by global_timeus). */
void test_dwell_holds_until_period_elapses(void)
{
    motion_driveToWaiting();

    global_timeus = 0U;
    app_motion_move_t dwell = make_move((uint8_t)G4_DWELL, 0, 0, 50 /*ms*/);
    TEST_ASSERT_TRUE(app_motion_addMove(&dwell));

    app_motion_run(); /* WAITING -> MOVING (starts 50ms dwell timer @ t=0) */
    TEST_ASSERT_FALSE(app_motion_isIdle());

    global_timeus = 40U * 1000U; /* 40ms < 50ms */
    app_motion_run();
    TEST_ASSERT_FALSE(app_motion_isIdle()); /* still dwelling */

    global_timeus = 60U * 1000U; /* 60ms > 50ms -> expired */
    app_motion_run();
    TEST_ASSERT_TRUE(app_motion_isIdle()); /* dwell complete */
}

/**********************************************************************
 * Tests: homing (G28) sub-state-machine
 **********************************************************************/

/* The full successful homing sequence. Cadence note: WAITING pops the G28 and
 * sets homeState=START but enters MOVING in that same run WITHOUT running the
 * homing FSM (moveManager_run only runs once state is already MOVING). So the
 * homing FSM advances one step per subsequent run:
 *   run 1  : WAITING pops G28 -> homeState=START, state=MOVING (FSM idle)
 *   run 2  : START   -> issue approach move, homeState=MOVING(home)
 *   run 3  : MOVING  -> endstop active -> stop + start 1000ms timer -> ENDSTOP
 *   run 4  : ENDSTOP -> timer not expired -> stays
 *   run 5  : ENDSTOP -> timer expired -> set coord, start backoff -> BACKOFF
 *   run 6  : BACKOFF -> atTarget false -> stays
 *   run 7  : BACKOFF -> atTarget true  -> COMPLETE
 *   run 8  : COMPLETE-> moveManager_run reports done -> WAITING/idle. */
void test_homing_full_sequence(void)
{
    motion_driveToWaiting();

    /* Snapshot position 5000 steps at the run that issues the approach move.
     * START move target = pos - stepsPerMM*maxPosition
     *                    = 5000 - 100*200 = -15000 steps
     * velocity = homingVelocity*stepsPerMM = 5*100 = 500 steps/s. */
    d_steps = 5000;
    d_moveCount = 0U;
    global_timeus = 0U;
    app_motion_move_t g28 = make_move((uint8_t)G28_HOME, 0, 0, 0);
    TEST_ASSERT_TRUE(app_motion_addMove(&g28));

    /* Run 1: WAITING pops G28 -> MOVING, homeState=START (FSM not yet run). */
    app_motion_run();
    TEST_ASSERT_EQUAL_UINT32(0U, d_moveCount); /* approach move not issued yet */
    TEST_ASSERT_FALSE(app_motion_isIdle());

    /* Run 2: START -> issue approach move, homeState=MOVING(home). */
    app_motion_run();
    TEST_ASSERT_EQUAL_UINT32(1U, d_moveCount);
    TEST_ASSERT_EQUAL_INT32(-15000, d_lastMoveTarget);
    TEST_ASSERT_EQUAL_UINT32(500U, d_lastMoveStepsPerSecond);

    /* Run 3: endstop active -> stop, start endstop timer, -> ENDSTOP. */
    d_endstopUpperActive = true;
    d_stopCount = 0U;
    app_motion_run();
    TEST_ASSERT_EQUAL_UINT32(1U, d_stopCount);
    TEST_ASSERT_FALSE(app_motion_isIdle());

    /* Run 4: endstop timer (1000ms) not yet expired -> stays ENDSTOP. */
    global_timeus = 500U * 1000U;
    app_motion_run();
    TEST_ASSERT_EQUAL_UINT32(0U, d_setValueCount); /* backoff not started yet */
    TEST_ASSERT_FALSE(app_motion_isIdle());

    /* Run 5: timer expired -> set jaw-offset coordinate + start backoff move.
     *   IO_positionFeedback_setValue: jawOffset(mm) -> um = 3*1000 = 3000
     *   dev_stepper_setPosition: jawOffsetSteps = 100*3 = 300
     *   backoff move target = jawOffsetSteps + homingOffsetSteps
     *                       = 300 + 100*10 = 1300 steps @ 500 steps/s */
    global_timeus = 1500U * 1000U;
    d_moveCount = 0U;
    app_motion_run();
    TEST_ASSERT_EQUAL_UINT32(1U, d_setValueCount);
    TEST_ASSERT_EQUAL_INT32(3000, d_lastSetValueUM);
    TEST_ASSERT_EQUAL_UINT32(1U, d_setPositionCount);
    TEST_ASSERT_EQUAL_INT32(300, d_lastSetPosition);
    TEST_ASSERT_EQUAL_UINT32(1U, d_moveCount);
    TEST_ASSERT_EQUAL_INT32(1300, d_lastMoveTarget);
    TEST_ASSERT_EQUAL_UINT32(500U, d_lastMoveStepsPerSecond);
    TEST_ASSERT_FALSE(app_motion_isIdle());

    /* Run 6: backoff not at target -> stays BACKOFF. */
    d_atTarget = false;
    app_motion_run();
    TEST_ASSERT_FALSE(app_motion_isIdle());

    /* Run 7: backoff at target -> COMPLETE. */
    d_atTarget = true;
    app_motion_run();
    TEST_ASSERT_FALSE(app_motion_isIdle());

    /* Run 8: COMPLETE -> homing done -> WAITING/idle. */
    app_motion_run();
    TEST_ASSERT_TRUE(app_motion_isIdle());
}

/* Homing failure: if atTarget is reached while in MOVING(home) with no endstop,
 * the homing FSM jumps straight to COMPLETE (no encoder set, no backoff move)
 * and the G28 move then completes. */
void test_homing_fails_when_target_reached_without_endstop(void)
{
    motion_driveToWaiting();

    d_steps = 0;
    app_motion_move_t g28 = make_move((uint8_t)G28_HOME, 0, 0, 0);
    TEST_ASSERT_TRUE(app_motion_addMove(&g28));

    app_motion_run(); /* WAITING pops G28 -> MOVING, homeState=START */
    app_motion_run(); /* START -> issue approach move, homeState=MOVING(home) */

    /* No endstop, but target reached -> COMPLETE (failure path). */
    d_endstopUpperActive = false;
    d_atTarget = true;
    d_setValueCount = 0U;
    app_motion_run(); /* MOVING(home) -> COMPLETE */
    TEST_ASSERT_EQUAL_UINT32(0U, d_setValueCount); /* no backoff/coord set */
    TEST_ASSERT_FALSE(app_motion_isIdle());

    app_motion_run(); /* COMPLETE -> done -> WAITING */
    TEST_ASSERT_TRUE(app_motion_isIdle());
}

/**********************************************************************
 * Tests: getters (step<->um conversion) and processOutputs
 **********************************************************************/

/* getSetpoint mirrors processOutputs: setpoint(um) = target(steps)*1000/stepsPerMM.
 * The snapshot of dev_stepper_getTarget is taken at run() time. */
void test_getSetpoint_scales_target_steps_to_um(void)
{
    d_target = 250; /* steps; 250*1000/100 = 2500 um */
    d_motionEnabled = true;
    app_motion_run();
    TEST_ASSERT_EQUAL_INT32(2500, app_motion_getSetpoint());

    d_target = -100; /* -100*1000/100 = -1000 um */
    app_motion_run();
    TEST_ASSERT_EQUAL_INT32(-1000, app_motion_getSetpoint());
}

/* getPosition converts the snapshotted current step count to um. */
void test_getPosition_scales_steps_to_um(void)
{
    d_steps = 175; /* 175*1000/100 = 1750 um */
    d_motionEnabled = true;
    app_motion_run();
    TEST_ASSERT_EQUAL_INT32(1750, app_motion_getPosition());
}

/* With stepsPerMM == 0 the conversions guard against divide-by-zero and yield 0. */
void test_zero_stepsPerMM_yields_zero_setpoint_and_position(void)
{
    /* Re-init with a profile that has 0 steps/mm. */
    d_machineProfile.servoStepsPerMM = 0;
    motion_init();

    d_target = 1234;
    d_steps = 5678;
    d_motionEnabled = true;
    app_motion_run();

    TEST_ASSERT_EQUAL_INT32(0, app_motion_getSetpoint());
    TEST_ASSERT_EQUAL_INT32(0, app_motion_getPosition());
}

/**********************************************************************
 * Tests: queue API (addMove / abortAndClear / isIdle)
 **********************************************************************/

/* The move queue is a circular buffer of MOTION_QUEUE_SIZE slots, so its usable
 * capacity is MOTION_QUEUE_SIZE-1 (one slot is reserved to distinguish full from
 * empty). The push past that capacity is rejected. */
void test_addMove_queue_is_bounded(void)
{
    app_motion_move_t mv = make_move((uint8_t)G1_LINEAR_MOVE, 1, 1, 0);
    for (int i = 0; i < MOTION_QUEUE_SIZE - 1; i++)
    {
        TEST_ASSERT_TRUE(app_motion_addMove(&mv));
    }
    TEST_ASSERT_FALSE(app_motion_addMove(&mv)); /* full */
}

/* abortAndClear stops the stepper, empties the queue, and demotes MOVING to
 * WAITING so the module becomes idle again. */
void test_abortAndClear_stops_clears_and_returns_to_waiting(void)
{
    motion_driveToWaiting();

    app_motion_move_t a = make_move((uint8_t)G1_LINEAR_MOVE, 1000, 100, 0);
    app_motion_move_t b = make_move((uint8_t)G1_LINEAR_MOVE, 2000, 100, 0);
    TEST_ASSERT_TRUE(app_motion_addMove(&a));
    TEST_ASSERT_TRUE(app_motion_addMove(&b));

    app_motion_run(); /* pops one -> MOVING, one still queued */
    TEST_ASSERT_FALSE(app_motion_isIdle());

    d_stopCount = 0U;
    app_motion_abortAndClear();
    TEST_ASSERT_EQUAL_UINT32(1U, d_stopCount);
    TEST_ASSERT_TRUE(app_motion_isIdle()); /* WAITING + empty queue */
}

/* isIdle is false while a move is queued (even before it is popped). */
void test_isIdle_false_when_move_queued(void)
{
    motion_driveToWaiting();
    TEST_ASSERT_TRUE(app_motion_isIdle());

    app_motion_move_t mv = make_move((uint8_t)G1_LINEAR_MOVE, 1, 1, 0);
    TEST_ASSERT_TRUE(app_motion_addMove(&mv));
    TEST_ASSERT_FALSE(app_motion_isIdle());
}

/**********************************************************************
 * Tests: G123 waveform (firmware-native segmentation)
 **********************************************************************/

/* A G123 waveform streams the analytic velocity 2πf·A·cos(2πf·t): the commanded
 * rate reaches ±peak (=2πfA), reverses sign twice per cycle (at the position
 * peaks), and the move completes after cycles/frequency seconds (settling at the
 * centre). This is the firmware-side proof that we follow the expected f'(t). */
void test_waveform_streams_cosine_velocity_and_completes(void)
{
    motion_driveToWaiting();
    d_setVelocityCount = 0U;

    /* amplitude 5mm = 5000um -> 500 steps @100/mm; 1 Hz; 1 cycle -> 1s.
     * f field = (shape<<24) | freq_milli_Hz = (SINE<<24) | 1000.
     * Peak velocity = 2π·f·A = 2π·1·500 ≈ 3142 steps/s. */
    app_motion_move_t wf = make_move((uint8_t)G123_WAVEFORM, 5000, 1000, 1U);
    TEST_ASSERT_TRUE(app_motion_addMove(&wf));

    app_motion_run(); /* WAITING -> pop + moveManager_start(WAVEFORM) -> MOVING */
    TEST_ASSERT_FALSE(app_motion_isIdle());

    const int32_t peakVel = (int32_t)(2.0 * 3.14159265 * 1.0 * 500.0); /* ≈ 3141 */
    int32_t maxV = INT32_MIN;
    int32_t minV = INT32_MAX;
    int signChanges = 0;
    int32_t prevV = 0;
    bool havePrev = false;

    /* Drive one cycle (1s) in 5 ms steps; a velocity is streamed every tick. */
    for (uint32_t t = 0U; t < 1000000U; t += 5000U)
    {
        global_timeus = t;
        const uint32_t before = d_setVelocityCount;
        app_motion_run();
        if (d_setVelocityCount > before)
        {
            const int32_t v = d_lastSetVelocity;
            if (v > maxV) { maxV = v; }
            if (v < minV) { minV = v; }
            if (havePrev && (((prevV <= 0) && (v > 0)) || ((prevV >= 0) && (v < 0))))
            {
                signChanges++;
            }
            prevV = v;
            havePrev = true;
        }
    }

    /* Velocity reaches ±peak (2πfA) — proves amplitude × frequency. */
    TEST_ASSERT_INT_WITHIN(250, peakVel, maxV);
    TEST_ASSERT_INT_WITHIN(250, -peakVel, minV);
    /* cos reverses sign at the two position peaks per cycle. */
    TEST_ASSERT_TRUE(signChanges >= 2);

    /* Past the duration: a settle move parks at the centre, then complete. */
    global_timeus = 1100000U;
    d_steps = 0; /* centre reached */
    app_motion_run();
    TEST_ASSERT_TRUE(app_motion_isIdle());
}

/* A degenerate waveform (zero frequency) completes without commanding motion. */
void test_waveform_zero_frequency_completes_without_motion(void)
{
    motion_driveToWaiting();
    d_setVelocityCount = 0U;

    app_motion_move_t wf = make_move((uint8_t)G123_WAVEFORM, 5000, 0, 1U);
    TEST_ASSERT_TRUE(app_motion_addMove(&wf));
    app_motion_run(); /* pop + start -> MOVING */
    global_timeus = 1000U;
    app_motion_run(); /* moveManager_run -> degenerate -> complete */
    TEST_ASSERT_TRUE(app_motion_isIdle());
    TEST_ASSERT_EQUAL_UINT32(0U, d_setVelocityCount); /* no velocity commanded */
}

/* Run one G123 waveform to completion, capturing the streamed velocity extremes
 * and sign reversals. Drives ~200 ticks across the waveform duration. */
static void run_waveform_capture(int32_t ampUm, uint32_t freqMilliHz, uint32_t cycles,
                                 int32_t *outMaxV, int32_t *outMinV, int *outSignChanges)
{
    motion_driveToWaiting();
    d_setVelocityCount = 0U;
    d_steps = 0;
    global_timeus = 0U;

    app_motion_move_t wf = make_move((uint8_t)G123_WAVEFORM, ampUm, (int32_t)freqMilliHz, cycles);
    TEST_ASSERT_TRUE(app_motion_addMove(&wf));
    app_motion_run(); /* WAITING -> MOVING (start) */

    int32_t maxV = INT32_MIN;
    int32_t minV = INT32_MAX;
    int signChanges = 0;
    int32_t prevV = 0;
    bool havePrev = false;
    const float freqHz = (float)freqMilliHz / 1000.0f;
    const uint32_t durationUs = (uint32_t)(((float)cycles / freqHz) * 1.0e6f);
    uint32_t step = durationUs / 200U;
    if (step == 0U) { step = 1U; }
    for (uint32_t t = 0U; t < durationUs; t += step)
    {
        global_timeus = t;
        const uint32_t before = d_setVelocityCount;
        app_motion_run();
        if (d_setVelocityCount > before)
        {
            const int32_t v = d_lastSetVelocity;
            if (v > maxV) { maxV = v; }
            if (v < minV) { minV = v; }
            if (havePrev && (((prevV <= 0) && (v > 0)) || ((prevV >= 0) && (v < 0))))
            {
                signChanges++;
            }
            prevV = v;
            havePrev = true;
        }
    }
    *outMaxV = maxV;
    *outMinV = minV;
    *outSignChanges = signChanges;

    /* Complete: past duration, settle at centre. */
    global_timeus = durationUs + 200000U;
    d_steps = 0;
    app_motion_run();
    TEST_ASSERT_TRUE(app_motion_isIdle());
}

/* Sweep several waveforms: the streamed peak velocity must equal 2π·f·A and the
 * direction must reverse ~twice per cycle, for every amplitude/frequency/cycle
 * combination — proving the firmware follows f'(t) for arbitrary waveforms. */
void test_waveform_velocity_matches_2piFA_across_params(void)
{
    struct
    {
        int32_t ampUm;
        uint32_t fMilli;
        uint32_t cycles;
    } cases[] = {
        {2000U, 2000U, 1U},  /* 2mm @ 2Hz x1  -> 200 steps, peak 2π·2·200 ≈ 2513 */
        {10000U, 500U, 2U},  /* 10mm @ 0.5Hz x2 -> 1000 steps, peak 2π·0.5·1000 ≈ 3142 */
        {5000U, 1000U, 3U},  /* 5mm @ 1Hz x3  -> 500 steps, peak 2π·1·500 ≈ 3142 */
        {1000U, 4000U, 2U},  /* 1mm @ 4Hz x2  -> 100 steps, peak 2π·4·100 ≈ 2513 */
    };
    for (size_t i = 0U; i < (sizeof(cases) / sizeof(cases[0])); i++)
    {
        int32_t maxV = 0;
        int32_t minV = 0;
        int signChanges = 0;
        run_waveform_capture(cases[i].ampUm, cases[i].fMilli, cases[i].cycles, &maxV, &minV, &signChanges);

        const float fHz = (float)cases[i].fMilli / 1000.0f;
        const float ampSteps = (float)cases[i].ampUm * 100.0f / 1000.0f; /* stepsPerMM = 100 */
        const int32_t peak = (int32_t)(2.0f * 3.14159265f * fHz * ampSteps);
        const int32_t tol = (peak / 8) + 30;
        TEST_ASSERT_INT_WITHIN(tol, peak, maxV);   /* +peak velocity = 2πfA */
        TEST_ASSERT_INT_WITHIN(tol, -peak, minV);  /* -peak velocity */
        TEST_ASSERT_TRUE(signChanges >= (int)(2U * cases[i].cycles) - 1); /* ~2 reversals/cycle */
    }
}

/**********************************************************************
 * main
 **********************************************************************/
int main(void)
{
    UNITY_BEGIN();

    RUN_TEST(test_init_then_enabled_run_enables_stepper_and_waits);
    RUN_TEST(test_disable_stops_disables_and_clears_queue);
    RUN_TEST(test_waiting_pops_and_starts_move_then_moving);
    RUN_TEST(test_moving_completes_only_when_at_target);

    RUN_TEST(test_zero_feedrate_move_issues_no_stepper_move);
    RUN_TEST(test_incremental_mode_adds_current_position);
    RUN_TEST(test_absolute_mode_ignores_current_position);

    RUN_TEST(test_dwell_holds_until_period_elapses);

    RUN_TEST(test_homing_full_sequence);
    RUN_TEST(test_homing_fails_when_target_reached_without_endstop);

    RUN_TEST(test_getSetpoint_scales_target_steps_to_um);
    RUN_TEST(test_getPosition_scales_steps_to_um);
    RUN_TEST(test_zero_stepsPerMM_yields_zero_setpoint_and_position);

    RUN_TEST(test_addMove_queue_is_bounded);
    RUN_TEST(test_abortAndClear_stops_clears_and_returns_to_waiting);
    RUN_TEST(test_isIdle_false_when_move_queued);

    RUN_TEST(test_waveform_streams_cosine_velocity_and_completes);
    RUN_TEST(test_waveform_zero_frequency_completes_without_motion);
    RUN_TEST(test_waveform_velocity_matches_2piFA_across_params);

    return UNITY_END();
}
