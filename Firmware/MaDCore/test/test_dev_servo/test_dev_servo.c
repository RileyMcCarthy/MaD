/*
 * Unit tests for src/DEV/dev_servo.c — closed-loop motion backend.
 *
 * Coverage (certification contracts parallel to test_dev_stepper):
 *   - init: disabled, atTarget, encoder position is source of truth
 *   - enable / disable idle park
 *   - moveTo stages target; invalid feedrate clamps to maxVelocity
 *   - atTarget when encoder is inside deadband and profile is settled
 *   - velocity mode commands a non-zero pulse train
 *   - stop requests velocity hold at 0
 *   - setPosition redefines encoder reference + target
 *   - following error reflects setpoint vs encoder
 *   - stall guard latches after stallTicks of commanding without motion
 *   - liveness (isReady) — what app_control gates the machine on
 *   - arrival is invalidated by every command that redefines the target,
 *     including one landing mid-tick, and the approach converges rather
 *     than hunting (both regressions; see the tests for the failure modes)
 *
 * HAL_encoder / HAL_pulseOut / HAL_GPIO / HAL_time are local doubles.
 * Library is real (linked by native_test). Module is #included after doubles.
 */

#include <unity.h>
#include "vibes_behaviour.h"
#include <string.h>
#include <stdint.h>
#include <stdbool.h>
#include <math.h>
#include <stdio.h>

#include "HAL_lock.h"
#include "HAL_GPIO.h"
#include "HAL_pulseOut.h"
#include "HAL_encoder.h"
#include "HAL_time.h"

/* ====================================================================== *
 * Test doubles                                                            *
 * ====================================================================== */

static int32_t d_encoderValue;
static int d_encoderSetCount;
static int32_t d_encoderLastSet;

void HAL_encoder_start(HAL_encoder_channel_E ch) { (void)ch; }
/* Optional one-shot hook fired from inside HAL_encoder_value — which the control
 * loop reads every tick, right AFTER it has snapshotted the request. That is
 * exactly the window a command issued by another cog can land in, so it models
 * the CONTROL cog commanding a move mid-tick on the MOTOR cog. */
static void (*d_midTickHook)(void);

/* Sub-count-accurate carriage position for tick_with_motion(). Precision
 * matters — the slow final approach commands rates below one count per tick,
 * and integer truncation there would stall the carriage short of the deadband
 * and mask the settling behaviour under test. */
static double d_carriage;

int32_t HAL_encoder_value(HAL_encoder_channel_E ch)
{
    (void)ch;
    if (d_midTickHook != NULL)
    {
        void (*hook)(void) = d_midTickHook;
        d_midTickHook = NULL; /* one-shot */
        hook();
    }
    return d_encoderValue;
}
void HAL_encoder_set(HAL_encoder_channel_E ch, int32_t v)
{
    (void)ch;
    d_encoderSetCount++;
    d_encoderLastSet = v;
    d_encoderValue = v;
}

static uint32_t d_startVelocityCount;
static uint32_t d_startVelocityFreq;
static uint32_t d_setFrequencyCount;
static uint32_t d_lastSetFrequency;
static uint32_t d_stopCount;
static uint32_t d_runCount;
static uint32_t d_run_delta;

void HAL_pulseOut_start(HAL_pulseOut_channel_E channel, uint32_t pulses, uint32_t frequency)
{
    (void)channel;
    (void)pulses;
    (void)frequency;
}

bool HAL_pulseOut_run(HAL_pulseOut_channel_E channel, uint32_t *pulses)
{
    (void)channel;
    d_runCount++;
    if (pulses != NULL)
    {
        *pulses = d_run_delta;
    }
    return false;
}

void HAL_pulseOut_stop(HAL_pulseOut_channel_E channel)
{
    (void)channel;
    d_stopCount++;
}

void HAL_pulseOut_startVelocity(HAL_pulseOut_channel_E channel, uint32_t frequency)
{
    (void)channel;
    d_startVelocityCount++;
    d_startVelocityFreq = frequency;
}

void HAL_pulseOut_setFrequency(HAL_pulseOut_channel_E channel, uint32_t frequency)
{
    (void)channel;
    d_setFrequencyCount++;
    d_lastSetFrequency = frequency;
}

static uint32_t d_gpioCount;
static HAL_GPIO_channel_E d_gpioChannel;
static bool d_gpioActive;

