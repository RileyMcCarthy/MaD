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
#include "vibes_behaviour.h"
#include <string.h>
#include <stdint.h>
#include <stdbool.h>

#include "HAL_lock.h"
#include "dev_servo.h"                // dev_servo_channel_E, DEV_SERVO_CHANNEL_MAIN
#include "dev_nvram.h"                // dev_nvram_channel_t, DEV_NVRAM_CHANNEL_MACHINE_PROFILE
#include "dev_nvram_machineProfile.h" // MachineProfile
#include "HAL_GPIO.h"                 // HAL_GPIO_channel_E, HAL_GPIO_ENDSTOP_UPPER
#include "IO_positionFeedback.h"      // IO_positionFeedback_channel_E

// Exercise the actuator-agnostic motion state machine against the dev_stepper
// mocks below. app_motion's actuator abstraction is a 1:1 macro map, so pinning
// the stepper backend fully covers the logic; the closed-loop dev_servo driver
// (the production default) is validated by its own suite, not here.
#define APP_MOTION_USE_SERVO 1
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

/* --- dev_servo inputs --- */
static int32_t d_steps;       // dev_servo_getPosition(MAIN)
static bool d_atTarget;       // dev_servo_atTarget(MAIN)
static int32_t d_target;      // dev_servo_getTarget(MAIN)
static int32_t d_setpoint;    // dev_servo_getSetpoint(MAIN)

int32_t dev_servo_getPosition(dev_servo_channel_E ch)
{
    TEST_ASSERT_EQUAL_INT(DEV_SERVO_CHANNEL_MAIN, ch);
    return d_steps;
}
bool dev_servo_atTarget(dev_servo_channel_E ch)
{
    TEST_ASSERT_EQUAL_INT(DEV_SERVO_CHANNEL_MAIN, ch);
    return d_atTarget;
}
int32_t dev_servo_getTarget(dev_servo_channel_E ch)
{
    TEST_ASSERT_EQUAL_INT(DEV_SERVO_CHANNEL_MAIN, ch);
    return d_target;
}
int32_t dev_servo_getSetpoint(dev_servo_channel_E ch)
{
    TEST_ASSERT_EQUAL_INT(DEV_SERVO_CHANNEL_MAIN, ch);
    return d_setpoint;
}

/* --- HAL_GPIO inputs --- */
static bool d_endstopUpperActive; // HAL_GPIO_getActive(ENDSTOP_UPPER)

bool HAL_GPIO_getActive(HAL_GPIO_channel_E channel)
{
    TEST_ASSERT_EQUAL_INT(HAL_GPIO_ENDSTOP_UPPER, channel);
    return d_endstopUpperActive;
}

/* --- dev_servo outputs (record the last call + counts) --- */
static uint32_t d_moveCount;
static int32_t d_lastMoveTarget;
static int32_t d_lastMoveStepsPerSecond;
static uint32_t d_stopCount;
static uint32_t d_enableCount;
static bool d_lastEnable;
static uint32_t d_setPositionCount;
static int32_t d_lastSetPosition;

void dev_servo_moveTo(dev_servo_channel_E ch, int32_t targetCounts, int32_t feedrateCountsPerSec)
{
    TEST_ASSERT_EQUAL_INT(DEV_SERVO_CHANNEL_MAIN, ch);
    d_moveCount++;
    d_lastMoveTarget = targetCounts;
    d_lastMoveStepsPerSecond = feedrateCountsPerSec;
}

/* --- dev_servo velocity mode (record the last call + count) --- */
static uint32_t d_setVelocityCount;
static int32_t d_lastSetVelocity;

