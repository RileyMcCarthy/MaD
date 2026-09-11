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
    VIBES_BEHAVIOUR("servo.starts-disabled-at-encoder",
                    "src/DEV/dev_servo.c#dev_servo_init",
                    "a motor drive just after start-up",
                    "a freshly started motor drive is disabled, arrived at the encoder position, with zero speed and no stall");
    servo_init();
    TEST_ASSERT_TRUE(dev_servo_atTarget(CH));
    TEST_ASSERT_FALSE(dev_servo_isStalled(CH));
    TEST_ASSERT_EQUAL_INT32(0, dev_servo_getPosition(CH));
    TEST_ASSERT_EQUAL_INT32(0, dev_servo_getVelocity(CH));
    TEST_ASSERT_EQUAL_INT32(0, dev_servo_getFollowingError(CH));
}

void test_dev_servo_disabledParksAndReportsEncoder(void)
{
    VIBES_BEHAVIOUR("servo.disabled-parks-at-encoder",
                    "src/DEV/dev_servo.c#dev_servo_run",
                    "a disabled motor drive whose encoder has moved since start-up, then one control tick",
                    "a disabled motor drive parks at the encoder, reports that position as arrived, and leaves the pulse train stopped");
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
    VIBES_BEHAVIOUR("servo.move-stages-target",
                    "src/DEV/dev_servo.c#dev_servo_moveTo",
                    "a disabled motor drive commanded to a new position",
                    "a position command records the new target immediately, while the carriage stays put until the drive is enabled and the loop ticks");
    servo_init();
    dev_servo_moveTo(CH, 5000, 10000);
    TEST_ASSERT_EQUAL_INT32(5000, dev_servo_getTarget(CH));
    /* Not applied until enable + run. */
    TEST_ASSERT_EQUAL_INT32(0, dev_servo_getPosition(CH));
}