void HAL_GPIO_setActive(HAL_GPIO_channel_E channel, bool active)
{
    d_gpioCount++;
    d_gpioChannel = channel;
    d_gpioActive = active;
}

/* global_timeus is provided by mock_propeller2.c (HAL_time_getUs). */
extern uint32_t global_timeus;
extern void HAL_lock_mock_reset(void);
extern int _stdio_debug_lock;

/* Module under test after doubles. */
#include "../../src/DEV/dev_servo.c"

#define CH DEV_SERVO_CHANNEL_MAIN

static void doubles_reset(void)
{
    d_encoderValue = 0;
    d_encoderSetCount = 0;
    d_encoderLastSet = 0;
    d_startVelocityCount = 0U;
    d_startVelocityFreq = 0U;
    d_setFrequencyCount = 0U;
    d_lastSetFrequency = 0U;
    d_stopCount = 0U;
    d_runCount = 0U;
    d_run_delta = 0U;
    d_gpioCount = 0U;
    d_gpioChannel = HAL_GPIO_COUNT;
    d_gpioActive = false;
    d_midTickHook = NULL;
    d_carriage = 0.0;
    global_timeus = 0U;
}

static void servo_init(void)
{
    HAL_lock_mock_reset();
    _stdio_debug_lock = HAL_lock_create();
    doubles_reset();
    memset(&dev_servo_data, 0, sizeof(dev_servo_data));
    /* maxVelocity/maxAccel > 0 so tests use deterministic profile limits. */
    dev_servo_init(HAL_lock_create(), 100000 /* counts/s */, 500000 /* counts/s^2 */);
}

void setUp(void)
{
    HAL_lock_mock_reset();
    _stdio_debug_lock = HAL_lock_create();
    global_timeus = 0U;
}

void tearDown(void) {}

/* Advance the control loop by one nominal tick (1 ms default). */
static void tick(void)
{
    global_timeus += 1000U;
    dev_servo_run();
}

static void tick_with_motion(void)
{
    global_timeus += 1000U;
    dev_servo_run();
    if (d_startVelocityCount > 0U)
    {
        const double dir = d_gpioActive ? -1.0 : 1.0;
        d_carriage += dir * (double)d_lastSetFrequency * 0.001;
        d_encoderValue = (int32_t)(d_carriage < 0.0 ? (d_carriage - 0.5) : (d_carriage + 0.5));
    }
}

/* Drive the loop until it reports arrival, or give up. Returns ticks consumed. */
static int settle(int maxTicks)
{
    int ticks = 0;
    while ((ticks < maxTicks) && !dev_servo_atTarget(CH))
    {
        tick_with_motion();
        ticks++;
    }
    return ticks;
}

/**********************************************************************
 * Tests
 **********************************************************************/

void test_dev_servo_initialStateDisabledAtTarget(void)
{
    VIBES_TEST("servo.starts-disabled-at-encoder",
               "src/DEV/dev_servo.c#dev_servo_init",
               "a motor drive just after start-up");
    VIBES_EXPECT("arrival-at-encoder", "the drive reports arrival at the encoder position");
    VIBES_EXPECT("no-stall", "no stall is reported");
    VIBES_EXPECT("at-rest", "the commanded speed and the following error are zero");
    servo_init();
    TEST_ASSERT_TRUE(dev_servo_atTarget(CH));
    TEST_ASSERT_FALSE(dev_servo_isStalled(CH));
    TEST_ASSERT_EQUAL_INT32(0, dev_servo_getPosition(CH));
    TEST_ASSERT_EQUAL_INT32(0, dev_servo_getVelocity(CH));
    TEST_ASSERT_EQUAL_INT32(0, dev_servo_getFollowingError(CH));
}

void test_dev_servo_disabledParksAndReportsEncoder(void)
{
    VIBES_TEST("servo.disabled-parks-at-encoder",
               "src/DEV/dev_servo.c#dev_servo_run",
               "a disabled motor drive whose encoder has moved since start-up, then one control tick");
    VIBES_EXPECT("position-follows-encoder", "the reported position follows the encoder");
    VIBES_EXPECT("arrival-reported", "the drive reports arrival");
    VIBES_EXPECT("zero-speed", "the commanded speed is zero");
    VIBES_EXPECT("no-pulse-train", "no pulse train starts");
    servo_init();
    d_encoderValue = 1234;
    tick();
    TEST_ASSERT_EQUAL_INT32(1234, dev_servo_getPosition(CH));
    TEST_ASSERT_TRUE(dev_servo_atTarget(CH));
    TEST_ASSERT_EQUAL_INT32(0, dev_servo_getVelocity(CH));
    /* No velocity train while disabled. */
    TEST_ASSERT_EQUAL_UINT32(0U, d_startVelocityCount);
}