void dev_servo_setVelocity(dev_servo_channel_E ch, int32_t velCountsPerSec)
{
    TEST_ASSERT_EQUAL_INT(DEV_SERVO_CHANNEL_MAIN, ch);
    d_setVelocityCount++;
    d_lastSetVelocity = velCountsPerSec;
}
void dev_servo_stop(dev_servo_channel_E ch)
{
    TEST_ASSERT_EQUAL_INT(DEV_SERVO_CHANNEL_MAIN, ch);
    d_stopCount++;
}
void dev_servo_enable(dev_servo_channel_E ch, bool enable)
{
    TEST_ASSERT_EQUAL_INT(DEV_SERVO_CHANNEL_MAIN, ch);
    d_enableCount++;
    d_lastEnable = enable;
}
void dev_servo_setPosition(dev_servo_channel_E ch, int32_t counts)
{
    TEST_ASSERT_EQUAL_INT(DEV_SERVO_CHANNEL_MAIN, ch);
    d_setPositionCount++;
    d_lastSetPosition = counts;
}

/* --- dev_servo waveform: record exactly what the adapter asked the driver for,
 * and let a test decide whether the driver accepts it. --- */
static uint32_t d_waveformCount;
static int32_t d_lastWaveCentre;
static int32_t d_lastWaveAmplitude;
static uint32_t d_lastWaveFreqMicroHz;
static uint32_t d_lastWaveCycles;
static dev_servo_wave_E d_lastWaveShape;
static uint16_t d_lastWaveSkew;
static uint32_t d_lastWaveDwellHighUs;
static uint32_t d_lastWaveDwellLowUs;
static bool d_waveformAccepted = true;

/* The driver owns which traverse profiles exist; this suite stubs the driver,
 * so it mirrors that one rule. The rule itself is pinned against the real
 * implementation in test_dev_servo (servo.wave-shape-from-wire) -- here it
 * exists only so app_motion's refusal path has something to refuse against. */
bool dev_servo_waveShapeFromWire(uint8_t wire, dev_servo_wave_E *shape)
{
    if ((shape == NULL) || (wire > (uint8_t)DEV_SERVO_WAVE_TRIANGLE))
    {
        return false;
    }
    *shape = (wire == (uint8_t)DEV_SERVO_WAVE_TRIANGLE) ? DEV_SERVO_WAVE_TRIANGLE : DEV_SERVO_WAVE_SINE;
    return true;
}

bool dev_servo_startWaveform(dev_servo_channel_E ch, const dev_servo_waveform_S *waveform)
{
    TEST_ASSERT_EQUAL_INT(DEV_SERVO_CHANNEL_MAIN, ch);
    TEST_ASSERT_NOT_NULL(waveform);
    const int32_t amplitudeCounts = waveform->amplitudeCounts;
    const uint32_t freqMicroHz = waveform->freqMicroHz;
    d_waveformCount++;
    d_lastWaveCentre = waveform->centreCounts;
    d_lastWaveAmplitude = amplitudeCounts;
    d_lastWaveFreqMicroHz = freqMicroHz;
    d_lastWaveCycles = waveform->cycles;
    d_lastWaveShape = waveform->shape;
    d_lastWaveSkew = waveform->skewPerMille;
    d_lastWaveDwellHighUs = waveform->dwellHighUs;
    d_lastWaveDwellLowUs = waveform->dwellLowUs;
    /* The real driver refuses these outright (see dev_servo_startWaveform).
     * Modelling just that rule keeps the adapter's degenerate-input behaviour
     * honest without reimplementing the whole feasibility envelope here --
     * `d_waveformAccepted` stands in for an envelope rejection. */
    if ((amplitudeCounts <= 0) || (freqMicroHz == 0U))
    {
        return false;
    }
    return d_waveformAccepted;
}

/* --- IO_positionFeedback output (record last call) --- */
static uint32_t d_setValueCount;
static int32_t d_lastSetValueNM;