void test_dev_servo_moveToInvalidFeedrateUsesMax(void)
{
    VIBES_BEHAVIOUR_WHY("servo.invalid-speed-uses-max",
                        "src/DEV/dev_servo.c#dev_servo_moveTo",
                        "a position command with a zero speed, then one above the drive maximum",
                        "a position command whose speed is zero or above the drive maximum is driven at the motor drive maximum speed",
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
    VIBES_BEHAVIOUR("servo.arrived-when-already-on-target",
                    "src/DEV/dev_servo.c#dev_servo_run",
                    "an enabled motor drive commanded to the position the encoder already reads",
                    "an enabled motor drive already on the commanded position reports arrival and holds still");
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
    VIBES_BEHAVIOUR("servo.position-move-starts-pulse-train",
                    "src/DEV/dev_servo.c#dev_servo_run",
                    "an enabled motor drive commanded to a position away from the encoder",
                    "a position command away from the encoder starts a pulse train toward the target");
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
    VIBES_BEHAVIOUR("servo.speed-command-starts-pulse-train",
                    "src/DEV/dev_servo.c#dev_servo_run",
                    "an enabled motor drive commanded to hold a non-zero speed",
                    "a speed command starts a pulse train and the motor drive reports a non-zero commanded speed");
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
    VIBES_BEHAVIOUR_WHY("servo.stop-holds-at-rest",
                        "src/DEV/dev_servo.c#dev_servo_stop",
                        "an enabled motor drive holding a non-zero speed, then a stop, with the encoder free to follow",
                        "a stop requests a speed of zero, and commanded speed winds down to rest once the encoder tracks the commanded position",
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
    VIBES_BEHAVIOUR("servo.set-position-redefines-origin",
                    "src/DEV/dev_servo.c#dev_servo_setPosition",
                    "a motor drive whose origin is set to a new encoder count",
                    "setting the motor drive origin writes that count to the encoder and to the target");
    servo_init();
    dev_servo_setPosition(CH, 4096);
    TEST_ASSERT_EQUAL_INT32(4096, d_encoderLastSet);
    TEST_ASSERT_EQUAL_INT32(4096, d_encoderValue);
    TEST_ASSERT_EQUAL_INT32(4096, dev_servo_getTarget(CH));
}

void test_dev_servo_followingErrorReflectsOffset(void)
{
    VIBES_BEHAVIOUR("servo.encoder-lag-grows-while-frozen",
                    "src/DEV/dev_servo.c#dev_servo_run",
                    "an enabled motor drive commanded to a distant position while the encoder stays frozen",
                    "the gap between the commanded position and the encoder grows while the encoder stays still and the command advances toward the target");
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
    VIBES_BEHAVIOUR_WHY("servo.stall-when-commanded-without-motion",
                        "src/DEV/dev_servo.c#dev_servo_run",
                        "an enabled motor drive commanded at high speed while the encoder stays frozen for longer than the stall window",
                        "commanding motion while the encoder stays still is reported as a stall",
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
    VIBES_BEHAVIOUR_WHY("servo.disable-clears-stall",
                        "src/DEV/dev_servo.c#dev_servo_run",
                        "a stalled motor drive that is then disabled",
                        "disabling a stalled motor drive clears the stall, parks at the encoder, and reports arrival",
                        "disabling is how an operator recovers from a stall after clearing the jam");
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
    VIBES_BEHAVIOUR_WHY("servo.ready-after-first-tick",
                        "src/DEV/dev_servo.c#dev_servo_isReady",
                        "a motor drive just after start-up, then after one control tick",
                        "a motor drive reports unready until the control loop has ticked once, and ready from then on",
                        "the controller treats an answering drive as the motor loop running, and a silent drive as a communication fault");
    servo_init();
    TEST_ASSERT_FALSE(dev_servo_isReady(CH));
    tick();
    TEST_ASSERT_TRUE(dev_servo_isReady(CH));
}

/* Disabled is not dead: the loop is still ticking, so the machine must not read
 * a communication fault just because motion is off. */
void test_dev_servo_isReadyTrueWhileDisabledButTicking(void)
{
    VIBES_BEHAVIOUR_WHY("servo.ready-while-disabled-and-ticking",
                        "src/DEV/dev_servo.c#dev_servo_isReady",
                        "a disabled motor drive whose control loop has ticked",
                        "a disabled motor drive whose control loop is still ticking reports ready",
                        "parking the drive still counts as the motor loop answering, so a parked machine stays free of a communication fault");
    servo_init();
    dev_servo_enable(CH, false);
    tick();
    TEST_ASSERT_TRUE(dev_servo_isReady(CH));
}

void test_dev_servo_isReadyRejectsOutOfRangeChannel(void)
{
    VIBES_BEHAVIOUR("servo.ready-rejects-unknown-channel",
                    "src/DEV/dev_servo.c#dev_servo_isReady",
                    "a readiness check for a motor-drive channel that does not exist",
                    "a motor-drive channel that does not exist is reported as unready");
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
    VIBES_BEHAVIOUR_WHY("servo.new-move-clears-arrival",
                        "src/DEV/dev_servo.c#dev_servo_moveTo",
                        "a motor drive parked on a target, then commanded to a different position, before the next control tick",
                        "a new position target clears the previous arrival immediately, before the control loop ticks",
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
    VIBES_BEHAVIOUR_WHY("servo.mid-tick-command-clears-arrival",
                        "src/DEV/dev_servo.c#dev_servo_run",
                        "a motor drive parked on a target, with a new position command landing during the next control tick",
                        "a position command that lands mid-tick keeps arrival clear, and the new target is recorded",
                        "arrival is published only for the target the loop actually evaluated, so a command that arrives during a tick is judged on the next one");
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
    VIBES_BEHAVIOUR_WHY("servo.speed-command-clears-arrival",
                        "src/DEV/dev_servo.c#dev_servo_setVelocity",
                        "a motor drive parked on a position target, then commanded to a non-zero speed",
                        "a speed command issued after arrival clears that arrival immediately",
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
    VIBES_BEHAVIOUR_WHY("servo.stop-clears-arrival",
                        "src/DEV/dev_servo.c#dev_servo_stop",
                        "a motor drive parked on a position target, then stopped",
                        "a stop issued after arrival clears that arrival immediately",
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
    VIBES_BEHAVIOUR_WHY("servo.set-position-clears-arrival",
                        "src/DEV/dev_servo.c#dev_servo_setPosition",
                        "a motor drive parked on a target, then given a new origin at the current encoder, then one control tick",
                        "redefining the encoder origin clears the previous arrival immediately, then the next tick reports arrival at that origin",
                        "homing moves the target with the origin, so arrival is judged again in the new frame");
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
    VIBES_BEHAVIOUR_WHY("servo.move-settles-on-target",
                        "src/DEV/dev_servo.c#dev_servo_run",
                        "an enabled motor drive commanded to several positions that do not land on a tick boundary",
                        "a position move arrives with the profile at rest on the target and the encoder inside the settle window, in bounded time",
                        "the last tick of a move covers only the remaining distance, so the profile lands on the target and arrival is reported in bounded time");
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
    return UNITY_END();
}