void test_dev_servo_moveToStagesTarget(void)
{
    VIBES_TEST("servo.move-stages-target",
               "src/DEV/dev_servo.c#dev_servo_moveTo",
               "a disabled motor drive commanded to a new position");
    VIBES_EXPECT("target-recorded", "the new target is recorded at once");
    VIBES_EXPECT("position-stays-put", "the reported position stays put");
    servo_init();
    dev_servo_moveTo(CH, 5000, 10000);
    TEST_ASSERT_EQUAL_INT32(5000, dev_servo_getTarget(CH));
    /* Not applied until enable + run. */
    TEST_ASSERT_EQUAL_INT32(0, dev_servo_getPosition(CH));
}

void test_dev_servo_moveToInvalidFeedrateUsesMax(void)
{
    VIBES_TEST("servo.invalid-speed-uses-max",
               "src/DEV/dev_servo.c#dev_servo_moveTo",
               "a position command with a zero speed, then one above the drive maximum");
    VIBES_EXPECT_WHY("max-speed-used",
                     "each is driven at the drive's configured maximum speed",
                     "every position command still moves; a missing or oversize speed takes the configured maximum");
    servo_init();
    /* 0 and oversize clamp to maxVelocity (100000 from init). */
    dev_servo_moveTo(CH, 100, 0);
    TEST_ASSERT_EQUAL_INT32(100000, dev_servo_data.channel[CH].req.feedrate);
    dev_servo_moveTo(CH, 100, 999999);
    TEST_ASSERT_EQUAL_INT32(100000, dev_servo_data.channel[CH].req.feedrate);
}

void test_dev_servo_atTargetWhenEncoderSettledOnTarget(void)
{
    VIBES_TEST("servo.arrived-when-already-on-target",
               "src/DEV/dev_servo.c#dev_servo_run",
               "an enabled motor drive commanded to the position the encoder already reads, then one control tick");
    VIBES_EXPECT("arrival-reported", "the drive reports arrival");
    VIBES_EXPECT("zero-speed", "the drive commands zero speed");
    servo_init();
    d_encoderValue = 0;
    dev_servo_enable(CH, true);
    dev_servo_moveTo(CH, 0, 10000);
    tick();
    TEST_ASSERT_TRUE(dev_servo_atTarget(CH));
    TEST_ASSERT_EQUAL_INT32(0, dev_servo_getVelocity(CH));
}

void test_dev_servo_positionMoveCommandsVelocity(void)
{
    VIBES_TEST("servo.position-move-starts-pulse-train",
               "src/DEV/dev_servo.c#dev_servo_run",
               "an enabled motor drive commanded to a position away from the encoder");
    VIBES_EXPECT("pulse-train-started", "the drive starts a pulse train toward the target");
    VIBES_EXPECT("no-arrival", "the drive reports no arrival");
    servo_init();
    d_encoderValue = 0;
    dev_servo_enable(CH, true);
    dev_servo_moveTo(CH, 10000, 20000);
    tick();
    /* Should be ramping toward target — non-zero command and velocity train. */
    TEST_ASSERT_FALSE(dev_servo_atTarget(CH));
    TEST_ASSERT_TRUE(dev_servo_getVelocity(CH) != 0 || d_startVelocityCount > 0U);
    TEST_ASSERT_TRUE(d_startVelocityCount + d_setFrequencyCount > 0U);
}

void test_dev_servo_velocityModeCommandsPulseTrain(void)
{
    VIBES_TEST("servo.speed-command-starts-pulse-train",
               "src/DEV/dev_servo.c#dev_servo_run",
               "an enabled motor drive commanded to hold a non-zero speed");
    VIBES_EXPECT("pulse-train-started", "the drive starts a pulse train");
    VIBES_EXPECT("non-zero-speed", "the drive reports a non-zero commanded speed");
    servo_init();
    d_encoderValue = 0;
    dev_servo_enable(CH, true);
    dev_servo_setVelocity(CH, 5000);
    /* Several ticks so accel ramp reaches a non-trivial command. */
    for (int i = 0; i < 20; i++)
    {
        tick();
    }
    TEST_ASSERT_TRUE(d_startVelocityCount > 0U);
    TEST_ASSERT_TRUE(dev_servo_getVelocity(CH) != 0);
}