bool IO_positionFeedback_setValue(IO_positionFeedback_channel_E ch, int32_t positionUM)
{
    TEST_ASSERT_EQUAL_INT(IO_POSITION_FEEDBACK_CHANNEL_SERVO_FEEDBACK, ch);
    d_setValueCount++;
    d_lastSetValueNM = positionUM;
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
    d_lastSetValueNM = 0;

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

/* A waveform record. Symmetric and hold-free unless a test says otherwise --
 * the same cycle G123 has always meant. */
static app_motion_move_t make_waveform(int32_t amplitudeTenthUm, uint32_t freqMicroHz,
                                       uint32_t cycles, uint8_t shape)
{
    app_motion_move_t m;
    memset(&m, 0, sizeof(m));
    m.g = (uint8_t)G123_WAVEFORM;
    m.wave.amplitudeTenthUm = amplitudeTenthUm;
    m.wave.freqMicroHz = freqMicroHz;
    m.wave.cycles = cycles;
    m.wave.skewPerMille = 500U;
    m.wave.shape = shape;
    return m;
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
    VIBES_TEST("motion.enable-turns-drive-on-and-waits",
               "src/APP/app_motion.c#app_motion_private_getDesiredState",
               "motion just initialised, then motion enabled for the first cycle");
    VIBES_EXPECT("drive-on-once", "the drive is turned on once");
    VIBES_EXPECT("planner-idle", "the motion planner is left idle, waiting for a move");
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
    VIBES_TEST("motion.disable-stops-and-drops-queue",
               "src/APP/app_motion.c#app_motion_private_getDesiredState",
               "motion waiting with a queued move, then motion disabled");
    VIBES_EXPECT("drive-stops-and-off", "the drive stops and turns off");
    VIBES_EXPECT_WHY("queue-emptied",
                     "the queue is emptied, so re-enabling leaves the motion planner idle",
                     "a disabled machine must not finish a leftover move when the operator re-enables motion");
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
    VIBES_TEST("motion.waiting-starts-queued-move",
               "src/APP/app_motion.c#app_motion_private_moveManager_start",
               "the motion planner idle in absolute mode, with a rapid move of 2 millimetres at 50 millimetres per second queued");
    VIBES_EXPECT("commanded-same-cycle", "the drive is commanded to that target and feedrate on the same cycle");
    VIBES_EXPECT("planner-busy", "the planner is then busy");
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
    VIBES_TEST("motion.move-completes-on-arrival",
               "src/APP/app_motion.c#app_motion_private_moveManager_run",
               "a linear move in flight, first with the drive still travelling, then with the drive at the target");
    VIBES_EXPECT("busy-before-arrival", "the motion planner is busy on the first check");
    VIBES_EXPECT("idle-after-arrival", "the motion planner is idle on the second check");
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
    VIBES_TEST("motion.zero-feedrate-skips-drive-command",
               "src/APP/app_motion.c#app_motion_private_moveManager_start",
               "a linear move queued with a feedrate of zero");
    VIBES_EXPECT_WHY("drive-uncommanded",
                     "the drive is left uncommanded",
                     "a feedrate of zero would stall the gantry if it were sent to the drive");
    VIBES_EXPECT("move-still-completes", "the move still completes once the drive reports arrival");
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
    VIBES_TEST("motion.incremental-adds-current-position",
               "src/APP/app_motion.c#app_motion_private_moveManager_start",
               "incremental mode, the gantry at 15 millimetres, and a 1 millimetre linear move");
    VIBES_EXPECT_WHY("target-offset-by-position",
                     "the drive is commanded to 16 millimetres",
                     "incremental G-code is relative to where the machine is now");
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
    VIBES_TEST("motion.absolute-uses-programmed-target",
               "src/APP/app_motion.c#app_motion_private_moveManager_start",
               "absolute mode restored after incremental, the gantry at an unrelated position, and a rapid move to 1 millimetre");
    VIBES_EXPECT_WHY("target-as-programmed",
                     "the drive is commanded to 1 millimetre",
                     "absolute G-code is machine coordinates");
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
    VIBES_TEST("motion.dwell-holds-for-period",
               "src/APP/app_motion.c#app_motion_private_moveManager_run",
               "a 50 millisecond dwell, checked at 40 milliseconds and again at 60 milliseconds");
    VIBES_EXPECT("busy-before-expiry", "the motion planner is busy at the first check");
    VIBES_EXPECT("idle-after-expiry", "the motion planner is idle at the second check");
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
    VIBES_TEST("motion.homing-endstop-then-backoff",
               "src/APP/app_motion.c#app_motion_private_homing_run",
               "a home command, the gantry at 50 millimetres, then the upper endstop, a 1 second pause, and backoff arrival");
    VIBES_EXPECT("approach-at-homing-speed",
                 "the gantry is commanded a full travel limit toward the endstop at the homing speed");
    VIBES_EXPECT("drive-stops", "the drive stops");
    VIBES_EXPECT_WHY("origin-at-jaw-offset",
                     "the jaw offset becomes the coordinate origin",
                     "the upper endstop is the only absolute reference; the jaw offset and homing offset together put the grip lips at a known machine coordinate");
    VIBES_EXPECT("backs-off-by-homing-offset", "the gantry backs off by the homing offset");
    VIBES_EXPECT("planner-idle", "the planner goes idle");
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
    TEST_ASSERT_EQUAL_INT32(3000000, d_lastSetValueNM); /* nm */
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
    VIBES_TEST("motion.homing-completes-if-endstop-missed",
               "src/APP/app_motion.c#app_motion_private_homing_run",
               "a home command whose approach reaches its target with the upper endstop still open");
    VIBES_EXPECT_WHY("no-origin-no-backoff",
                     "no coordinate origin is written and no backoff move is commanded",
                     "with no endstop there is no origin to write");
    VIBES_EXPECT_WHY("homing-finishes",
                     "homing finishes, leaving the motion planner idle",
                     "finishing lets the motion planner accept the next move");
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
void test_getSetpoint_scales_target_steps_to_nm(void)
{
    VIBES_TEST("motion.setpoint-steps-to-micrometres",
               "src/APP/app_motion.c#app_motion_private_processOutputs",
               "the drive target at 250 steps, then at minus 100 steps, with 100 steps per millimetre");
    VIBES_EXPECT("positive-target", "the published setpoint is 2500 micrometres");
    VIBES_EXPECT("negative-target", "the published setpoint is then minus 1000 micrometres");
    d_target = 250; /* steps; 250*1000/100 = 2500 um */
    d_motionEnabled = true;
    app_motion_run();
    TEST_ASSERT_EQUAL_INT32(2500000, app_motion_getSetpoint()); /* nm */

    d_target = -100; /* -100*1000/100 = -1000 um */
    app_motion_run();
    TEST_ASSERT_EQUAL_INT32(-1000000, app_motion_getSetpoint()); /* nm */
}

/* getPosition converts the snapshotted current step count to um. */
void test_getPosition_scales_steps_to_nm(void)
{
    VIBES_TEST("motion.position-steps-to-micrometres",
               "src/APP/app_motion.c#app_motion_getPosition",
               "the drive at 175 steps with 100 steps per millimetre");
    VIBES_EXPECT("position-in-micrometres", "the published position is 1750 micrometres");
    d_steps = 175; /* 175*1000/100 = 1750 um */
    d_motionEnabled = true;
    app_motion_run();
    TEST_ASSERT_EQUAL_INT32(1750, app_motion_getPosition());
}

/* With stepsPerMM == 0 the conversions guard against divide-by-zero and yield 0. */
void test_zero_stepsPerMM_yields_zero_setpoint_and_position(void)
{
    VIBES_TEST("motion.zero-steps-per-mm-publishes-zero",
               "src/APP/app_motion.c#app_motion_getPosition",
               "a machine profile with zero steps per millimetre, and a non-zero drive target and position");
    VIBES_EXPECT_WHY("setpoint-zero",
                     "the published setpoint is zero",
                     "converting steps to micrometres divides by steps per millimetre, so a missing value would divide by zero");
    VIBES_EXPECT("position-zero", "the published position is zero");
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
    VIBES_TEST("motion.move-queue-has-fixed-capacity",
               "src/APP/app_motion.c#app_motion_addMove",
               "moves pushed until the motion queue is full, then one more");
    VIBES_EXPECT_WHY("capacity-one-less-than-slots",
                     "the motion queue fills to one less than its slot count",
                     "one slot stays empty so the motion planner can tell a full queue from an empty one");
    VIBES_EXPECT("extra-push-refused", "the next push is refused");
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
    VIBES_TEST("motion.abort-stops-and-idles",
               "src/APP/app_motion.c#app_motion_abortAndClear",
               "motion aborted with a move in flight and another still queued");
    VIBES_EXPECT_WHY("drive-stopped",
                     "the drive is stopped",
                     "ending a test must stop travel");
    VIBES_EXPECT_WHY("moves-dropped-and-idle",
                     "every queued move is dropped and the motion planner goes idle",
                     "ending a test must drop leftover moves");
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
    VIBES_TEST("motion.queued-move-is-busy",
               "src/APP/app_motion.c#app_motion_isIdle",
               "the motion planner waiting, then one move queued");
    VIBES_EXPECT("idle-while-empty", "the motion planner reports idle");
    VIBES_EXPECT_WHY("busy-once-queued",
                     "the motion planner reports busy immediately, before any cycle pops the move",
                     "a test waits for the motion planner to go idle before completing, so a queued move counts as busy");
    motion_driveToWaiting();
    TEST_ASSERT_TRUE(app_motion_isIdle());

    app_motion_move_t mv = make_move((uint8_t)G1_LINEAR_MOVE, 1, 1, 0);
    TEST_ASSERT_TRUE(app_motion_addMove(&mv));
    TEST_ASSERT_FALSE(app_motion_isIdle());
}

/**********************************************************************
 * Tests: G123 waveform (firmware-native segmentation)
 **********************************************************************/


/* The adapter's whole job: translate the move record into a driver request.
 * Every one of these numbers is a unit conversion that silently produces a
 * wrong-sized test if it is off. */
void test_waveform_is_handed_to_the_driver_in_the_drivers_units(void)
{
    VIBES_TEST("motion.waveform-handed-to-driver",
               "src/APP/app_motion.c#app_motion_private_moveManager_start",
               "a G123 record carrying amplitude in um, frequency in mHz and a shape bit");
    VIBES_EXPECT_WHY("converted-to-driver-units",
                     "the driver is asked for the same waveform in counts, microhertz and its own shape enum",
                     "this layer no longer generates anything, so a unit slip here is the only way the machine can run a waveform that is not the one asked for, and it would look entirely healthy while doing it");

    motion_driveToWaiting();
    d_steps = 4321;          /* the wave swings about wherever we are now */
    d_waveformCount = 0U;

    /* 50000 tenth-um = 5 mm; at 100 steps/mm that is 500 steps. */
    app_motion_move_t wf = make_waveform(50000, 250000U, 7U, 1U);
    wf.wave.dwellHighMs = 250U;
    wf.wave.dwellLowMs = 40U;
    wf.wave.skewPerMille = 700U;
    TEST_ASSERT_TRUE(app_motion_addMove(&wf));
    app_motion_run(); /* pop + start */

    TEST_ASSERT_EQUAL_UINT32(1U, d_waveformCount);
    TEST_ASSERT_EQUAL_INT32(4321, d_lastWaveCentre);
    TEST_ASSERT_EQUAL_INT32(500, d_lastWaveAmplitude);
    TEST_ASSERT_EQUAL_UINT32(250000U, d_lastWaveFreqMicroHz);
    TEST_ASSERT_EQUAL_UINT32(7U, d_lastWaveCycles);
    TEST_ASSERT_EQUAL_INT(DEV_SERVO_WAVE_TRIANGLE, d_lastWaveShape);
    /* Dwell and skew are not on the wire yet: the driver must be asked for the
     * symmetric, hold-free cycle this command has always meant, not for zero
     * skew (which would be a traverse of no duration). */
    /* Milliseconds on the record, microseconds in the driver. */
    TEST_ASSERT_EQUAL_UINT32(250000U, d_lastWaveDwellHighUs);
    TEST_ASSERT_EQUAL_UINT32(40000U, d_lastWaveDwellLowUs);
    TEST_ASSERT_EQUAL_UINT16(700U, d_lastWaveSkew);
}

void test_a_sine_shape_bit_selects_a_sine(void)
{
    VIBES_TEST("motion.sine-shape-bit-selects-sine",
               "src/APP/app_motion.c#app_motion_private_moveManager_start",
               "a waveform whose shape bit asks for a sine");
    VIBES_EXPECT("sine-asked-of-driver", "the driver is asked for a sine");
    VIBES_EXPECT_WHY("symmetric-skew",
                     "a hold-free cycle asks for the symmetric split",
                     "zero skew is a traverse of no duration, which the driver refuses");
    motion_driveToWaiting();
    app_motion_move_t wf = make_waveform(50000, 1000000U, 2U, 0U);
    TEST_ASSERT_TRUE(app_motion_addMove(&wf));
    app_motion_run();
    TEST_ASSERT_EQUAL_INT(DEV_SERVO_WAVE_SINE, d_lastWaveShape);
    TEST_ASSERT_EQUAL_UINT32(1000000U, d_lastWaveFreqMicroHz);
    /* A hold-free cycle must ask for the SYMMETRIC split, not zero skew --
     * zero skew is a traverse of no duration, which the driver refuses. */
    TEST_ASSERT_EQUAL_UINT16(DEV_SERVO_SKEW_SYMMETRIC, d_lastWaveSkew);
}

/* A waveform the driver will not run must END the move, not wait forever for a
 * run that never started. */
void test_a_refused_waveform_completes_the_move_instead_of_hanging(void)
{
    VIBES_TEST("motion.refused-waveform-ends-the-move",
               "src/APP/app_motion.c#app_motion_private_waveform_run",
               "a waveform the driver refuses because the machine cannot deliver it");
    VIBES_EXPECT_WHY("move-ends",
                     "the move completes rather than waiting for a run that never started",
                     "completion is now the driver's arrival verdict, and a refused waveform never arrives -- so without this the move, the test and the machine all wait forever");

    motion_driveToWaiting();
    d_waveformAccepted = false;
    d_atTarget = false;
    d_setVelocityCount = 0U;

    app_motion_move_t wf = make_waveform(50000, 1000000U, 2U, 0U);
    TEST_ASSERT_TRUE(app_motion_addMove(&wf));
    app_motion_run(); /* pop + start -> refused */
    global_timeus = 1000U;
    app_motion_run(); /* moveManager_run -> complete */
    TEST_ASSERT_TRUE(app_motion_isIdle());
    TEST_ASSERT_EQUAL_UINT32(0U, d_setVelocityCount);
    d_waveformAccepted = true;
}

/* Completion is the driver's verdict, and only the driver's. */
void test_a_waveform_runs_until_the_driver_reports_arrival(void)
{
    VIBES_TEST("motion.waveform-completes-on-driver-arrival",
               "src/APP/app_motion.c#app_motion_private_waveform_run",
               "a waveform the driver accepted and has not finished");
    VIBES_EXPECT_WHY("waits-for-the-driver",
                     "the move stays in progress until the driver reports arrival",
                     "the driver alone knows how many cycles have elapsed and whether the closing move to the centre has landed; a duration guessed in this layer is the thing that used to end waveforms early or late");

    motion_driveToWaiting();
    d_atTarget = false;
    app_motion_move_t wf = make_waveform(50000, 1000000U, 2U, 0U);
    TEST_ASSERT_TRUE(app_motion_addMove(&wf));
    app_motion_run();
    for (unsigned i = 0U; i < 50U; i++)
    {
        global_timeus += 1000U;
        app_motion_run();
        TEST_ASSERT_FALSE_MESSAGE(app_motion_isIdle(),
                                  "the move ended while the driver was still running the waveform");
    }
    d_atTarget = true;
    global_timeus += 1000U;
    app_motion_run();
    TEST_ASSERT_TRUE(app_motion_isIdle());
}

/* What a recorded sample says the machine was asked for. */
void test_the_recorded_setpoint_during_a_waveform_is_the_trajectory(void)
{
    VIBES_TEST("motion.waveform-setpoint-is-the-trajectory",
               "src/APP/app_motion.c#app_motion_private_processInputs",
               "a waveform in progress, where the driver's target and its live setpoint differ");
    VIBES_EXPECT_WHY("reports-the-profile-not-the-destination",
                     "the published setpoint is the driver's live profile position, not the move's end target",
                     "a waveform's target is the centre it will finish at, so reporting the target would record a flat line through the middle of an oscillation and make a tracking error impossible to see in the data");

    motion_driveToWaiting();
    d_atTarget = false;
    d_target = 1000;    /* where the waveform will END   */
    d_setpoint = 1750;  /* where the trajectory is NOW   */
    app_motion_move_t wf = make_waveform(50000, 1000000U, 2U, 0U);
    TEST_ASSERT_TRUE(app_motion_addMove(&wf));
    app_motion_run();
    global_timeus += 1000U;
    app_motion_run();
    /* stepsPerMM is 100, so 1750 steps is 17.5 mm. */
    TEST_ASSERT_EQUAL_INT32(17500000, app_motion_getCommandedPosition()); /* nm */
    /* ...while the TARGET still reports where the move ENDS, which is what a
     * host uses to see a command register and to tell that the axis arrived. */
    TEST_ASSERT_EQUAL_INT32(10000000, app_motion_getSetpoint());
}

void test_a_linear_move_records_its_trajectory_not_its_destination(void)
{
    VIBES_TEST("motion.linear-records-its-trajectory",
               "src/APP/app_motion.c#app_motion_private_processInputs",
               "a linear move in progress, where the driver's target and its live profile position differ");
    VIBES_EXPECT_WHY("commanded-is-the-profile",
                     "the commanded position follows the profile while the target stays at the destination",
                     "a recorded sample must say what the specimen was being asked for at that instant; recording the destination instead draws a flat line through the middle of the ramp, which is why a 24 um tracking offset sat unnoticed in G0/G1 data");

    motion_driveToWaiting();
    d_atTarget = false;
    d_target = 5000;    /* where the move ENDS  */
    d_setpoint = 1250;  /* where the ramp is NOW */
    app_motion_move_t mv = make_move((uint8_t)G1_LINEAR_MOVE, 50000, 1000, 0U);
    TEST_ASSERT_TRUE(app_motion_addMove(&mv));
    app_motion_run();
    global_timeus += 1000U;
    app_motion_run();
    /* stepsPerMM is 100: 1250 steps = 12.5 mm, 5000 steps = 50 mm. */
    TEST_ASSERT_EQUAL_INT32(12500000, app_motion_getCommandedPosition());
    TEST_ASSERT_EQUAL_INT32(50000000, app_motion_getSetpoint());
}

/* A degenerate waveform (zero frequency) completes without commanding motion. */
void test_a_waveform_with_an_unknown_shape_never_reaches_the_driver(void)
{
    VIBES_TEST("motion.waveform-unknown-shape-refused",
               "src/APP/app_motion.c#app_motion_private_waveform_run",
               "a feasible waveform whose shape byte is one of the reserved values 2..255");
    VIBES_EXPECT_WHY("driver-never-asked",
                     "the driver is never asked to start the waveform",
                     "the adapter must not pick a profile on the host's behalf: laundering a reserved byte into a sine is how a machine runs a loading nobody requested and files it under the shape that was asked for");
    VIBES_EXPECT_WHY("move-completes",
                     "the move completes rather than hanging the queue",
                     "a refused waveform must not strand the test in MOVING forever -- the operator needs the program to end so the refusal is visible");

    motion_driveToWaiting();
    d_waveformCount = 0U;
    d_setVelocityCount = 0U;

    /* Amplitude, frequency and cycles are all perfectly runnable; the shape
     * byte is the only thing wrong, so a failure here cannot be blamed on the
     * feasibility envelope. */
    app_motion_move_t wf = make_waveform(50000, 1000000U, 2U, 2U);
    TEST_ASSERT_TRUE(app_motion_addMove(&wf));
    app_motion_run(); /* pop + start -> refused before the driver is called */
    TEST_ASSERT_EQUAL_UINT32(0U, d_waveformCount);

    global_timeus = 1000U;
    app_motion_run();
    TEST_ASSERT_TRUE(app_motion_isIdle());
    TEST_ASSERT_EQUAL_UINT32(0U, d_setVelocityCount);

    /* The same waveform with a shape the driver DOES implement is accepted,
     * so the refusal is about the byte and not about the rest of the record. */
    d_waveformCount = 0U;
    app_motion_move_t ok = make_waveform(50000, 1000000U, 2U, 1U);
    TEST_ASSERT_TRUE(app_motion_addMove(&ok));
    app_motion_run();
    TEST_ASSERT_EQUAL_UINT32(1U, d_waveformCount);
    TEST_ASSERT_EQUAL_INT(DEV_SERVO_WAVE_TRIANGLE, (int)d_lastWaveShape);
}

void test_waveform_zero_frequency_completes_without_motion(void)
{
    VIBES_TEST("motion.waveform-zero-frequency-completes",
               "src/APP/app_motion.c#app_motion_private_waveform_run",
               "a waveform with amplitude and cycles but a frequency of zero");
    VIBES_EXPECT("move-completes", "the move completes");
    VIBES_EXPECT_WHY("no-velocity-commanded",
                     "no velocity is commanded to the drive",
                     "a frequency of zero has no trajectory to play");
    motion_driveToWaiting();
    d_setVelocityCount = 0U;

    app_motion_move_t wf = make_waveform(50000, 0U, 1U, 0U); /* zero frequency */
    TEST_ASSERT_TRUE(app_motion_addMove(&wf));
    app_motion_run(); /* pop + start -> MOVING */
    global_timeus = 1000U;
    app_motion_run(); /* moveManager_run -> degenerate -> complete */
    TEST_ASSERT_TRUE(app_motion_isIdle());
    TEST_ASSERT_EQUAL_UINT32(0U, d_setVelocityCount); /* no velocity commanded */
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

    RUN_TEST(test_getSetpoint_scales_target_steps_to_nm);
    RUN_TEST(test_getPosition_scales_steps_to_nm);
    RUN_TEST(test_zero_stepsPerMM_yields_zero_setpoint_and_position);

    RUN_TEST(test_addMove_queue_is_bounded);
    RUN_TEST(test_abortAndClear_stops_clears_and_returns_to_waiting);
    RUN_TEST(test_isIdle_false_when_move_queued);

    RUN_TEST(test_waveform_is_handed_to_the_driver_in_the_drivers_units);
    RUN_TEST(test_a_sine_shape_bit_selects_a_sine);
    RUN_TEST(test_a_refused_waveform_completes_the_move_instead_of_hanging);
    RUN_TEST(test_a_waveform_runs_until_the_driver_reports_arrival);
    RUN_TEST(test_the_recorded_setpoint_during_a_waveform_is_the_trajectory);
    RUN_TEST(test_a_linear_move_records_its_trajectory_not_its_destination);
    RUN_TEST(test_a_waveform_with_an_unknown_shape_never_reaches_the_driver);
    RUN_TEST(test_waveform_zero_frequency_completes_without_motion);

    return UNITY_END();
}