void test_dev_servo_stopRequestsZeroVelocityTarget(void)
{
    VIBES_TEST("servo.stop-holds-at-rest",
               "src/DEV/dev_servo.c#dev_servo_stop",
               "an enabled motor drive holding a non-zero speed, then a stop, with the encoder free to follow");
    VIBES_EXPECT("holds-zero-speed", "the drive holds a speed of zero");
    VIBES_EXPECT_WHY("winds-down-to-rest",
                     "the commanded speed winds down to rest",
                     "stopping is a speed hold at rest, so the carriage decelerates under the same accel limit as any other speed change");
    servo_init();
    d_encoderValue = 0;
    dev_servo_enable(CH, true);
    dev_servo_setVelocity(CH, 8000);
    for (int i = 0; i < 10; i++)
    {
        tick();
    }
    TEST_ASSERT_TRUE(dev_servo_getVelocity(CH) != 0);

    dev_servo_stop(CH);
    /* stop() is a velocity-mode hold at 0 — stages targetVel, does not instantly
     * zero the closed-loop command (Kp still fights frozen-encoder error). */
    TEST_ASSERT_EQUAL_INT(DEV_SERVO_MODE_VELOCITY, dev_servo_data.channel[CH].req.mode);
    TEST_ASSERT_EQUAL_INT32(0, dev_servo_data.channel[CH].req.targetVel);

    /* When the encoder is free to track the setpoint, command winds down to 0. */
    for (int i = 0; i < 100; i++)
    {
        /* Ideal plant: encoder snaps toward setpoint each tick. */
        d_encoderValue = (int32_t)dev_servo_data.channel[CH].setpointPos;
        tick();
    }
    TEST_ASSERT_EQUAL_INT32(0, dev_servo_getVelocity(CH));
}

void test_dev_servo_setPositionUpdatesEncoderAndTarget(void)
{
    VIBES_TEST("servo.set-position-redefines-origin",
               "src/DEV/dev_servo.c#dev_servo_setPosition",
               "a motor drive whose origin is set to a new encoder count");
    VIBES_EXPECT("encoder-written", "the drive writes that count to the encoder");
    VIBES_EXPECT("target-adopted", "the drive adopts that count as the target");
    servo_init();
    dev_servo_setPosition(CH, 4096);
    TEST_ASSERT_EQUAL_INT32(4096, d_encoderLastSet);
    TEST_ASSERT_EQUAL_INT32(4096, d_encoderValue);
    TEST_ASSERT_EQUAL_INT32(4096, dev_servo_getTarget(CH));
}

void test_dev_servo_followingErrorReflectsOffset(void)
{
    VIBES_TEST("servo.encoder-lag-grows-while-frozen",
               "src/DEV/dev_servo.c#dev_servo_run",
               "an enabled motor drive commanded to a distant position while the encoder stays frozen");
    VIBES_EXPECT("gap-grows", "the drive reports a growing gap between the commanded position and the encoder");
    servo_init();
    d_encoderValue = 0;
    dev_servo_enable(CH, true);
    dev_servo_moveTo(CH, 50000, 50000);
    /* Advance setpoint without moving encoder → following error grows. */
    for (int i = 0; i < 30; i++)
    {
        tick();
    }
    TEST_ASSERT_TRUE(dev_servo_getFollowingError(CH) > 0);
}

void test_dev_servo_stallWhenCommandedWithoutMotion(void)
{
    VIBES_TEST("servo.stall-when-commanded-without-motion",
               "src/DEV/dev_servo.c#dev_servo_run",
               "an enabled motor drive commanded at high speed while the encoder stays frozen for longer than the stall window");
    VIBES_EXPECT_WHY("stall-reported",
                     "the drive reports a stall",
                     "a jammed carriage is reported as a stall so the controller can stop pulling against the jam");
    servo_init();
    d_encoderValue = 0; /* frozen encoder */
    dev_servo_enable(CH, true);
    /* High velocity so |cmd| > stallVelocity (default 4096). */
    dev_servo_setVelocity(CH, 20000);
    /* stallTicks default = 200. */
    for (int i = 0; i < 250; i++)
    {
        tick();
    }
    TEST_ASSERT_TRUE(dev_servo_isStalled(CH));
}

void test_dev_servo_disableClearsStallAndParks(void)
{
    VIBES_TEST("servo.disable-clears-stall",
               "src/DEV/dev_servo.c#dev_servo_run",
               "a stalled motor drive that is disabled, then one control tick");
    VIBES_EXPECT_WHY("stall-cleared",
                     "the stall clears",
                     "disabling is how an operator recovers from a stall after clearing the jam");
    VIBES_EXPECT("arrival-reported", "the drive reports arrival");
    VIBES_EXPECT("zero-speed", "the commanded speed is zero");
    servo_init();
    d_encoderValue = 0;
    dev_servo_enable(CH, true);
    dev_servo_setVelocity(CH, 20000);
    for (int i = 0; i < 250; i++)
    {
        tick();
    }
    TEST_ASSERT_TRUE(dev_servo_isStalled(CH));

    dev_servo_enable(CH, false);
    tick();
    TEST_ASSERT_FALSE(dev_servo_isStalled(CH));
    TEST_ASSERT_TRUE(dev_servo_atTarget(CH));
    TEST_ASSERT_EQUAL_INT32(0, dev_servo_getVelocity(CH));
}


/**********************************************************************
 * Liveness — what APP gates the machine on
 **********************************************************************/

/* The MOTOR cog owns the only call site of dev_servo_run(); until it has ticked
 * once the driver cannot claim to be servicing the actuator. app_control gates
 * FAULT_SERVO_COMMUNICATION on this. */
void test_dev_servo_isReadyFalseUntilFirstTick(void)
{
    VIBES_TEST("servo.ready-after-first-tick",
               "src/DEV/dev_servo.c#dev_servo_isReady",
               "a motor drive just after start-up, then after one control tick");
    VIBES_EXPECT_WHY("unready-at-first",
                     "the drive reports unready at first",
                     "the controller treats a silent drive as a communication fault");
    VIBES_EXPECT_WHY("ready-after-tick",
                     "the drive reports ready after that tick",
                     "the controller treats an answering drive as the motor loop running");
    servo_init();
    TEST_ASSERT_FALSE(dev_servo_isReady(CH));
    tick();
    TEST_ASSERT_TRUE(dev_servo_isReady(CH));
}

/* Disabled is not dead: the loop is still ticking, so the machine must not read
 * a communication fault just because motion is off. */
void test_dev_servo_isReadyTrueWhileDisabledButTicking(void)
{
    VIBES_TEST("servo.ready-while-disabled-and-ticking",
               "src/DEV/dev_servo.c#dev_servo_isReady",
               "a disabled motor drive whose control loop has ticked");
    VIBES_EXPECT_WHY("ready-reported",
                     "the drive reports ready",
                     "parking the drive still counts as the motor loop answering, so a parked machine stays free of a communication fault");
    servo_init();
    dev_servo_enable(CH, false);
    tick();
    TEST_ASSERT_TRUE(dev_servo_isReady(CH));
}

void test_dev_servo_isReadyRejectsOutOfRangeChannel(void)
{
    VIBES_TEST("servo.ready-rejects-unknown-channel",
               "src/DEV/dev_servo.c#dev_servo_isReady",
               "a readiness check for a motor-drive channel that does not exist");
    VIBES_EXPECT("answers-unready", "the machine answers unready");
    servo_init();
    tick();
    TEST_ASSERT_FALSE(dev_servo_isReady(DEV_SERVO_CHANNEL_COUNT));
}

/**********************************************************************
 * atTarget — the flag app_motion retires a move on
 **********************************************************************/

/* REGRESSION: a new target must invalidate the previous verdict IMMEDIATELY —
 * before the MOTOR cog has had a chance to tick. app_motion issues the move and
 * polls atTarget on its very next cycle; if the stale "parked at the last
 * target" true survives, the move is retired without the gantry moving, the
 * recording stops early and the profile's path comes up short. */
void test_dev_servo_newMoveClearsPreviousArrivalBeforeAnyTick(void)
{
    VIBES_TEST("servo.new-move-clears-arrival",
               "src/DEV/dev_servo.c#dev_servo_moveTo",
               "a motor drive parked on a target, then commanded to a different position, before the next control tick");
    VIBES_EXPECT_WHY("no-arrival",
                     "the drive reports no arrival",
                     "the motion controller retires a move on arrival, so a new target is judged unarrived until the control loop has evaluated that target");
    servo_init();
    dev_servo_enable(CH, true);
    dev_servo_moveTo(CH, 8192, 40960);
    (void)settle(4000);
    TEST_ASSERT_TRUE(dev_servo_atTarget(CH)); /* parked on the first target */

    dev_servo_moveTo(CH, 16384, 40960);        /* a second, different target */
    TEST_ASSERT_FALSE(dev_servo_atTarget(CH)); /* no tick yet => cannot have arrived */
}

/* Same hazard, narrower window: the command lands INSIDE a tick, after the loop
 * snapshotted the old target but before it publishes its verdict. The published
 * verdict must not be attributed to the new target. */
static void issue_new_move_midtick(void) { dev_servo_moveTo(CH, 16384, 40960); }

void test_dev_servo_commandLandingMidtickIsNotReportedAsArrival(void)
{
    VIBES_TEST("servo.mid-tick-command-clears-arrival",
               "src/DEV/dev_servo.c#dev_servo_run",
               "a motor drive parked on a target, with a new position command landing during the next control tick");
    VIBES_EXPECT_WHY("no-arrival",
                     "the drive reports no arrival after that tick",
                     "arrival is published only for the target the loop actually evaluated, so a command that arrives during a tick is judged on the next one");
    VIBES_EXPECT("new-target-recorded", "the drive records the new target");
    servo_init();
    dev_servo_enable(CH, true);
    dev_servo_moveTo(CH, 8192, 40960);
    (void)settle(4000);
    TEST_ASSERT_TRUE(dev_servo_atTarget(CH));

    /* This tick would otherwise publish atTarget=true for the OLD target. */
    d_midTickHook = issue_new_move_midtick;
    tick();
    TEST_ASSERT_FALSE(dev_servo_atTarget(CH));
    TEST_ASSERT_EQUAL_INT32(16384, dev_servo_getTarget(CH));
}

void test_dev_servo_setVelocityClearsArrival(void)
{
    VIBES_TEST("servo.speed-command-clears-arrival",
               "src/DEV/dev_servo.c#dev_servo_setVelocity",
               "a motor drive parked on a position target, then commanded to a non-zero speed");
    VIBES_EXPECT_WHY("arrival-dropped",
                     "the drive stops reporting arrival at once, before the next control tick",
                     "the motion controller retires a move on arrival, so leaving a position target drops that arrival at once");
    servo_init();
    dev_servo_enable(CH, true);
    dev_servo_moveTo(CH, 8192, 40960);
    (void)settle(4000);
    TEST_ASSERT_TRUE(dev_servo_atTarget(CH));

    dev_servo_setVelocity(CH, 4096);
    TEST_ASSERT_FALSE(dev_servo_atTarget(CH));
}

void test_dev_servo_stopClearsArrival(void)
{
    VIBES_TEST("servo.stop-clears-arrival",
               "src/DEV/dev_servo.c#dev_servo_stop",
               "a motor drive parked on a position target, then stopped");
    VIBES_EXPECT_WHY("arrival-dropped",
                     "the drive stops reporting arrival at once, before the next control tick",
                     "the motion controller retires a move on arrival, so a stop drops that arrival at once");
    servo_init();
    dev_servo_enable(CH, true);
    dev_servo_moveTo(CH, 8192, 40960);
    (void)settle(4000);
    TEST_ASSERT_TRUE(dev_servo_atTarget(CH));

    dev_servo_stop(CH);
    TEST_ASSERT_FALSE(dev_servo_atTarget(CH));
}

/* Homing re-defines the coordinate frame, which moves the target with it, so the
 * previous verdict no longer describes anything the caller can act on. */
void test_dev_servo_setPositionClearsArrival(void)
{
    VIBES_TEST("servo.set-position-clears-arrival",
               "src/DEV/dev_servo.c#dev_servo_setPosition",
               "a motor drive parked on a target, then given a new origin at the current encoder, then one control tick");
    VIBES_EXPECT_WHY("arrival-dropped",
                     "the drive reports no arrival at once",
                     "homing moves the target with the origin, so arrival is judged again in the new frame");
    VIBES_EXPECT("arrival-at-new-origin", "the drive reports arrival at the new origin after the tick");
    servo_init();
    dev_servo_enable(CH, true);
    dev_servo_moveTo(CH, 8192, 40960);
    (void)settle(4000);
    TEST_ASSERT_TRUE(dev_servo_atTarget(CH));

    dev_servo_setPosition(CH, 0);
    TEST_ASSERT_FALSE(dev_servo_atTarget(CH));
    /* With target == position the loop re-confirms arrival on the next tick. */
    tick();
    TEST_ASSERT_TRUE(dev_servo_atTarget(CH));
}

/* REGRESSION: the approach must CONVERGE, not hunt. The braking law
 * v = sqrt(2*a*d) is singular at the target — for a sub-count remainder it still
 * demands hundreds of counts/s, so without a one-tick-reach cap the setpoint
 * steps over the target every tick and oscillates forever. The encoder parks
 * inside the deadband but the profile never winds down, so atTarget never
 * latches and the move is retired only if some later tick happens to land in
 * the window: moves that "sometimes take 3 s and sometimes 15 s". */
void test_dev_servo_moveSettlesDeterministicallyWithoutHunting(void)
{
    VIBES_TEST("servo.move-settles-on-target",
               "src/DEV/dev_servo.c#dev_servo_run",
               "an enabled motor drive commanded to several positions that do not land on a tick boundary");
    VIBES_EXPECT_WHY("arrival-in-bounded-time",
                     "the drive reports arrival in bounded time",
                     "the last tick of a move covers only the remaining distance, so the profile lands on the target and arrival is reported in bounded time");
    VIBES_EXPECT("profile-at-rest", "the profile ends at rest");
    VIBES_EXPECT("profile-on-target", "the profile ends on the target");
    VIBES_EXPECT("encoder-in-settle-window", "the encoder ends inside the settle window");
    servo_init();
    dev_servo_enable(CH, true);
    /* Distances that do not divide evenly into a tick's travel, so the final
     * approach lands mid-tick. */
    const int32_t targets[] = { 8192, 20000, 20001, 4097 };
    for (unsigned t = 0; t < (sizeof(targets) / sizeof(targets[0])); t++)
    {
        dev_servo_moveTo(CH, targets[t], 40960);
        const int ticks = settle(4000);
        TEST_ASSERT_TRUE_MESSAGE(dev_servo_atTarget(CH), "move never reported arrival");
        TEST_ASSERT_TRUE_MESSAGE(ticks < 4000, "move hunted instead of settling");
        /* The shaped profile is at rest exactly on the target. */
        TEST_ASSERT_FLOAT_WITHIN(1.0f, 0.0f, dev_servo_data.channel[CH].setpointVel);
        TEST_ASSERT_FLOAT_WITHIN(1.0f, (float)targets[t], dev_servo_data.channel[CH].setpointPos);
        TEST_ASSERT_INT32_WITHIN(dev_servo_channelConfig[CH].positionDeadband, targets[t], d_encoderValue);
    }
}

/* ---------------------------------------------------------------------------
 * Why the G123 waveform cannot stream velocity open-loop.
 *
 * The question this answers is "is the waveform anchor in app_motion actually
 * needed, or is it propping up a simulator?" -- so it is deliberately posed
 * where no simulator can reach: `tick_with_motion` makes the encoder follow
 * the commanded step rate EXACTLY. A perfect plant, a perfect encoder, no
 * embsim, no ISS, no QEMU. Whatever drifts here drifts in arithmetic that
 * lives in dev_servo.c and runs the same on a P2.
 *
 * A position sinusoid asks for its peak velocity at t=0. The accel limiter at
 * dev_servo.c's "trapezoid ramp" cannot deliver a step, so `setpointVel` lags
 * on the way in -- and `setpointPos`, which is the firmware's OWN integrated
 * reference, integrates the LIMITED velocity rather than the commanded one.
 * Velocity mode never compares that reference to anything, so the shortfall is
 * permanent: Vpeak^2 / (2 * maxAccel).
 * ------------------------------------------------------------------------- */

/* Stream one open-loop waveform and return where the carriage ended up, in
 * counts, relative to where it started. A whole number of cycles of a sine
 * must end where it began. */
static double stream_open_loop_waveform(double amplitudeCounts, double freqHz, unsigned cycles)
{
    const double twoPi = 6.283185307179586;
    const double omega = twoPi * freqHz;
    const double dt = 0.001; /* tick() is 1 ms */
    const unsigned ticks = (unsigned)((double)cycles / freqHz / dt);

    dev_servo_enable(CH, true);
    for (unsigned i = 0U; i < ticks; i++)
    {
        const double t = (double)i * dt;
        /* Exactly what app_motion streamed before the anchor: the analytic
         * derivative of the position sinusoid, and nothing else. */
        const double vel = omega * amplitudeCounts * cos(omega * t);
        dev_servo_setVelocity(CH, (int32_t)vel);
        tick_with_motion();
    }
    return d_carriage;
}

void test_open_loop_waveform_velocity_leaves_a_permanent_position_deficit(void)
{
    VIBES_TEST("servo.open-loop-waveform-sags",
               "src/DEV/dev_servo.c#dev_servo_run",
               "a position sinusoid streamed as velocity alone, with a perfect encoder");
    VIBES_EXPECT_WHY("ends-below-where-it-started",
                     "the carriage ends a whole cycle below where it began",
                     "the accelerometer-limited ramp-in is integrated into the servo's own position reference and velocity mode never compares that reference to anything, so the shortfall is never recovered");

    servo_init();
    dev_servo_setPosition(CH, 0);

    /* Chosen to sit inside the fixture's envelope (maxVel 100000 counts/s,
     * maxAccel 500000 counts/s^2) while still demanding a real ramp-in. */
    const double amplitude = 10000.0; /* counts */
    const double freq = 1.0;          /* Hz    */
    const double omega = 6.283185307179586 * freq;
    const double vPeak = omega * amplitude;
    const double predictedDeficit = (vPeak * vPeak) / (2.0 * 500000.0);

    const double ended = stream_open_loop_waveform(amplitude, freq, 2U);

    /* Two whole cycles: the ideal trajectory returns to its start exactly. */
    TEST_ASSERT_TRUE_MESSAGE(ended < -0.5 * predictedDeficit,
                             "a whole number of cycles must return to the start, and this does not");

    /* And it is the ramp-in deficit, not noise: within 35% of Vpeak^2/(2a). */
    const double ratio = (-ended) / predictedDeficit;
    printf("  open-loop waveform: ended %.0f counts below start; "
           "Vpeak^2/(2a) predicts %.0f (ratio %.2f)\n",
           -ended, predictedDeficit, ratio);
    TEST_ASSERT_TRUE_MESSAGE(ratio > 0.65 && ratio < 1.35,
                             "the shortfall must match the analytic ramp-in deficit");
}

int main(void)
{
    UNITY_BEGIN();
    RUN_TEST(test_dev_servo_initialStateDisabledAtTarget);
    RUN_TEST(test_dev_servo_disabledParksAndReportsEncoder);
    RUN_TEST(test_dev_servo_moveToStagesTarget);
    RUN_TEST(test_dev_servo_moveToInvalidFeedrateUsesMax);
    RUN_TEST(test_dev_servo_atTargetWhenEncoderSettledOnTarget);
    RUN_TEST(test_dev_servo_positionMoveCommandsVelocity);
    RUN_TEST(test_dev_servo_velocityModeCommandsPulseTrain);
    RUN_TEST(test_dev_servo_stopRequestsZeroVelocityTarget);
    RUN_TEST(test_dev_servo_setPositionUpdatesEncoderAndTarget);
    RUN_TEST(test_dev_servo_followingErrorReflectsOffset);
    RUN_TEST(test_dev_servo_stallWhenCommandedWithoutMotion);
    RUN_TEST(test_dev_servo_disableClearsStallAndParks);

    RUN_TEST(test_dev_servo_isReadyFalseUntilFirstTick);
    RUN_TEST(test_dev_servo_isReadyTrueWhileDisabledButTicking);
    RUN_TEST(test_dev_servo_isReadyRejectsOutOfRangeChannel);

    RUN_TEST(test_dev_servo_newMoveClearsPreviousArrivalBeforeAnyTick);
    RUN_TEST(test_dev_servo_commandLandingMidtickIsNotReportedAsArrival);
    RUN_TEST(test_dev_servo_setVelocityClearsArrival);
    RUN_TEST(test_dev_servo_stopClearsArrival);
    RUN_TEST(test_dev_servo_setPositionClearsArrival);
    RUN_TEST(test_dev_servo_moveSettlesDeterministicallyWithoutHunting);
    RUN_TEST(test_open_loop_waveform_velocity_leaves_a_permanent_position_deficit);
    return UNITY_END();
}
