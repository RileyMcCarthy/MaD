/*
 * Unit tests for src/DEV/dev_servo.c — closed-loop motion backend.
 *
 * Coverage:
 *   - init: disabled, atTarget, encoder position is source of truth
 *   - enable / disable idle park
 *   - moveTo stages target; invalid feedrate clamps to maxVelocity
 *   - atTarget when encoder is inside deadband and profile is settled
 *   - velocity mode commands a non-zero pulse train
 *   - stop requests velocity hold at 0
 *   - setPosition redefines encoder reference + target
 *   - following error reflects setpoint vs encoder
 *   - stall guard, two stages on the following error and a travel check on
 *     the pulses: past the 2 mm hard ceiling stalls at once (a reversed
 *     encoder, a jam at speed), held over the 1 mm soft band for 500 ms
 *     stalls (a carriage that falls behind), a brief excursion into the band
 *     does not, under a quarter of each 1 mm of pulsed travel stalls (a dead
 *     encoder, a jam near the target or at tensile speed, a crawl), and a
 *     carriage that follows -- even through a 20 ms drive lag and its coast
 *     past full-speed stops -- never stalls; a frame redefined mid-tick is
 *     not a stall
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
/* The same, but fired AFTER the reading is taken, so the tick carries on with
 * a reading from before the hook ran: another cog's command landing between
 * the encoder read and the following-error computation. */
static void (*d_afterReadHook)(void);

/* Sub-count-accurate carriage position for tick_with_motion(). Precision
 * matters — the slow final approach commands rates below one count per tick,
 * and integer truncation there would stall the carriage short of the deadband
 * and mask the settling behaviour under test. */
static double d_carriage;
static double d_carriageVel; /* counts/s, for tick_with_lag */
/* Faults for tick_with_lag: an encoder that stops counting while the carriage
 * goes on moving (a dead encoder, a slipped coupling), and a carriage that
 * stops while its encoder goes on reading it (a jam). */
static bool d_encoderStopped;
static bool d_carriageJammed;

int32_t HAL_encoder_value(HAL_encoder_channel_E ch)
{
    (void)ch;
    if (d_midTickHook != NULL)
    {
        void (*hook)(void) = d_midTickHook;
        d_midTickHook = NULL; /* one-shot */
        hook();
    }
    const int32_t reading = d_encoderValue;
    if (d_afterReadHook != NULL)
    {
        void (*hook)(void) = d_afterReadHook;
        d_afterReadHook = NULL; /* one-shot */
        hook();
    }
    return reading;
}
void HAL_encoder_set(HAL_encoder_channel_E ch, int32_t v)
{
    (void)ch;
    d_encoderSetCount++;
    d_encoderLastSet = v;
    d_encoderValue = v;
    /* Redefining the encoder frame moves the model's coordinate with it.
     * Without this the carriage keeps its old value and the very next tick
     * recomputes d_encoderValue from it, silently undoing the set -- which
     * made every test at a non-zero position quietly run at the origin. */
    d_carriage = (double)v;
}

static uint32_t d_startVelocityCount;
static uint32_t d_startVelocityFreq;
/* What the pulse engine is emitting RIGHT NOW. The call-recorders above say
 * what the driver asked for; this says what the carriage is actually doing,
 * and they are not the same thing: `stop` ends the pulse train, and
 * `startVelocity` (not `setFrequency`) is what carries the rate across a
 * direction flip, because applyVelocity stops and restarts to re-latch DIR. */
static uint32_t d_pulseRate;
static uint32_t d_setFrequencyCount;
static uint32_t d_lastSetFrequency;
static uint32_t d_stopCount;
static uint32_t d_runCount;
/* Pulses the running train has emitted since it was (re)started, as the real
 * engine counts them: rate x elapsed time, one control tick per read. */
static double d_emitted;

bool HAL_pulseOut_run(HAL_pulseOut_channel_E channel, uint32_t *pulses)
{
    (void)channel;
    d_runCount++;
    d_emitted += (double)d_pulseRate * 0.001;
    if (pulses != NULL)
    {
        *pulses = (uint32_t)d_emitted;
    }
    return false;
}

void HAL_pulseOut_stop(HAL_pulseOut_channel_E channel)
{
    (void)channel;
    d_stopCount++;
    d_pulseRate = 0U; /* a stopped train emits nothing -- the carriage rests */
}

void HAL_pulseOut_startVelocity(HAL_pulseOut_channel_E channel, uint32_t frequency)
{
    (void)channel;
    d_startVelocityCount++;
    d_startVelocityFreq = frequency;
    d_pulseRate = frequency;
    d_emitted = 0.0; /* a (re)started train counts from zero */
}

void HAL_pulseOut_setFrequency(HAL_pulseOut_channel_E channel, uint32_t frequency)
{
    (void)channel;
    d_setFrequencyCount++;
    d_lastSetFrequency = frequency;
    d_pulseRate = frequency;
}

static uint32_t d_gpioCount;
static HAL_GPIO_channel_E d_gpioChannel;
static bool d_gpioActive;
/* The drive-enable output is tracked on its own, so the direction capture
 * above (and any carriage model that reads it) sees direction writes only. */
static uint32_t d_enaCount;
static bool d_enaActive;

void HAL_GPIO_setActive(HAL_GPIO_channel_E channel, bool active)
{
    if (channel == HAL_GPIO_SERVO_ENA)
    {
        d_enaCount++;
        d_enaActive = active;
        return;
    }
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
    d_pulseRate = 0U;
    d_setFrequencyCount = 0U;
    d_lastSetFrequency = 0U;
    d_stopCount = 0U;
    d_runCount = 0U;
    d_emitted = 0.0;
    d_gpioCount = 0U;
    d_gpioChannel = HAL_GPIO_COUNT;
    d_gpioActive = false;
    d_enaCount = 0U;
    d_enaActive = false;
    d_midTickHook = NULL;
    d_afterReadHook = NULL;
    d_carriage = 0.0;
    d_carriageVel = 0.0;
    d_encoderStopped = false;
    d_carriageJammed = false;
    global_timeus = 0U;
}

/* A symmetric, dwell-free waveform -- the shape most tests want. */
#define WF(centre, amp, freq, cyc, shp)                                                            \
    (&(dev_servo_waveform_S){ .centreCounts = (centre),                                            \
                              .amplitudeCounts = (amp),                                            \
                              .freqMicroHz = (freq),                                               \
                              .cycles = (cyc),                                                     \
                              .dwellHighUs = 0U,                                                   \
                              .dwellLowUs = 0U,                                                    \
                              .skewPerMille = DEV_SERVO_SKEW_SYMMETRIC,                            \
                              .shape = (shp) })

/* The SHIPPED machine profile (dev_nvram_config.c): 50 mm/s and 600 mm/s^2
 * at 8192 counts/mm. Testing a gentler envelope than the one that ships
 * understates every error term that scales with acceleration. */
#define SHIPPED_MAX_VEL_COUNTS 409600
#define SHIPPED_MAX_ACCEL_COUNTS 4915200
#define SERVO_DT_S 0.001
/* 8192 counts per mm on this machine, so one micron is 8.192 counts. */
#define COUNTS_PER_MM 8192.0
#define ONE_MICRON_COUNTS (COUNTS_PER_MM / 1000.0)

/* `encoderPerMm`/`servoPerMm`: the profile's scales (0 = one count per pulse,
 * which is what the carriage model below delivers). */
static void servo_init_scaled(int32_t maxVelCounts, int32_t maxAccelCounts,
                              int32_t encoderPerMm, int32_t servoPerMm)
{
    HAL_lock_mock_reset();
    _stdio_debug_lock = HAL_lock_create();
    doubles_reset();
    memset(&dev_servo_data, 0, sizeof(dev_servo_data));
    dev_servo_init(HAL_lock_create(), maxVelCounts, maxAccelCounts, encoderPerMm, servoPerMm);
}

static void servo_init_envelope(int32_t maxVelCounts, int32_t maxAccelCounts)
{
    servo_init_scaled(maxVelCounts, maxAccelCounts, 0, 0);
}

static void servo_init(void)
{
    servo_init_envelope(SHIPPED_MAX_VEL_COUNTS, SHIPPED_MAX_ACCEL_COUNTS);
}

static int32_t counts_from_mm(double mm)
{
    return (int32_t)((mm * COUNTS_PER_MM) + ((mm < 0.0) ? -0.5 : 0.5));
}

/* setpointPos is a float: its ulp is 1 count at 2000 mm and 2 counts at
 * 3000 mm, so the commanded position cannot be finer than that. The 1 um
 * contract is on top of that floor, matching test_tracking_does_not_degrade. */
static double one_micron_bound_at(int32_t pos)
{
    const double p = fabs((double)pos);
    if (p < 1.0) { return ONE_MICRON_COUNTS; }
    const double ulp = ldexp(1.0, ilogb(p) - 23);
    return ONE_MICRON_COUNTS + (2.0 * ulp);
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
        d_carriage += dir * (double)d_pulseRate * 0.001;
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
    VIBES_EXPECT_WHY("enable-output-off",
                     "the drive's enable output is left for the first control tick to drive off",
                     "start-up runs on a different processor core from the control loop, and every core's level on a pin is combined, so a level held by the start-up core could keep the drive from ever being enabled");
    servo_init();
    TEST_ASSERT_EQUAL_UINT32(0U, d_enaCount);
    TEST_ASSERT_TRUE(dev_servo_atTarget(CH));
    TEST_ASSERT_FALSE(dev_servo_isStalled(CH));
    TEST_ASSERT_EQUAL_INT32(0, dev_servo_getPosition(CH));
    TEST_ASSERT_EQUAL_INT32(0, dev_servo_getVelocity(CH));
    TEST_ASSERT_EQUAL_INT32(0, dev_servo_getFollowingError(CH));
}

void test_dev_servo_firstTickDrivesEnableOutputOff(void)
{
    VIBES_TEST("servo.first-tick-drives-output-off",
               "src/DEV/dev_servo.c#dev_servo_run",
               "a motor drive just after start-up, still disabled, then several control ticks");
    VIBES_EXPECT_WHY("output-off",
                     "the drive's enable output is driven off at the first control tick",
                     "an undriven enable pin floats, and the isolator to the drive turns a floating input into enabled");
    VIBES_EXPECT("written-once",
                 "the enable output is written once, and left alone while the drive stays disabled");
    VIBES_EXPECT("no-pulse-train", "no pulse train starts");
    servo_init();
    d_enaActive = true; /* make the first write observable */
    tick();
    TEST_ASSERT_FALSE(d_enaActive);
    TEST_ASSERT_EQUAL_UINT32(1U, d_enaCount);
    for (int i = 0; i < 20; i++)
    {
        tick();
    }
    TEST_ASSERT_EQUAL_UINT32(1U, d_enaCount);
    TEST_ASSERT_EQUAL_UINT32(0U, d_startVelocityCount);
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
    /* 0 and oversize both clamp to the configured maximum -- read it rather
     * than restating it, so the fixture's envelope can change without a test
     * that merely repeats a constant going red. */
    const int32_t maxVel = dev_servo_channelConfig[CH].maxVelocity;
    dev_servo_moveTo(CH, 100, 0);
    TEST_ASSERT_EQUAL_INT32(maxVel, dev_servo_data.channel[CH].req.feedrate);
    dev_servo_moveTo(CH, 100, maxVel + 1);
    TEST_ASSERT_EQUAL_INT32(maxVel, dev_servo_data.channel[CH].req.feedrate);
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
    VIBES_EXPECT("drive-stays-enabled", "the drive's enable output stays on while it holds at rest");
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
        /* Ideal plant: encoder snaps toward setpoint each tick. ROUND, not
         * truncate -- a real encoder reports the nearest count, and truncating
         * leaves up to a count of standing error that Kp turns into a few
         * counts/s of command that never winds down. */
        const float sp = dev_servo_data.channel[CH].setpointPos;
        d_encoderValue = (int32_t)((sp < 0.0f) ? (sp - 0.5f) : (sp + 0.5f));
        tick();
    }
    TEST_ASSERT_EQUAL_INT32(0, dev_servo_getVelocity(CH));
    TEST_ASSERT_TRUE(d_enaActive);
}

void test_dev_servo_enableTurnsEnableOutputOn(void)
{
    VIBES_TEST("servo.enable-drives-output-on",
               "src/DEV/dev_servo.c#dev_servo_run",
               "a motor drive that is enabled, then several control ticks with the request unchanged");
    VIBES_EXPECT("output-on", "the drive's enable output turns on at the first control tick");
    VIBES_EXPECT_WHY("written-once",
                     "the enable output is written once, on the change, and left alone while the request holds",
                     "one cog owns the pin and touches it only when its level must change");
    servo_init();
    dev_servo_enable(CH, true);
    tick();
    TEST_ASSERT_TRUE(d_enaActive);
    for (int i = 0; i < 20; i++)
    {
        tick();
    }
    TEST_ASSERT_TRUE(d_enaActive);
    TEST_ASSERT_EQUAL_UINT32(1U, d_enaCount);
}

void test_dev_servo_enableActiveLowInvertsEnableOutput(void)
{
    VIBES_TEST("servo.enable-active-low",
               "src/DEV/dev_servo.c#dev_servo_setEnableActiveLow",
               "a motor drive whose enable input is set active low, through start-up, enable and disable");
    VIBES_EXPECT_WHY("disabled-high",
                     "the enable output is driven high at the first control tick, while the drive is disabled",
                     "most stepper drivers stop while their enable input is energized, so for them high is off");
    VIBES_EXPECT("enabled-low", "enabling the drive drives the enable output low");
    VIBES_EXPECT("disabled-high-again", "disabling it drives the output high again");
    servo_init();
    dev_servo_setEnableActiveLow(true);
    d_enaActive = false; /* make the first write observable */
    tick();
    TEST_ASSERT_TRUE(d_enaActive);
    dev_servo_enable(CH, true);
    tick();
    TEST_ASSERT_FALSE(d_enaActive);
    dev_servo_enable(CH, false);
    tick();
    TEST_ASSERT_TRUE(d_enaActive);
    TEST_ASSERT_EQUAL_UINT32(3U, d_enaCount);
}

void test_dev_servo_disableTurnsEnableOutputOff(void)
{
    VIBES_TEST("servo.disable-drives-output-off",
               "src/DEV/dev_servo.c#dev_servo_run",
               "an enabled motor drive holding a non-zero speed, then disabled for one control tick");
    VIBES_EXPECT("pulses-stop", "the pulse train stops");
    VIBES_EXPECT_WHY("output-off",
                     "the drive's enable output turns off",
                     "a fault, an emergency stop and a request to disable motion all reach the drive this way");
    servo_init();
    dev_servo_enable(CH, true);
    dev_servo_setVelocity(CH, 8000);
    for (int i = 0; i < 10; i++)
    {
        tick();
    }
    TEST_ASSERT_TRUE(d_enaActive);
    TEST_ASSERT_TRUE(d_startVelocityCount > 0U);
    const uint32_t stopsBefore = d_stopCount;
    dev_servo_enable(CH, false);
    tick();
    TEST_ASSERT_EQUAL_UINT32(stopsBefore + 1U, d_stopCount);
    TEST_ASSERT_FALSE(d_enaActive);
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

/* The stall guard's two stages, as dev_servo.c configures them: an error over
 * STALL_CEILING stalls at once, and one over STALL_BAND for STALL_BAND_TICKS
 * consecutive ticks stalls too. */
#define STALL_CEILING 16384      /* 2 mm */
#define STALL_BAND 8192          /* 1 mm */
#define STALL_BAND_TICKS 500

void test_dev_servo_stallWhenCommandedWithoutMotion(void)
{
    VIBES_TEST("servo.stall-when-commanded-without-motion",
               "src/DEV/dev_servo.c#dev_servo_run",
               "an enabled motor drive commanded at high speed while the encoder stays frozen");
    VIBES_EXPECT_WHY("stall-reported",
                     "the drive reports a stall",
                     "a jammed carriage is reported as a stall so the controller can stop pulling against the jam");
    servo_init();
    d_encoderValue = 0; /* frozen encoder */
    dev_servo_enable(CH, true);
    /* 20000 counts/s and more: the travel check judges the first 1 mm of
     * pulses, and the encoder has covered none of it. */
    dev_servo_setVelocity(CH, 20000);
    for (int i = 0; i < 1500; i++)
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
    for (int i = 0; i < 1500; i++)
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


/* Advance one tick with a carriage that delivers `share` of what the pulse
 * train commands: 1 follows, 0.1 crawls (slipping nine steps in ten), and a
 * negative share runs the opposite way -- a reversed encoder direction. */
static void tick_with_share(double share)
{
    global_timeus += 1000U;
    dev_servo_run();
    if (d_startVelocityCount > 0U)
    {
        const double dir = d_gpioActive ? -1.0 : 1.0;
        d_carriage += share * dir * (double)d_pulseRate * 0.001;
        d_encoderValue = (int32_t)(d_carriage < 0.0 ? (d_carriage - 0.5) : (d_carriage + 0.5));
    }
}

/* The encoder of a jammed drive that is still powered: it never rests for
 * two ticks running, and never strays more than 15 counts from where it
 * jammed -- the pattern measured on the bench. */
static const int32_t d_buzz[] = { 0, 7, 15, 3, -9, -15, -4, 10, 12, -2, -11, 5 };
#define BUZZ_LEN ((int)(sizeof(d_buzz) / sizeof(d_buzz[0])))

void test_dev_servo_stallThroughEncoderBuzz(void)
{
    VIBES_TEST("servo.stall-through-encoder-buzz",
               "src/DEV/dev_servo.c#dev_servo_private_stallGuard",
               "an enabled motor drive commanded at 20000 encoder counts per second against a jam, with the encoder buzzing within 15 counts of the jam and changing on every tick");
    VIBES_EXPECT_WHY("stall-reported",
                     "the drive reports a stall within a second of the command",
                     "a powered drive pulling against a jam shakes the encoder without getting anywhere, so the gap to where it should be keeps growing whatever the buzz does");
    servo_init();
    dev_servo_enable(CH, true);
    dev_servo_setVelocity(CH, 20000);
    int ticks = 0;
    while ((ticks < 2000) && !dev_servo_isStalled(CH))
    {
        d_encoderValue = d_buzz[ticks % BUZZ_LEN];
        tick();
        ticks++;
    }
    TEST_ASSERT_TRUE(dev_servo_isStalled(CH));
    /* The pulses reach 1 mm (8192 counts) in under 400 ticks, and the buzz
     * covers 30 counts of it at most, far short of the quarter it needs. */
    TEST_ASSERT_LESS_OR_EQUAL_INT(1000, ticks);
}

void test_dev_servo_stallWhenCarriageCrawls(void)
{
    VIBES_TEST("servo.stall-when-carriage-crawls",
               "src/DEV/dev_servo.c#dev_servo_private_stallGuard",
               "an enabled motor drive commanded at high speed while the carriage covers only a tenth of the travel its step pulses call for");
    VIBES_EXPECT_WHY("stall-reported",
                     "the drive reports a stall",
                     "a carriage that delivers a tenth of the travel it is driven through falls ever further behind, slipping against a load it cannot move");
    servo_init();
    dev_servo_enable(CH, true);
    dev_servo_setVelocity(CH, 20000);
    int ticks = 0;
    while ((ticks < 3000) && !dev_servo_isStalled(CH))
    {
        tick_with_share(0.1);
        ticks++;
    }
    TEST_ASSERT_TRUE(dev_servo_isStalled(CH));
}

void test_dev_servo_noStallWhileCarriageLags(void)
{
    VIBES_TEST("servo.no-stall-while-carriage-lags",
               "src/DEV/dev_servo.c#dev_servo_private_stallGuard",
               "an enabled motor drive commanded at high speed for two seconds while the carriage covers half of the travel its step pulses call for");
    VIBES_EXPECT_WHY("no-stall",
                     "no stall is reported at any point",
                     "a carriage that is moving the right way and staying within half a millimetre of where it should be is under control, and stopping it would abort a good test");
    servo_init();
    dev_servo_enable(CH, true);
    dev_servo_setVelocity(CH, 20000);
    bool everStalled = false;
    for (int i = 0; i < 2000; i++)
    {
        tick_with_share(0.5);
        everStalled = everStalled || dev_servo_isStalled(CH);
    }
    TEST_ASSERT_FALSE(everStalled);
}

void test_dev_servo_noStallOnFullSpeedMove(void)
{
    VIBES_TEST("servo.no-stall-on-full-speed-move",
               "src/DEV/dev_servo.c#dev_servo_private_stallGuard",
               "an enabled motor drive making a 100 mm move at full speed and back, with the carriage following the drive");
    VIBES_EXPECT("no-stall", "no stall is reported at any point, through the ramps, the cruise or the final approach");
    VIBES_EXPECT("arrives", "the drive reports arrival at each end");
    servo_init();
    dev_servo_enable(CH, true);
    bool everStalled = false;
    const int32_t ends[2] = { counts_from_mm(100.0), 0 };
    for (int leg = 0; leg < 2; leg++)
    {
        dev_servo_moveTo(CH, ends[leg], 0);
        int ticks = 0;
        do
        {
            tick_with_motion();
            everStalled = everStalled || dev_servo_isStalled(CH);
            ticks++;
        } while ((ticks < 20000) && !dev_servo_atTarget(CH));
        TEST_ASSERT_TRUE(dev_servo_atTarget(CH));
    }
    TEST_ASSERT_FALSE(everStalled);
}

/* A carriage behind a drive with LAG: its speed follows the step rate through
 * a first-order lag of time constant `tauS`, solved exactly over each 1 ms
 * tick. That is embsim's StepperMotor, the SIL twin's drive. Where
 * tick_with_motion's carriage moves exactly what each tick's pulses say, this
 * one falls behind through every ramp and coasts on past every stop and
 * reversal, by about its speed times the lag. */
static void tick_with_lag(double tauS)
{
    global_timeus += 1000U;
    dev_servo_run();
    const double dir = d_gpioActive ? -1.0 : 1.0;
    const double rate = (d_startVelocityCount > 0U) ? (dir * (double)d_pulseRate) : 0.0;
    if (d_carriageJammed)
    {
        d_carriageVel = 0.0;
    }
    else
    {
        const double decay = exp(-SERVO_DT_S / tauS);
        d_carriage += (rate * SERVO_DT_S) + ((d_carriageVel - rate) * tauS * (1.0 - decay));
        d_carriageVel = rate + ((d_carriageVel - rate) * decay);
    }
    if (!d_encoderStopped)
    {
        d_encoderValue = (int32_t)(d_carriage < 0.0 ? (d_carriage - 0.5) : (d_carriage + 0.5));
    }
}

/* The SIL twin's drive lag: embsim's StepperMotor at its default time
 * constant. A placeholder for the real drive, whose lag is unmeasured. */
#define TWIN_DRIVE_LAG_S 0.020

void test_dev_servo_noStallThroughFullSpeedStopsOnALaggingDrive(void)
{
    VIBES_TEST("servo.no-stall-through-full-speed-stops-on-a-lagging-drive",
               "src/DEV/dev_servo.c#dev_servo_private_stallGuard",
               "an enabled motor drive making full-speed moves of 10 mm out and back and 100 mm out and back, its carriage following the step rate through a 20 ms lag");
    VIBES_EXPECT_WHY("coasts-past",
                     "the carriage overshoots each stop by more than 0.3 mm before it is drawn back",
                     "this is the coast that a lagging drive makes at every full-speed stop and reversal, so a stall guard has to let it pass");
    VIBES_EXPECT_WHY("no-stall",
                     "no stall is reported at any point, through the ramps, the long cruise, the overshoots or the reversals",
                     "a healthy drive's error stays under the 2 mm at which a stall is immediate, and spends no half second over the 1 mm at which a held error is one");
    VIBES_EXPECT("arrives", "the drive reports arrival at each end");
    servo_init();
    d_carriageVel = 0.0;
    dev_servo_enable(CH, true);
    bool everStalled = false;
    const int32_t ends[4] = { counts_from_mm(10.0), 0, counts_from_mm(100.0), 0 };
    for (int leg = 0; leg < 4; leg++)
    {
        const int32_t from = d_encoderValue;
        const int32_t to = ends[leg];
        const double sign = (to > from) ? 1.0 : -1.0;
        double overshoot = 0.0;
        dev_servo_moveTo(CH, to, 0);
        int ticks = 0;
        do
        {
            tick_with_lag(TWIN_DRIVE_LAG_S);
            everStalled = everStalled || dev_servo_isStalled(CH);
            const double past = sign * (d_carriage - (double)to);
            if (past > overshoot) { overshoot = past; }
            ticks++;
        } while ((ticks < 30000) && !dev_servo_atTarget(CH));
        TEST_ASSERT_TRUE(dev_servo_atTarget(CH));
        TEST_ASSERT_GREATER_THAN_INT32(counts_from_mm(0.3), (int32_t)overshoot);
    }
    TEST_ASSERT_FALSE(everStalled);
}

void test_dev_servo_noStallThroughAWaveformOnALaggingDrive(void)
{
    VIBES_TEST("servo.no-stall-through-a-waveform-on-a-lagging-drive",
               "src/DEV/dev_servo.c#dev_servo_private_stallGuard",
               "an enabled motor drive running two cycles of a 4 mm, 0.5 Hz sine about a centre 6 mm away, its carriage following the step rate through a 20 ms lag");
    VIBES_EXPECT_WHY("no-stall",
                     "no stall is reported through the approach to the peak, the cycles or the return to the centre",
                     "the approach and the return run at the machine's full speed, so the carriage coasts past each of them before it is drawn back");
    VIBES_EXPECT("cycles-done", "both cycles complete");
    servo_init();
    d_carriageVel = 0.0;
    dev_servo_enable(CH, true);
    TEST_ASSERT_TRUE(dev_servo_startWaveform(CH, WF(counts_from_mm(6.0), counts_from_mm(4.0), 500000U, 2U,
                                                    DEV_SERVO_WAVE_SINE)));
    bool everStalled = false;
    int ticks = 0;
    do
    {
        tick_with_lag(TWIN_DRIVE_LAG_S);
        everStalled = everStalled || dev_servo_isStalled(CH);
        ticks++;
    } while ((ticks < 30000) && !dev_servo_atTarget(CH));
    TEST_ASSERT_EQUAL_UINT32(2U, dev_servo_waveformCyclesDone(CH));
    TEST_ASSERT_FALSE(everStalled);
}

void test_dev_servo_runawayIsReportedAsStall(void)
{
    VIBES_TEST("servo.runaway-is-a-stall",
               "src/DEV/dev_servo.c#dev_servo_private_stallGuard",
               "an enabled motor drive commanded at high speed whose carriage runs the opposite way to its step pulses at their rate, as with a reversed encoder direction");
    VIBES_EXPECT_WHY("stall-early",
                     "the drive reports a stall within a quarter of a second, without waiting out the half second a held error needs",
                     "the loop's own correction drives a reversed carriage further from where it should be, so waiting only lets it run further");
    VIBES_EXPECT("bounded-travel",
                 "the carriage has run less than 2 mm the wrong way when the stall is reported");
    servo_init();
    dev_servo_enable(CH, true);
    dev_servo_setVelocity(CH, 20000);
    int ticks = 0;
    while ((ticks < 1000) && !dev_servo_isStalled(CH))
    {
        tick_with_share(-1.0);
        ticks++;
    }
    TEST_ASSERT_TRUE(dev_servo_isStalled(CH));
    TEST_ASSERT_LESS_THAN_INT(250, ticks);
    /* The error is the setpoint ahead plus the carriage behind, so the
     * carriage's own share of the 2 mm ceiling is less than all of it. */
    TEST_ASSERT_LESS_THAN_INT32(STALL_CEILING, -d_encoderValue);
}

/* Park the drive at 0 and hold the encoder `offset` counts away for `ticks`
 * ticks, as a load or a knock would push it. The setpoint stays on the
 * target, so the following error is the offset itself. */
static void hold_encoder_off_target(int32_t offset, int ticks)
{
    for (int i = 0; i < ticks; i++)
    {
        d_encoderValue = offset;
        tick();
    }
}

static void park_at_origin_scaled(int32_t encoderPerMm)
{
    servo_init_scaled(SHIPPED_MAX_VEL_COUNTS, SHIPPED_MAX_ACCEL_COUNTS, encoderPerMm, 0);
    dev_servo_enable(CH, true);
    dev_servo_moveTo(CH, 0, 0);
    tick();
    TEST_ASSERT_TRUE(dev_servo_atTarget(CH));
}

static void park_at_origin(void)
{
    servo_init();
    dev_servo_enable(CH, true);
    dev_servo_moveTo(CH, 0, 0);
    tick();
    TEST_ASSERT_TRUE(dev_servo_atTarget(CH));
}

void test_dev_servo_errorPastTheCeilingStallsAtOnce(void)
{
    VIBES_TEST("servo.error-past-the-ceiling-stalls-at-once",
               "src/DEV/dev_servo.c#dev_servo_private_stallGuard",
               "an enabled motor drive at rest whose carriage is pushed just over 2 mm from where it should be for a single control tick, then put back");
    VIBES_EXPECT_WHY("stall-on-that-tick",
                     "the drive reports a stall on that tick",
                     "an error that large is a runaway, and a stall at the hard ceiling does not wait for the error to persist");
    VIBES_EXPECT("not-at-the-ceiling",
                 "an error of exactly 2 mm for a tick reports no stall");
    VIBES_EXPECT_WHY("latched",
                     "the stall is still reported after the carriage is put back, until the drive is disabled",
                     "a stall the controller only samples now and then must not vanish before it is seen");
    VIBES_EXPECT_WHY("set-position-clears",
                     "a stall tripped again is cleared by giving the drive a new position, without disabling it",
                     "redefining the position puts the setpoint on the carriage, so the error the stall was about is gone");
    park_at_origin();
    hold_encoder_off_target(STALL_CEILING, 1);
    TEST_ASSERT_FALSE(dev_servo_isStalled(CH));
    hold_encoder_off_target(0, 1);

    hold_encoder_off_target(-(STALL_CEILING + 1), 1);
    TEST_ASSERT_TRUE(dev_servo_isStalled(CH));

    hold_encoder_off_target(0, 1000);
    TEST_ASSERT_TRUE(dev_servo_isStalled(CH));
    dev_servo_enable(CH, false);
    tick();
    TEST_ASSERT_FALSE(dev_servo_isStalled(CH));

    dev_servo_enable(CH, true);
    hold_encoder_off_target(STALL_CEILING + 1, 1);
    TEST_ASSERT_TRUE(dev_servo_isStalled(CH));
    dev_servo_setPosition(CH, d_encoderValue);
    tick();
    TEST_ASSERT_FALSE(dev_servo_isStalled(CH));
}

/* A carriage that MOVES while it holds a set distance behind where it should
 * be. Holding the encoder still instead would be a carriage that does not move
 * while the drive is pulsed -- the travel check's case, which stalls within a
 * millimetre of pulses -- so the soft band is tested on a carriage that keeps
 * up with the setpoint's speed but not its position.
 *
 * The drive holds a steady 82000 counts/s (about 10 mm/s), reached in a single
 * tick, so the setpoint advances a whole 82 counts a tick and the error is
 * exactly the offset asked for. The carriage then covers 82 counts of the
 * 82 + Kp x offset / 1000 that each tick's pulses call for: over a quarter of
 * them for any offset up to the 2 mm ceiling, so the travel check holds. */
#define HELD_SPEED_COUNTS 82000
static int32_t d_heldDirection; /* +1 forward, -1 in reverse */

static void hold_behind(int32_t offset, int ticks)
{
    for (int i = 0; i < ticks; i++)
    {
        d_encoderValue = dev_servo_data.channel[CH].setpointCounts - (d_heldDirection * offset);
        tick();
    }
}

static void hold_behind_at_speed_scaled(int32_t encoderPerMm, int32_t direction)
{
    servo_init_scaled(SHIPPED_MAX_VEL_COUNTS, HELD_SPEED_COUNTS * 1000, encoderPerMm, 0);
    d_heldDirection = direction;
    dev_servo_enable(CH, true);
    dev_servo_setVelocity(CH, direction * HELD_SPEED_COUNTS);
    hold_behind(0, 5);
    TEST_ASSERT_EQUAL_INT32(0, dev_servo_getFollowingError(CH));
    TEST_ASSERT_FALSE(dev_servo_isStalled(CH));
}

static void hold_behind_at_speed(void)
{
    hold_behind_at_speed_scaled(0, 1);
}

void test_dev_servo_errorHeldInTheSoftBandStalls(void)
{
    VIBES_TEST("servo.error-held-in-the-soft-band-stalls",
               "src/DEV/dev_servo.c#dev_servo_private_stallGuard",
               "an enabled motor drive holding about 10 mm/s whose carriage moves at that speed but 1.5 mm behind where it should be, between the 1 mm soft band and the 2 mm hard ceiling");
    VIBES_EXPECT_WHY("stall-after-half-a-second",
                     "the drive reports a stall once the error has been held for half a second",
                     "a carriage that stays too far behind for that long is not following, even though it never runs away");
    VIBES_EXPECT("not-before", "no stall is reported before the half second is up");
    hold_behind_at_speed();
    hold_behind(counts_from_mm(1.5), STALL_BAND_TICKS - 1);
    TEST_ASSERT_FALSE(dev_servo_isStalled(CH));
    hold_behind(counts_from_mm(1.5), 1);
    TEST_ASSERT_TRUE(dev_servo_isStalled(CH));
}

void test_dev_servo_errorAtTheBandDoesNotStall(void)
{
    VIBES_TEST("servo.error-at-the-band-does-not-stall",
               "src/DEV/dev_servo.c#dev_servo_private_stallGuard",
               "an enabled motor drive holding about 10 mm/s whose carriage moves at that speed but exactly 1 mm behind where it should be, for a second");
    VIBES_EXPECT_WHY("no-stall",
                     "no stall is reported at any point",
                     "the soft band counts an error held over 1 mm; an error of 1 mm is inside it");
    hold_behind_at_speed();
    bool everStalled = false;
    for (int i = 0; i < (2 * STALL_BAND_TICKS); i++)
    {
        hold_behind(STALL_BAND, 1);
        everStalled = everStalled || dev_servo_isStalled(CH);
    }
    TEST_ASSERT_FALSE(everStalled);
}

void test_dev_servo_briefErrorInTheSoftBandDoesNotStall(void)
{
    VIBES_TEST("servo.brief-error-in-the-soft-band-does-not-stall",
               "src/DEV/dev_servo.c#dev_servo_private_stallGuard",
               "an enabled motor drive holding about 10 mm/s whose carriage moves at that speed but falls 1.5 mm behind for just under half a second at a time, five times, coming back to just inside 1 mm for one control tick between them");
    VIBES_EXPECT_WHY("no-stall",
                     "no stall is reported at any point",
                     "a healthy error passes through the soft band on a ramp or a stop and drops back; each excursion starts the half-second count again from zero");
    hold_behind_at_speed();
    bool everStalled = false;
    for (int burst = 0; burst < 5; burst++)
    {
        for (int i = 0; i < (STALL_BAND_TICKS - 1); i++)
        {
            hold_behind(counts_from_mm(1.5), 1);
            everStalled = everStalled || dev_servo_isStalled(CH);
        }
        hold_behind(STALL_BAND - 1, 1);
        everStalled = everStalled || dev_servo_isStalled(CH);
    }
    TEST_ASSERT_FALSE(everStalled);
}

/* The profile's encoder scale on the bench (#308): 2400 counts per mm, so
 * the 2 mm ceiling is 4800 counts and the 1 mm band 2400. */
#define BENCH_COUNTS_PER_MM 2400
#define BENCH_STALL_CEILING (2 * BENCH_COUNTS_PER_MM)
#define BENCH_STALL_BAND BENCH_COUNTS_PER_MM

void test_dev_servo_stallThresholdsFollowTheEncoderScale(void)
{
    VIBES_TEST("servo.stall-thresholds-follow-the-encoder-scale",
               "src/DEV/dev_servo.c#dev_servo_init",
               "a machine profile with 2400 encoder counts per millimetre, and an enabled motor drive whose carriage is pushed off where it should be while at rest, then falls behind while moving in reverse at about 34 mm/s");
    VIBES_EXPECT_WHY("ceiling-is-2-mm",
                     "an error of exactly 2 mm for a tick reports no stall, and one count more reports it on that tick",
                     "the ceiling is a distance the carriage may run wrong, so it has to mean the same 2 mm whatever the encoder's resolution");
    VIBES_EXPECT("band-is-1-mm",
                 "a carriage just over 1 mm behind for half a second reports a stall, and not a tick before");
    park_at_origin_scaled(BENCH_COUNTS_PER_MM);
    hold_encoder_off_target(BENCH_STALL_CEILING, 1);
    TEST_ASSERT_FALSE(dev_servo_isStalled(CH));
    hold_encoder_off_target(0, 1);
    hold_encoder_off_target(-(BENCH_STALL_CEILING + 1), 1);
    TEST_ASSERT_TRUE(dev_servo_isStalled(CH));

    hold_behind_at_speed_scaled(BENCH_COUNTS_PER_MM, -1);
    hold_behind(BENCH_STALL_BAND + 1, STALL_BAND_TICKS - 1);
    TEST_ASSERT_FALSE(dev_servo_isStalled(CH));
    hold_behind(BENCH_STALL_BAND + 1, 1);
    TEST_ASSERT_TRUE(dev_servo_isStalled(CH));
}

void test_dev_servo_slowFallingBehindStallsInTheSoftBand(void)
{
    VIBES_TEST("servo.stall-on-held-following-error",
               "src/DEV/dev_servo.c#dev_servo_private_stallGuard",
               "an enabled motor drive commanded at about 5 mm/s while the carriage covers only three tenths of the travel its step pulses call for, so it settles about 1.4 mm behind");
    VIBES_EXPECT_WHY("stall-reported",
                     "the drive reports a stall half a second after the error passes 1 mm",
                     "a carriage that keeps falling behind is failing to follow even while it moves the right way, and never runs far enough off to reach the hard ceiling");
    VIBES_EXPECT("not-before",
                 "no stall is reported while the following error is at or under 1 mm");
    VIBES_EXPECT("never-near-the-ceiling",
                 "the error never reaches 2 mm, so it is the held error that reports the stall");
    servo_init();
    dev_servo_enable(CH, true);
    /* Kp x error makes up the 70 percent the carriage loses: it settles where
     * 0.3 x (40000 + 8 x error) = 40000, about 11700 counts behind. Three
     * tenths is over the quarter of its pulses the travel check asks for. */
    dev_servo_setVelocity(CH, 40000);
    int ticks = 0;
    int firstOverBand = -1;
    bool stalledInsideBand = false;
    int32_t worst = 0;
    while ((ticks < 5000) && !dev_servo_isStalled(CH))
    {
        tick_with_share(0.3);
        ticks++;
        const int32_t err = dev_servo_getFollowingError(CH);
        if (err > worst) { worst = err; }
        if (err > STALL_BAND)
        {
            if (firstOverBand < 0) { firstOverBand = ticks; }
        }
        else if (dev_servo_isStalled(CH))
        {
            stalledInsideBand = true;
        }
    }
    TEST_ASSERT_TRUE(dev_servo_isStalled(CH));
    TEST_ASSERT_FALSE(stalledInsideBand);
    TEST_ASSERT_TRUE(firstOverBand > 0);
    TEST_ASSERT_INT_WITHIN(1, firstOverBand + STALL_BAND_TICKS - 1, ticks);
    TEST_ASSERT_LESS_THAN_INT32(STALL_CEILING, worst);
}

/* A profile whose two scales say each step pulse moves the carriage eight
 * encoder counts, on a carriage that moves one. The loop pulses the drive for
 * eight counts a pulse, so the carriage delivers an eighth of every command.
 * The travel check counts each pulse at the profile's eight counts too, so the
 * first millimetre of pulses (8192 counts) finds an eighth of it delivered:
 * 236 ticks (measured). Counted at one count a pulse, the pulses would look
 * fully delivered, and only the soft band would stall it, at 1134 ticks. */
void test_dev_servo_stallUsesProfilePulseScale(void)
{
    VIBES_TEST("servo.stall-uses-profile-pulse-scale",
               "src/DEV/dev_servo.c#dev_servo_init",
               "a machine profile whose encoder and servo steps per millimetre say each step pulse moves the carriage eight encoder counts, and a carriage that moves one count per pulse");
    VIBES_EXPECT_WHY("stall-reported",
                     "the drive reports a stall",
                     "the drive is pulsed by the profile's two scales, so a carriage delivering an eighth of the travel per pulse falls ever further behind where the loop is driving it");
    VIBES_EXPECT_WHY("within-half-a-second",
                     "the stall is reported within half a second of the command",
                     "the pulses are judged at the profile's scale too, so the first millimetre of them shows the carriage delivering an eighth");
    servo_init_scaled(SHIPPED_MAX_VEL_COUNTS, SHIPPED_MAX_ACCEL_COUNTS, 8192, 1024);
    dev_servo_enable(CH, true);
    dev_servo_setVelocity(CH, 20000);
    int ticks = 0;
    while ((ticks < 5000) && !dev_servo_isStalled(CH))
    {
        tick_with_share(1.0);
        ticks++;
    }
    TEST_ASSERT_TRUE(dev_servo_isStalled(CH));
    TEST_ASSERT_LESS_THAN_INT(500, ticks);
}

/* ---- The travel check: pulses sent, and the encoder's share of them. ---- */

/* The travel check judges every 1 mm of net pulsed travel, and a window that
 * had already seen its quarter when the fault began passes once more, so a
 * faulty carriage is driven at most two of them blind. */
#define TRAVEL_CHECK_COUNTS 8192 /* 1 mm */

/* Run a 10 mm move at `feedMm` mm/s on the twin's lagging drive until the
 * setpoint has `remainMm` of it left. */
static void move_until_remaining(double feedMm, double remainMm)
{
    servo_init();
    dev_servo_enable(CH, true);
    const int32_t target = counts_from_mm(10.0);
    dev_servo_moveTo(CH, target, counts_from_mm(feedMm));
    int ticks = 0;
    while ((ticks < 400000) && (dev_servo_getSetpoint(CH) < (target - counts_from_mm(remainMm))))
    {
        tick_with_lag(TWIN_DRIVE_LAG_S);
        ticks++;
    }
    TEST_ASSERT_FALSE(dev_servo_isStalled(CH));
}

/* Ticks on the lagging drive until a stall or `maxTicks`; returns ticks used. */
static int run_until_stall(int maxTicks)
{
    int ticks = 0;
    while ((ticks < maxTicks) && !dev_servo_isStalled(CH))
    {
        tick_with_lag(TWIN_DRIVE_LAG_S);
        ticks++;
    }
    return ticks;
}

void test_dev_servo_encoderStoppingNearTheTargetStalls(void)
{
    VIBES_TEST("servo.stall-when-encoder-stops-near-the-target",
               "src/DEV/dev_servo.c#dev_servo_private_stallGuard",
               "a 10 mm move at 1 mm/s, and again at 0.05 mm/s, whose encoder stops counting with 0.5 mm of the move left while the carriage goes on following the step pulses through a 20 ms lag");
    VIBES_EXPECT_WHY("stall-reported",
                     "the drive reports a stall within 3 seconds",
                     "the loop goes on pulsing the drive toward a target the encoder never reaches, so the carriage runs on until the stall stops it");
    VIBES_EXPECT("bounded-travel",
                 "the carriage has run less than 2 mm from where the encoder stopped when the stall is reported");
    const double feeds[2] = { 1.0, 0.05 };
    for (int f = 0; f < 2; f++)
    {
        move_until_remaining(feeds[f], 0.5);
        const double from = d_carriage;
        d_encoderStopped = true;
        const int ticks = run_until_stall(3000);
        TEST_ASSERT_TRUE(dev_servo_isStalled(CH));
        TEST_ASSERT_LESS_THAN_INT(3000, ticks);
        TEST_ASSERT_LESS_THAN_INT32(2 * TRAVEL_CHECK_COUNTS, (int32_t)fabs(d_carriage - from));
    }
}

void test_dev_servo_encoderStoppingDuringAWaveformStalls(void)
{
    VIBES_TEST("servo.stall-when-encoder-stops-during-a-waveform",
               "src/DEV/dev_servo.c#dev_servo_private_stallGuard",
               "an enabled motor drive running a 0.25 mm, 1 Hz sine whose encoder stops counting three seconds in while the carriage goes on following the step pulses through a 20 ms lag");
    VIBES_EXPECT_WHY("stall-reported",
                     "the drive reports a stall within a second",
                     "the loop corrects toward the frozen reading on every cycle, so the carriage drifts further from the centre with each one");
    VIBES_EXPECT("bounded-travel",
                 "the carriage is less than 2 mm from where the encoder stopped when the stall is reported");
    servo_init();
    dev_servo_enable(CH, true);
    TEST_ASSERT_TRUE(dev_servo_startWaveform(CH, WF(0, counts_from_mm(0.25), 1000000U, 1000U,
                                                    DEV_SERVO_WAVE_SINE)));
    for (int i = 0; i < 3000; i++)
    {
        tick_with_lag(TWIN_DRIVE_LAG_S);
    }
    TEST_ASSERT_FALSE(dev_servo_isStalled(CH));
    const double from = d_carriage;
    d_encoderStopped = true;
    const int ticks = run_until_stall(1000);
    TEST_ASSERT_TRUE(dev_servo_isStalled(CH));
    TEST_ASSERT_LESS_THAN_INT(1000, ticks);
    TEST_ASSERT_LESS_THAN_INT32(2 * TRAVEL_CHECK_COUNTS, (int32_t)fabs(d_carriage - from));
}

void test_dev_servo_jamNearTheTargetStalls(void)
{
    VIBES_TEST("servo.stall-when-jammed-near-the-target",
               "src/DEV/dev_servo.c#dev_servo_private_stallGuard",
               "a 10 mm move at 1 mm/s whose carriage jams with 0.5 mm of the move left, its encoder still reading it");
    VIBES_EXPECT_WHY("stall-reported",
                     "the drive reports a stall within a second",
                     "the move can never arrive, and until the stall is reported the drive is pulsed into the jam");
    move_until_remaining(1.0, 0.5);
    d_carriageJammed = true;
    const int ticks = run_until_stall(1000);
    TEST_ASSERT_TRUE(dev_servo_isStalled(CH));
    TEST_ASSERT_LESS_THAN_INT(1000, ticks);
}

void test_dev_servo_jamAtTensileSpeedStalls(void)
{
    VIBES_TEST("servo.stall-when-jammed-at-tensile-speed",
               "src/DEV/dev_servo.c#dev_servo_private_stallGuard",
               "a move at 0.01 mm/s whose carriage jams 0.3 seconds in, its encoder still reading it");
    VIBES_EXPECT_WHY("stall-reported",
                     "the drive reports a stall within 6 seconds of the jam",
                     "the following error grows by only 10 um a second at this speed, while the pulses the loop sends into the jam reach 1 mm within seconds");
    servo_init();
    dev_servo_enable(CH, true);
    dev_servo_moveTo(CH, counts_from_mm(100.0), counts_from_mm(0.01));
    for (int i = 0; i < 300; i++)
    {
        tick_with_lag(TWIN_DRIVE_LAG_S);
    }
    d_carriageJammed = true;
    const int ticks = run_until_stall(6000);
    TEST_ASSERT_TRUE(dev_servo_isStalled(CH));
    TEST_ASSERT_LESS_THAN_INT(6000, ticks);
}

void test_dev_servo_travelCheckFollowsTheEncoderScale(void)
{
    VIBES_TEST("servo.travel-check-follows-the-encoder-scale",
               "src/DEV/dev_servo.c#dev_servo_init",
               "a machine profile with 2400 encoder counts per millimetre, and an enabled motor drive commanded at 1 mm/s while its encoder stays frozen");
    VIBES_EXPECT_WHY("judged-at-1-mm",
                     "the stall is reported on the control tick at which the step pulses have called for 1 mm of travel, 2400 counts",
                     "the travel judged at a time is a distance, so it has to mean the same millimetre whatever the encoder's resolution");
    servo_init_scaled(SHIPPED_MAX_VEL_COUNTS, SHIPPED_MAX_ACCEL_COUNTS, BENCH_COUNTS_PER_MM, 0);
    dev_servo_enable(CH, true);
    dev_servo_setVelocity(CH, BENCH_COUNTS_PER_MM);
    int ticks = 0;
    double pulsedBefore = 0.0;
    while ((ticks < 3000) && !dev_servo_isStalled(CH))
    {
        pulsedBefore = d_emitted;
        tick();
        ticks++;
    }
    TEST_ASSERT_TRUE(dev_servo_isStalled(CH));
    /* One count of travel per pulse: the tick that stalls is the first whose
     * pulses reach the 2400 counts. */
    TEST_ASSERT_LESS_THAN_INT32(BENCH_COUNTS_PER_MM, (int32_t)pulsedBefore);
    TEST_ASSERT_GREATER_OR_EQUAL_INT32(BENCH_COUNTS_PER_MM, (int32_t)d_emitted);
}

void test_dev_servo_stallHoldsThroughNewCommands(void)
{
    VIBES_TEST("servo.stall-holds-through-new-commands",
               "src/DEV/dev_servo.c#dev_servo_private_stallGuard",
               "a stalled motor drive, still enabled, that is given a new move, then a speed command, then a stop, with control ticks after each and the carriage put back where it should be");
    VIBES_EXPECT_WHY("still-reported",
                     "the stall is still reported after each of them",
                     "a stall stays reported until the drive is disabled or its position is redefined, so a controller that reads it late still sees it");
    servo_init();
    dev_servo_enable(CH, true);
    dev_servo_setVelocity(CH, 20000);
    int ticks = 0;
    while ((ticks < 1500) && !dev_servo_isStalled(CH))
    {
        tick();
        ticks++;
    }
    TEST_ASSERT_TRUE(dev_servo_isStalled(CH));

    dev_servo_moveTo(CH, 0, 0);
    for (int i = 0; i < 50; i++)
    {
        d_encoderValue = dev_servo_getSetpoint(CH);
        tick();
    }
    TEST_ASSERT_TRUE(dev_servo_isStalled(CH));
    dev_servo_setVelocity(CH, 1000);
    for (int i = 0; i < 50; i++)
    {
        d_encoderValue = dev_servo_getSetpoint(CH);
        tick();
    }
    TEST_ASSERT_TRUE(dev_servo_isStalled(CH));
    dev_servo_stop(CH);
    for (int i = 0; i < 50; i++)
    {
        d_encoderValue = dev_servo_getSetpoint(CH);
        tick();
    }
    TEST_ASSERT_TRUE(dev_servo_isStalled(CH));
}

void test_dev_servo_slowCrawlStalls(void)
{
    VIBES_TEST("servo.stall-when-carriage-crawls-slowly",
               "src/DEV/dev_servo.c#dev_servo_private_stallGuard",
               "an enabled motor drive commanded at 1 mm/s while the carriage covers only a fifth of the travel its step pulses call for, falling less than 0.5 mm behind");
    VIBES_EXPECT_WHY("stall-reported",
                     "the drive reports a stall within a second",
                     "a carriage that delivers under a quarter of the travel it is pulsed for is not following, even when its following error stays well inside the 1 mm band");
    servo_init();
    dev_servo_enable(CH, true);
    dev_servo_setVelocity(CH, counts_from_mm(1.0));
    int ticks = 0;
    int32_t worst = 0;
    while ((ticks < 1000) && !dev_servo_isStalled(CH))
    {
        tick_with_share(0.2);
        const int32_t err = dev_servo_getFollowingError(CH);
        if (err > worst) { worst = err; }
        ticks++;
    }
    TEST_ASSERT_TRUE(dev_servo_isStalled(CH));
    TEST_ASSERT_LESS_THAN_INT32(STALL_BAND, worst);
}

void test_dev_servo_reEnableAfterAStallHoldsStill(void)
{
    VIBES_TEST("servo.re-enable-after-a-stall-holds-still",
               "src/DEV/dev_servo.c#dev_servo_run",
               "a drive that stalled against a jam that stays, then stopped and disabled as the controller does when it reports the stall, then enabled again with no move commanded, its encoder buzzing at the jam");
    VIBES_EXPECT_WHY("no-stall",
                     "no stall is reported for 5 seconds after it is enabled again",
                     "acknowledging a stall clears it, and with no move commanded the drive holds where the carriage stands");
    VIBES_EXPECT("holds", "the following error stays within 30 counts, the width of the buzz");
    servo_init();
    dev_servo_enable(CH, true);
    dev_servo_moveTo(CH, counts_from_mm(5.0), counts_from_mm(10.0));
    const int32_t jamAt = counts_from_mm(2.0);
    int ticks = 0;
    while ((ticks < 5000) && !dev_servo_isStalled(CH))
    {
        tick_with_motion();
        if (d_carriage > (double)jamAt) { d_carriage = (double)jamAt; }
        d_encoderValue = (int32_t)d_carriage + (((int32_t)d_carriage >= jamAt) ? d_buzz[ticks % BUZZ_LEN] : 0);
        ticks++;
    }
    TEST_ASSERT_TRUE(dev_servo_isStalled(CH));
    dev_servo_stop(CH);
    dev_servo_enable(CH, false);
    for (int i = 0; i < 50; i++)
    {
        d_encoderValue = jamAt + d_buzz[(ticks + i) % BUZZ_LEN];
        tick();
    }
    TEST_ASSERT_FALSE(dev_servo_isStalled(CH));
    dev_servo_enable(CH, true);
    bool everStalled = false;
    int32_t worst = 0;
    for (int i = 0; i < 5000; i++)
    {
        d_encoderValue = jamAt + d_buzz[i % BUZZ_LEN];
        tick();
        everStalled = everStalled || dev_servo_isStalled(CH);
        const int32_t err = abs(dev_servo_getFollowingError(CH));
        if (err > worst) { worst = err; }
    }
    TEST_ASSERT_FALSE(everStalled);
    TEST_ASSERT_LESS_OR_EQUAL_INT32(30, worst);
}

/* ---- A frame redefined by another core while a control tick runs. ---- */

static int32_t d_redefineTo;
static void redefine_frame(void) { dev_servo_setPosition(CH, d_redefineTo); }

void test_dev_servo_frameRedefinedMidTickIsNotAStall(void)
{
    VIBES_TEST("servo.frame-redefined-mid-tick-is-not-a-stall",
               "src/DEV/dev_servo.c#dev_servo_run",
               "a stopped motor drive whose position is redefined 100 mm away by another core between a control tick's encoder reading and its use of it, as homing does, then a 1 mm move in the new frame");
    VIBES_EXPECT_WHY("no-stall",
                     "no stall is reported at any point",
                     "that tick's reading and its setpoint belong to different frames, so their difference is the redefinition and says nothing about the carriage");
    VIBES_EXPECT("move-arrives", "the move arrives at its target in the new frame");
    servo_init();
    dev_servo_enable(CH, true);
    dev_servo_stop(CH);
    for (int i = 0; i < 10; i++)
    {
        tick_with_motion();
    }
    d_redefineTo = counts_from_mm(100.0);
    d_afterReadHook = redefine_frame;
    tick_with_motion();
    TEST_ASSERT_NULL(d_afterReadHook);
    bool everStalled = dev_servo_isStalled(CH);
    const int32_t target = d_redefineTo + counts_from_mm(1.0);
    dev_servo_moveTo(CH, target, 0);
    int ticks = 0;
    do
    {
        tick_with_motion();
        everStalled = everStalled || dev_servo_isStalled(CH);
        ticks++;
    } while ((ticks < 5000) && !dev_servo_atTarget(CH));
    TEST_ASSERT_FALSE(everStalled);
    TEST_ASSERT_TRUE(dev_servo_atTarget(CH));
    TEST_ASSERT_INT32_WITHIN(8, target, d_encoderValue);
}

void test_dev_servo_frameRedefinedMidTickWhileParked(void)
{
    VIBES_TEST("servo.frame-redefined-mid-tick-while-parked",
               "src/DEV/dev_servo.c#dev_servo_run",
               "a motor drive parked on its target whose position is redefined 100 mm away by another core between a control tick's encoder reading and its use of it");
    VIBES_EXPECT("no-stall", "no stall is reported at any point");
    VIBES_EXPECT_WHY("holds-in-new-frame",
                     "the drive holds at the new position with no following error and reports arrival there",
                     "the redefinition moves the setpoint with the frame, even when the tick that overlaps it was about to park the setpoint on the old target");
    park_at_origin();
    d_redefineTo = counts_from_mm(100.0);
    d_afterReadHook = redefine_frame;
    tick();
    TEST_ASSERT_NULL(d_afterReadHook);
    bool everStalled = dev_servo_isStalled(CH);
    for (int i = 0; i < 100; i++)
    {
        tick();
        everStalled = everStalled || dev_servo_isStalled(CH);
    }
    TEST_ASSERT_FALSE(everStalled);
    TEST_ASSERT_EQUAL_INT32(0, dev_servo_getFollowingError(CH));
    TEST_ASSERT_TRUE(dev_servo_atTarget(CH));
    TEST_ASSERT_EQUAL_INT32(d_redefineTo, dev_servo_getPosition(CH));
}


void test_dev_servo_pulsesAtTheProfileScale(void)
{
    VIBES_TEST("servo.pulses-at-profile-scale",
               "src/DEV/dev_servo.c#dev_servo_private_applyVelocity",
               "a machine profile whose drive takes half as many steps per millimetre as the encoder counts, then a steady speed of 20000 encoder counts per second");
    VIBES_EXPECT_WHY("half-rate",
                     "the drive is pulsed at 10000 steps per second",
                     "each step moves the carriage two encoder counts, so the speed asked for in counts is reached at half the step rate");
    servo_init_scaled(SHIPPED_MAX_VEL_COUNTS, SHIPPED_MAX_ACCEL_COUNTS, 8192, 4096);
    dev_servo_enable(CH, true);
    dev_servo_setVelocity(CH, 20000);
    /* A carriage that moves two counts a step, so the loop runs on feedforward. */
    for (int i = 0; i < 500; i++)
    {
        tick_with_share(2.0);
    }
    TEST_ASSERT_UINT32_WITHIN(20U, 10000U, d_pulseRate);
}

void test_dev_servo_moveAtProfileScaleArrivesWithoutStall(void)
{
    VIBES_TEST("servo.move-at-profile-scale",
               "src/DEV/dev_servo.c#dev_servo_run",
               "a machine profile whose drive takes half as many steps per millimetre as the encoder counts, and a 20 mm move at full speed with a carriage that moves two encoder counts per step");
    VIBES_EXPECT("arrives", "the drive reports arrival within the parking deadband of the target");
    VIBES_EXPECT("no-stall", "no stall is reported at any point");
    servo_init_scaled(SHIPPED_MAX_VEL_COUNTS, SHIPPED_MAX_ACCEL_COUNTS, 8192, 4096);
    dev_servo_enable(CH, true);
    const int32_t target = counts_from_mm(20.0);
    dev_servo_moveTo(CH, target, 0);
    bool everStalled = false;
    int ticks = 0;
    do
    {
        tick_with_share(2.0);
        everStalled = everStalled || dev_servo_isStalled(CH);
        ticks++;
    } while ((ticks < 20000) && !dev_servo_atTarget(CH));
    TEST_ASSERT_TRUE(dev_servo_atTarget(CH));
    TEST_ASSERT_INT32_WITHIN(8, target, d_encoderValue);
    TEST_ASSERT_FALSE(everStalled);
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

    /* Inside the machine's envelope while still demanding a real ramp-in. */
    const double maxAccel = (double)dev_servo_channelConfig[CH].maxAccel;
    const double amplitude = 10000.0; /* counts */
    const double freq = 1.0;          /* Hz    */
    const double omega = 6.283185307179586 * freq;
    const double vPeak = omega * amplitude;
    const double predictedDeficit = (vPeak * vPeak) / (2.0 * maxAccel);

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

/* ---------------------------------------------------------------------------
 * OSCILLATE: the driver owns the trajectory, so the deficit cannot arise.
 *
 * The companion to `open_loop_waveform_velocity_leaves_a_permanent_position_
 * deficit` above. Same perfect plant, same amplitude and frequency -- the only
 * difference is that the trajectory is EVALUATED from phase here rather than
 * integrated from a streamed rate, so there is no accumulator to fall behind.
 * ------------------------------------------------------------------------- */

/* Run a waveform to completion and report where the carriage came to rest.
 *
 * Ticking a fixed budget sized from `cycles / frequency` would be wrong: the
 * driver's waveform is approach + cycles + return, and only the middle part is
 * the cycles. Waiting on the driver's own completion is also the honest
 * assertion -- if `atTarget` never arrives, the test fails on the cap rather
 * than quietly measuring a half-finished run. */
static double run_oscillate(double amplitudeCounts, uint32_t freqMicroHz,
                            uint32_t cycles, dev_servo_wave_E shape)
{
    dev_servo_enable(CH, true);
    TEST_ASSERT_TRUE(dev_servo_startWaveform(CH, WF(0, (int32_t)amplitudeCounts, freqMicroHz, cycles, shape)));
    const double freqHz = (double)freqMicroHz / 1000000.0;
    /* The cycles, plus a generous allowance for the two profiled segments. */
    const unsigned cap = (unsigned)((double)cycles / freqHz / 0.001) + 4000U;
    unsigned i = 0U;
    while ((i < cap) && !dev_servo_atTarget(CH))
    {
        tick_with_motion();
        i++;
    }
    TEST_ASSERT_TRUE_MESSAGE(dev_servo_atTarget(CH),
                             "the waveform must report completion, not run forever");
    return d_carriage;
}

void test_oscillate_returns_to_its_centre_after_whole_cycles(void)
{
    VIBES_TEST("servo.oscillate-no-drift",
               "src/DEV/dev_servo.c#dev_servo_run",
               "a waveform run by the driver instead of streamed as velocity");
    VIBES_EXPECT_WHY("ends-where-it-started",
                     "the carriage ends a whole number of cycles back at its centre",
                     "the setpoint is evaluated from phase rather than integrated from a rate, so there is no accumulator that can fall behind and stay behind");
    VIBES_EXPECT_WHY("residual-does-not-grow-with-cycles",
                     "running four times as many cycles leaves exactly the same residual as one",
                     "drift and a settling offset both look like a small error at the end of one run; only running different cycle counts separates them, and an evaluated setpoint must show no per-cycle component at all");

    const int32_t deadband = dev_servo_channelConfig[CH].positionDeadband;

    /* Drift accumulates per cycle; a settling offset does not. Running 1, 2 and
     * 4 cycles is what tells them apart -- a single run cannot. */
    int32_t residual[3];
    unsigned n = 1U;
    for (unsigned i = 0U; i < 3U; i++)
    {
        servo_init();
        dev_servo_setPosition(CH, 0);
        (void)run_oscillate(10000.0, 1000000U, n, DEV_SERVO_WAVE_SINE);
        residual[i] = dev_servo_getPosition(CH);
        TEST_ASSERT_INT32_WITHIN_MESSAGE(deadband, 0, residual[i],
                                         "a whole number of cycles must come back to the centre");
        n *= 2U;
    }
    TEST_ASSERT_EQUAL_INT32_MESSAGE(residual[0], residual[2],
                                    "four cycles must leave the same residual as one — any "
                                    "difference is per-cycle drift, not settling");

    /* The generator's own reference, separate from the plant tracking it: if
     * the setpoint comes home exactly, the residual above is the loop settling
     * inside its deadband and not a defect in the trajectory. */
    TEST_ASSERT_EQUAL_FLOAT(0.0f, dev_servo_data.channel[CH].setpointPos);
}

void test_oscillate_counts_whole_cycles_and_stops(void)
{
    VIBES_TEST("servo.oscillate-counts-cycles-and-stops",
               "src/DEV/dev_servo.c#dev_servo_run",
               "a two-cycle waveform run to completion");
    VIBES_EXPECT("cycles-counted", "the driver reports two cycles completed");
    VIBES_EXPECT("arrival-reported", "the drive reports arrival");
    servo_init();
    dev_servo_setPosition(CH, 0);
    (void)run_oscillate(10000.0, 1000000U, 2U, DEV_SERVO_WAVE_SINE);
    TEST_ASSERT_EQUAL_UINT32(2U, dev_servo_waveformCyclesDone(CH));
    TEST_ASSERT_TRUE(dev_servo_atTarget(CH));
}

void test_an_unknown_wire_shape_is_refused_not_defaulted(void)
{
    VIBES_TEST("servo.wave-shape-from-wire",
               "src/DEV/dev_servo.c#dev_servo_waveShapeFromWire",
               "each of the 256 shape bytes the wire can carry, offered to the driver's converter");
    VIBES_EXPECT_WHY("known-bytes-convert",
                     "bytes 0 and 1 convert to the sine and triangle profiles and to nothing else",
                     "the shape byte is what selects the loading a specimen sees, so a converter that returned the wrong profile for a byte it does recognise would run the wrong test silently");
    VIBES_EXPECT_WHY("unknown-bytes-refused",
                     "every other byte is refused, and the caller's shape is left untouched",
                     "a newer host asking an older firmware for a profile it has never heard of must fail loudly: defaulting the unknown byte to a sine files a plausible record under a test that was never performed");

    /* The out-param starts at a value neither branch would naturally produce,
     * so "left untouched" is distinguishable from "written with a default". */
    dev_servo_wave_E shape = (dev_servo_wave_E)0xAB;

    TEST_ASSERT_TRUE(dev_servo_waveShapeFromWire(0U, &shape));
    TEST_ASSERT_EQUAL_INT(DEV_SERVO_WAVE_SINE, shape);
    TEST_ASSERT_TRUE(dev_servo_waveShapeFromWire(1U, &shape));
    TEST_ASSERT_EQUAL_INT(DEV_SERVO_WAVE_TRIANGLE, shape);

    /* 2..255 are reserved. Every one of them is a refusal, not a default --
     * swept rather than sampled, because a converter that special-cased one
     * reserved byte would pass a spot check. */
    for (uint32_t wire = 2U; wire <= 255U; wire++)
    {
        shape = (dev_servo_wave_E)0xAB;
        char msg[64];
        (void)snprintf(msg, sizeof(msg), "wire byte %u must be refused", (unsigned)wire);
        TEST_ASSERT_FALSE_MESSAGE(dev_servo_waveShapeFromWire((uint8_t)wire, &shape), msg);
        TEST_ASSERT_EQUAL_INT_MESSAGE(0xAB, (int)shape, msg);
    }

    /* A null destination is refused rather than dereferenced. */
    TEST_ASSERT_FALSE(dev_servo_waveShapeFromWire(0U, NULL));
}

void test_an_infeasible_waveform_is_rejected_not_approximated(void)
{
    VIBES_TEST("servo.infeasible-waveform-rejected",
               "src/DEV/dev_servo.c#dev_servo_startWaveform",
               "a waveform whose peak acceleration exceeds the machine");
    VIBES_EXPECT_WHY("refused",
                     "the driver refuses the move instead of running a smaller one",
                     "running whatever the limiter allows yields a specimen that never saw the loading the report claims, which on a fatigue test is a wrong result rather than a slow one");

    servo_init();
    /* maxAccel 500000 counts/s^2: omega^2*A at 10 Hz and 10000 counts is
     * ~39.5e6, far past it. */
    TEST_ASSERT_FALSE(dev_servo_waveformFeasible(CH, WF(0, 10000, 10000000U, 1U, DEV_SERVO_WAVE_SINE)));
    TEST_ASSERT_FALSE(dev_servo_startWaveform(CH, WF(0, 10000, 10000000U, 2U, DEV_SERVO_WAVE_SINE)));
    /* ...and a modest one is accepted. */
    TEST_ASSERT_TRUE(dev_servo_waveformFeasible(CH, WF(0, 10000, 1000000U, 1U, DEV_SERVO_WAVE_SINE)));
}

/* Mean |setpoint velocity| divided by peak, measured over the cycles only.
 *
 * This is the number that tells the two shapes apart no matter how either is
 * implemented. Both cover the same 2A per half cycle, so their MEAN rates are
 * equal and neither amplitude nor frequency nor the mean discriminates — only
 * the shape of the rate does. A sinusoid spends most of a half cycle away from
 * its peak (mean/peak = 2/pi ~ 0.64); a trapezoid holds its cruise rate for
 * most of it (~0.80 for this machine). */
static double run_oscillate_rateFullness(uint32_t freqMicroHz, dev_servo_wave_E shape)
{
    servo_init();
    dev_servo_setPosition(CH, 0);
    dev_servo_enable(CH, true);
    TEST_ASSERT_TRUE(dev_servo_startWaveform(CH, WF(0, 10000, freqMicroHz, 2U, shape)));

    double sum = 0.0;
    double peak = 0.0;
    unsigned samples = 0U;
    for (unsigned i = 0U; (i < 12000U) && !dev_servo_atTarget(CH); i++)
    {
        tick_with_motion();
        if (dev_servo_data.channel[CH].waveSegment == (uint8_t)DEV_SERVO_WAVE_RUN)
        {
            const double v = fabs((double)dev_servo_data.channel[CH].setpointVel);
            sum += v;
            if (v > peak) { peak = v; }
            samples++;
        }
    }
    TEST_ASSERT_TRUE_MESSAGE(samples > 100U, "the run segment must actually have been sampled");
    TEST_ASSERT_TRUE(peak > 0.0);
    return (sum / (double)samples) / peak;
}

void test_the_shape_bit_selects_a_genuinely_different_rate_profile(void)
{
    VIBES_TEST("servo.waveform-shape-is-honoured",
               "src/DEV/dev_servo.c#dev_servo_run",
               "the same centre, amplitude and frequency requested as SINE and as TRIANGLE");
    VIBES_EXPECT_WHY("different-rate-profiles",
                     "the two shapes produce measurably different rate profiles",
                     "both shapes travel the same 2A per half cycle, so a driver that silently ignored the shape bit would still pass every amplitude, frequency and return-to-centre check — only the fullness of the rate profile can catch it");

    const double sine = run_oscillate_rateFullness(1000000U, DEV_SERVO_WAVE_SINE);
    const double triangle = run_oscillate_rateFullness(1000000U, DEV_SERVO_WAVE_TRIANGLE);

    /* 2/pi for a sinusoid, by construction rather than by measurement. */
    TEST_ASSERT_FLOAT_WITHIN_MESSAGE(0.02f, 2.0f / 3.14159265f, (float)sine,
                                     "a sine's rate must average 2/pi of its peak");
    TEST_ASSERT_TRUE_MESSAGE(triangle > (sine + 0.1),
                             "a triangle must hold its rate closer to the peak than a sine does — "
                             "if these match, the shape bit is being ignored");
}

/* Worst |measured - ideal| over the cycles, in counts.
 *
 * The reference is recomputed HERE from the request, as a plain cosine, and is
 * never read back from the driver: comparing the driver against its own
 * setpoint would confirm that the tracker follows the generator while leaving
 * a wrong generator completely invisible. The measurement is the ENCODER --
 * where the machine actually went -- not the commanded velocity.
 *
 * Sampling starts at the first tick of the cycles and includes it. The
 * approach's residual is the error the waveform inherits at t=0, and excluding
 * it would hide exactly the defect that `waveformStartTolerance` exists to
 * prevent. */
static double worst_sine_deviation_at(int32_t centre, double amplitude, uint32_t freqMicroHz, uint32_t cycles)
{
    servo_init();
    dev_servo_setPosition(CH, centre);
    dev_servo_enable(CH, true);
    TEST_ASSERT_TRUE_MESSAGE(dev_servo_startWaveform(CH, WF(centre, (int32_t)amplitude, freqMicroHz, cycles, DEV_SERVO_WAVE_SINE)),
                             "the probe's own waveform must be feasible");

    const double freqHz = (double)freqMicroHz / 1000000.0;
    const unsigned cap = (unsigned)((double)cycles / freqHz / 0.001) + 8000U;
    unsigned runTicks = 0U;
    double worst = 0.0;
    for (unsigned i = 0U; (i < cap) && !dev_servo_atTarget(CH); i++)
    {
        const bool running =
            (dev_servo_data.channel[CH].waveSegment == (uint8_t)DEV_SERVO_WAVE_RUN);
        tick_with_motion();
        /* `running` was read BEFORE the tick. The tick that HANDS OVER to the
         * return segment satisfies it but is no longer cycling by the time the
         * encoder is read, and the reference below keeps evaluating the wave --
         * so that one sample compares the machine against a trajectory the
         * driver has already left. Require the segment to still be RUN after
         * the tick as well. */
        if (!running ||
            (dev_servo_data.channel[CH].waveSegment != (uint8_t)DEV_SERVO_WAVE_RUN))
        {
            continue;
        }
        runTicks++;
        const double t = (double)runTicks * 0.001;
        /* Phase 0 is the positive peak, so the trajectory is a cosine. */
        const double ideal = (double)centre + (amplitude * cos(2.0 * 3.14159265358979 * freqHz * t));
        const double err = fabs((double)d_encoderValue - ideal);
        if (err > worst) { worst = err; }
    }
    TEST_ASSERT_TRUE_MESSAGE(runTicks > 100U, "the cycles must actually have run");
    return worst;
}

void test_the_machine_reproduces_the_commanded_waveform_to_one_micron(void)
{
    VIBES_TEST("servo.waveform-tracks-to-one-micron",
               "src/DEV/dev_servo.c#dev_servo_run",
               "a feasible sine waveform, measured at the encoder against the requested trajectory");
    VIBES_EXPECT_WHY("within-one-micron",
                     "the measured position stays within 0.001 mm of the requested waveform for every tick of every cycle",
                     "a tensile result is only as good as the trajectory the specimen actually saw, so the claim that has to hold is about measured motion against the REQUEST — not against the driver's own setpoint, which a wrong generator would satisfy perfectly");

    /* A sweep, not a single point: the standing error this guards against
     * scales with the trajectory's acceleration, so one amplitude and one
     * frequency could pass while a more demanding pair fails. All four are
     * inside the machine's velocity and acceleration budget. */
    static const struct
    {
        double amplitude;
        uint32_t freqMicroHz;
        uint32_t cycles;
    } cases[] = {
        { 10000.0, 1000000U, 2U },
        { 5000.0, 1500000U, 2U },
        { 20000.0, 500000U, 2U },
        { 2000.0, 2000000U, 3U },
    };

    for (unsigned i = 0U; i < (sizeof(cases) / sizeof(cases[0])); i++)
    {
        const double worst = worst_sine_deviation_at(0, cases[i].amplitude,
                                                     cases[i].freqMicroHz, cases[i].cycles);
        char msg[128];
        (void)snprintf(msg, sizeof(msg),
                       "amplitude %.0f counts at %u uHz deviated %.2f counts (%.4f mm)",
                       cases[i].amplitude, cases[i].freqMicroHz, worst, worst / COUNTS_PER_MM);
        TEST_ASSERT_TRUE_MESSAGE(worst <= ONE_MICRON_COUNTS, msg);
    }
}

/* Run the cycles and report both how many ticks they took and where the phase
 * accumulator came to rest. */
static unsigned run_segment_ticks(uint32_t freqMicroHz, uint32_t cycles, uint32_t *endPhase)
{
    servo_init();
    dev_servo_setPosition(CH, 0);
    dev_servo_enable(CH, true);
    TEST_ASSERT_TRUE(dev_servo_startWaveform(CH, WF(0, 10000, freqMicroHz, cycles, DEV_SERVO_WAVE_SINE)));
    unsigned runTicks = 0U;
    for (unsigned i = 0U; (i < 400000U) && !dev_servo_atTarget(CH); i++)
    {
        const bool running =
            (dev_servo_data.channel[CH].waveSegment == (uint8_t)DEV_SERVO_WAVE_RUN);
        tick_with_motion();
        if (running)
        {
            runTicks++;
            if (dev_servo_data.channel[CH].waveSegment != (uint8_t)DEV_SERVO_WAVE_RUN)
            {
                *endPhase = dev_servo_data.channel[CH].wavePhase; /* the tick that finished it */
            }
        }
    }
    return runTicks;
}

void test_the_phase_accumulator_loses_nothing_over_whole_cycles(void)
{
    VIBES_TEST("servo.exact-phase-accumulator",
               "src/DEV/dev_servo.c#dev_servo_private_phaseStep",
               "a waveform whose period is a whole number of control ticks");
    VIBES_EXPECT_WHY("phase-lands-exactly-on-zero",
                     "the phase accumulator returns to exactly zero after a whole number of cycles",
                     "computing the step as (uint32)(freqHz*dt*2^32) discards a fraction of a phase unit every tick, always in the same direction, which is invisible over a few seconds and is 1.9 um of position error after an hour — a fatigue run is precisely the case that suffers and precisely the case a short test cannot see");
    VIBES_EXPECT_WHY("period-exact-to-within-a-tick",
                     "the cycles occupy the requested duration to better than one control tick",
                     "a cycle cannot end between ticks, so one tick is the floor; anything worse is the generator's own frequency error rather than sampling");

    /* Frequencies whose period is a whole number of 1 ms ticks, so the ideal
     * duration is exactly representable and any error is the accumulator's. */
    static const struct
    {
        uint32_t freqMicroHz;
        uint32_t cycles;
    } cases[] = {
        { 1000000U, 2U },  /* 1 Hz     -> 1000 ticks/cycle */
        { 1000000U, 10U }, /* 1 Hz, longer run              */
        { 500000U, 3U },   /* 0.5 Hz   -> 2000 ticks/cycle  */
        { 250000U, 2U },   /* 0.25 Hz  -> 4000 ticks/cycle  */
        { 800000U, 4U },   /* 0.8 Hz   -> 1250 ticks/cycle  */
    };

    for (unsigned i = 0U; i < (sizeof(cases) / sizeof(cases[0])); i++)
    {
        uint32_t endPhase = 0xFFFFFFFFU;
        const unsigned got = run_segment_ticks(cases[i].freqMicroHz, cases[i].cycles, &endPhase);
        const double ideal = (double)cases[i].cycles * 1e9 / (double)cases[i].freqMicroHz;

        char msg[160];
        (void)snprintf(msg, sizeof(msg),
                       "%u uHz x %u cycles: phase came to rest at %u, not 0 — the accumulator "
                       "is losing a fraction of a unit per tick",
                       cases[i].freqMicroHz, cases[i].cycles, endPhase);
        TEST_ASSERT_EQUAL_UINT32_MESSAGE(0U, endPhase, msg);

        (void)snprintf(msg, sizeof(msg), "%u uHz x %u cycles took %u ticks, ideal %.3f",
                       cases[i].freqMicroHz, cases[i].cycles, got, ideal);
        TEST_ASSERT_TRUE_MESSAGE(fabs((double)got - ideal) < 1.0, msg);
    }
}

void test_tracking_does_not_degrade_along_the_machine(void)
{
    VIBES_TEST("servo.waveform-tracking-is-position-independent",
               "src/DEV/dev_servo.c#dev_servo_private_waveExcursion",
               "the same waveform commanded at five points across the machine's 3000 mm travel");
    VIBES_EXPECT_WHY("identical-at-every-centre",
                     "the worst deviation is the same at 3000 mm as it is at the origin",
                     "a float's ulp is 2 counts at the far end of the travel, so differencing two ABSOLUTE positions to get a velocity would fold a rounding error into a per-tick displacement of only ~63 counts; differencing the excursion instead keeps the arithmetic on small numbers, and the way to prove that is a result with no position term in it at all");

    const int32_t centres[] = { 0, 819200, 8192000, 16384000, 24576000 };
    double first = -1.0;
    for (unsigned i = 0U; i < (sizeof(centres) / sizeof(centres[0])); i++)
    {
        const double worst = worst_sine_deviation_at(centres[i], 10000.0, 1000000U, 2U);
        char msg[160];
        (void)snprintf(msg, sizeof(msg), "at centre %d counts (%.0f mm) the deviation was %.2f counts",
                       centres[i], (double)centres[i] / 8192.0, worst);
        TEST_ASSERT_TRUE_MESSAGE(worst <= ONE_MICRON_COUNTS, msg);
        if (i == 0U)
        {
            first = worst;
        }
        else
        {
            /* Not exact equality any more. With the feedforward exact, every
             * centre now sits at the ENCODER ROUNDING FLOOR (~0.5-0.7 counts),
             * and which side of a count a sample lands on legitimately differs
             * between centres. Holding all of them AT that floor is the
             * stronger statement anyway: the defect this guards against --
             * differencing two absolute positions, where a float's ulp is 2
             * counts at the far end of the travel -- would put 3000 mm at
             * around 2 counts, far outside it. */
            /* The bound is the encoder's rounding floor PLUS the float's own
             * resolution at this position, because `setpointPos` is a float:
             * its ulp is 1 count at 2000 mm and 2 counts at 3000 mm, so the
             * commanded position itself cannot be finer than that out there.
             * Stating the limit is the point -- it is now the largest term in
             * the budget at the far end of the travel, and it only became
             * visible once the feedforward stopped dominating. */
            const double ulp =
                (centres[i] == 0) ? 0.0 : ldexp(1.0, ilogb((double)centres[i]) - 23);
            const double bound = 1.0 + (2.0 * ulp);
            (void)snprintf(msg, sizeof(msg),
                           "deviation at %.0f mm was %.2f counts; the floor there is 1 count of "
                           "encoder rounding plus %.2f counts of float resolution in setpointPos",
                           (double)centres[i] / 8192.0, worst, 2.0 * ulp);
            TEST_ASSERT_TRUE_MESSAGE(worst <= bound, msg);
            (void)first;
        }
    }
}

/* The highest frequency the driver will still accept at this amplitude, found
 * by asking the driver itself rather than by recomputing its rule here. */
static uint32_t highest_feasible_freq(int32_t amplitude, dev_servo_wave_E shape)
{
    uint32_t lo = 1U;          /* 1 uHz: always feasible                 */
    uint32_t hi = 100000000U;  /* 100 Hz: far past any real capability   */
    TEST_ASSERT_TRUE(dev_servo_waveformFeasible(CH, WF(0, amplitude, lo, 1U, shape)));
    TEST_ASSERT_FALSE(dev_servo_waveformFeasible(CH, WF(0, amplitude, hi, 1U, shape)));
    while ((hi - lo) > 1U)
    {
        const uint32_t mid = lo + ((hi - lo) / 2U);
        if (dev_servo_waveformFeasible(CH, WF(0, amplitude, mid, 1U, shape))) { lo = mid; }
        else { hi = mid; }
    }
    return lo;
}

/* Run a waveform and report the geometry the driver actually produced:
 * how long it held each peak, and how the traversing time split.
 *
 * The holds are counted from the commanded setpoint, where a hold is exact
 * equality with the peak; the machine's part is checked separately by
 * asserting it does not move while the hold is commanded. */
typedef struct
{
    unsigned runTicks;
    unsigned highTicks;    /* commanded hold at +A            */
    unsigned lowTicks;     /* commanded hold at -A            */
    unsigned downTicks;    /* traversing +A -> -A             */
    unsigned upTicks;      /* traversing -A -> +A             */
    double driftDuringHold; /* worst encoder movement while held */
} wave_geometry_S;

static wave_geometry_S measure_geometry(const dev_servo_waveform_S *wf)
{
    wave_geometry_S g;
    memset(&g, 0, sizeof(g));
    servo_init();
    dev_servo_setPosition(CH, wf->centreCounts);
    dev_servo_enable(CH, true);
    TEST_ASSERT_TRUE_MESSAGE(dev_servo_startWaveform(CH, wf), "the probe's waveform must be feasible");

    const float peak = (float)(wf->centreCounts + wf->amplitudeCounts);
    const float trough = (float)(wf->centreCounts - wf->amplitudeCounts);
    int32_t holdStartEnc = 0;
    bool holding = false;
    float prevSp = 0.0f;
    bool havePrev = false;

    for (unsigned i = 0U; (i < 400000U) && !dev_servo_atTarget(CH); i++)
    {
        const bool running =
            (dev_servo_data.channel[CH].waveSegment == (uint8_t)DEV_SERVO_WAVE_RUN);
        const float sp = dev_servo_data.channel[CH].setpointPos;
        tick_with_motion();
        if (!running) { continue; }
        g.runTicks++;

        const bool atPeak = (sp == peak);
        const bool atTrough = (sp == trough);
        if (atPeak) { g.highTicks++; }
        else if (atTrough) { g.lowTicks++; }
        else if (havePrev && (sp < prevSp)) { g.downTicks++; }
        else { g.upTicks++; }

        /* While a hold is commanded the machine must stay put. */
        if (atPeak || atTrough)
        {
            if (!holding) { holdStartEnc = d_encoderValue; holding = true; }
            const double moved = fabs((double)d_encoderValue - (double)holdStartEnc);
            if (moved > g.driftDuringHold) { g.driftDuringHold = moved; }
        }
        else { holding = false; }
        prevSp = sp;
        havePrev = true;
    }
    return g;
}

/* Share of a peak-to-peak traverse covered at normalised time u in [0,1].
 * Recomputed from the published formula, not from the driver. */
static double traverse_share(dev_servo_wave_E shape, double ramp, double u)
{
    if (u < 0.0) { u = 0.0; }
    if (u > 1.0) { u = 1.0; }
    if (shape == DEV_SERVO_WAVE_TRIANGLE)
    {
        if (ramp <= 0.0) { return u; }
        const double flat = 1.0 - ramp;
        if (flat <= 0.0) { return u; }
        if (u < ramp) { return (u * u) / (2.0 * ramp * flat); }
        if (u <= flat) { return (u - (0.5 * ramp)) / flat; }
        const double w = 1.0 - u;
        return 1.0 - ((w * w) / (2.0 * ramp * flat));
    }
    return 0.5 * (1.0 - cos(M_PI * u));
}

static double triangle_ramp_share(double amplitude, double tau, double maxAccel)
{
    if ((tau <= 0.0) || (maxAccel <= 0.0) || (amplitude <= 0.0)) { return 0.0; }
    const double k = (8.0 * amplitude) / (maxAccel * tau * tau);
    if (k >= 1.0) { return 0.5; }
    return 0.5 * (1.0 - sqrt(1.0 - k));
}

/* The commanded template, recomputed here in double precision from the
 * REQUEST. An independent statement of the same specification, so a wrong
 * segment boundary, an inverted skew or a transcribed formula shows up as a
 * position error rather than agreeing with itself. */
static double template_ideal(const dev_servo_waveform_S *wf, double phase)
{
    const double A = (double)wf->amplitudeCounts;
    const double period = 1e6 / (double)wf->freqMicroHz;
    const double fHigh = ((double)wf->dwellHighUs / 1e6) / period;
    const double fLow = ((double)wf->dwellLowUs / 1e6) / period;
    const double fTrav = 1.0 - fHigh - fLow;
    const double fDown = fTrav * ((double)wf->skewPerMille / 1000.0);
    const double fUp = fTrav - fDown;
    const double maxAccel = (double)dev_servo_channelConfig[CH].maxAccel;
    const double rDown = (wf->shape == DEV_SERVO_WAVE_TRIANGLE)
                             ? triangle_ramp_share(A, fDown * period, maxAccel)
                             : 0.0;
    const double rUp = (wf->shape == DEV_SERVO_WAVE_TRIANGLE)
                           ? triangle_ramp_share(A, fUp * period, maxAccel)
                           : 0.0;

    double p = phase;
    if (p < fHigh) { return (double)wf->centreCounts + A; }
    p -= fHigh;
    if (p < fDown)
    {
        const double u = (fDown > 0.0) ? (p / fDown) : 1.0;
        return (double)wf->centreCounts + A - (2.0 * A * traverse_share(wf->shape, rDown, u));
    }
    p -= fDown;
    if (p < fLow) { return (double)wf->centreCounts - A; }
    p -= fLow;
    double u = (fUp > 0.0) ? (p / fUp) : 1.0;
    if (u > 1.0) { u = 1.0; }
    return (double)wf->centreCounts - A + (2.0 * A * traverse_share(wf->shape, rUp, u));
}

static double worst_template_deviation(const dev_servo_waveform_S *wf)
{
    servo_init();
    dev_servo_setPosition(CH, wf->centreCounts);
    dev_servo_enable(CH, true);
    TEST_ASSERT_TRUE_MESSAGE(dev_servo_startWaveform(CH, wf), "the probe's waveform must be feasible");

    const double freqHz = (double)wf->freqMicroHz / 1e6;
    unsigned runTicks = 0U;
    double worst = 0.0;
    for (unsigned i = 0U; (i < 400000U) && !dev_servo_atTarget(CH); i++)
    {
        const bool running =
            (dev_servo_data.channel[CH].waveSegment == (uint8_t)DEV_SERVO_WAVE_RUN);
        tick_with_motion();
        if (!running) { continue; }
        runTicks++;
        const double phase = fmod((double)runTicks * 0.001 * freqHz, 1.0);
        const double err = fabs((double)d_encoderValue - template_ideal(wf, phase));
        if (err > worst) { worst = err; }
    }
    TEST_ASSERT_TRUE(runTicks > 100U);
    return worst;
}

void test_dwell_and_skew_still_track_to_one_micron(void)
{
    VIBES_TEST("servo.dwell-and-skew-track-to-one-micron",
               "src/DEV/dev_servo.c#dev_servo_run",
               "waveforms with a hold at one peak, with a skewed traverse, and with both");
    VIBES_EXPECT_WHY("contract-survives-the-new-parameters",
                     "a held or skewed cycle is followed within 0.001 mm just as a plain one is",
                     "dwell and skew introduce places where the commanded velocity changes abruptly — entering and leaving a hold, and at the junction of two unequal traverses — and those are exactly where a trajectory stops being deliverable");

    dev_servo_waveform_S held = *WF(0, 10000, 500000U, 2U, DEV_SERVO_WAVE_SINE);
    held.dwellHighUs = 400000U;

    dev_servo_waveform_S skewed = *WF(0, 10000, 500000U, 2U, DEV_SERVO_WAVE_SINE);
    skewed.skewPerMille = 800U;

    dev_servo_waveform_S both = *WF(0, 8000, 500000U, 2U, DEV_SERVO_WAVE_SINE);
    both.dwellHighUs = 300000U;
    both.dwellLowUs = 100000U;
    both.skewPerMille = 700U;

    const struct { const dev_servo_waveform_S *wf; const char *what; } cases[] = {
        { &held, "hold at the upper peak" },
        { &skewed, "80/20 skew" },
        { &both, "asymmetric holds and skew together" },
    };
    for (unsigned i = 0U; i < 3U; i++)
    {
        const double worst = worst_template_deviation(cases[i].wf);
        char msg[160];
        (void)snprintf(msg, sizeof(msg), "%s deviated %.2f counts (%.4f mm)", cases[i].what,
                       worst, worst / COUNTS_PER_MM);
        printf("  %-38s worst %.2f counts (%.3f um)\n", cases[i].what, worst,
               worst / COUNTS_PER_MM * 1000.0);
        TEST_ASSERT_TRUE_MESSAGE(worst <= ONE_MICRON_COUNTS, msg);
    }
}

void test_a_move_does_not_run_ahead_of_its_own_trajectory(void)
{
    VIBES_TEST("servo.position-move-tracks-its-trajectory",
               "src/DEV/dev_servo.c#dev_servo_run",
               "a constant-velocity position move at three speeds an order of magnitude apart");
    VIBES_EXPECT_WHY("within-a-micron",
                     "the machine stays within 0.001 mm of the position its own profile commands",
                     "a point-to-point move that arrives at the right place can still have travelled a different path to get there, and on a tensile test the path IS the loading history");
    VIBES_EXPECT_WHY("offset-does-not-scale-with-speed",
                     "the offset at 25 mm/s is the same as at 5 mm/s",
                     "commanding the END-of-interval velocity rather than the interval average puts the machine exactly one control tick of travel ahead of its trajectory — an error invisible at low speed and proportional to it, which is the signature this check exists to catch");

    const int32_t mv = dev_servo_channelConfig[CH].maxVelocity;
    const int32_t feeds[3] = { mv / 10, mv / 4, mv / 2 };
    double offset[3];

    for (unsigned k = 0U; k < 3U; k++)
    {
        servo_init();
        dev_servo_setPosition(CH, 0);
        dev_servo_enable(CH, true);
        dev_servo_moveTo(CH, 100 * 8192, feeds[k]);

        double sum = 0.0;
        unsigned n = 0U;
        double prevV = 0.0;
        for (unsigned i = 0U; (i < 200000U) && !dev_servo_atTarget(CH); i++)
        {
            tick_with_motion();
            const double sp = (double)dev_servo_data.channel[CH].setpointPos;
            const double v = fabs((double)dev_servo_data.channel[CH].setpointVel);
            /* cruising: the profile has stopped changing speed */
            if ((fabs(v - prevV) < 1.0) && (v > 1.0))
            {
                sum += (double)d_encoderValue - sp;
                n++;
            }
            prevV = v;
        }
        TEST_ASSERT_TRUE_MESSAGE(n > 50U, "the move must actually reach a cruise");
        offset[k] = sum / (double)n;

        char msg[160];
        (void)snprintf(msg, sizeof(msg),
                       "at %.1f mm/s the machine sat %+.1f counts (%+.2f um) from its own "
                       "trajectory; one tick of travel here is %.0f counts",
                       feeds[k] / 8192.0, offset[k], offset[k] / COUNTS_PER_MM * 1000.0,
                       (double)feeds[k] * 0.001);
        TEST_ASSERT_TRUE_MESSAGE(fabs(offset[k]) <= ONE_MICRON_COUNTS, msg);
    }

    /* The discriminating half. A one-tick convention error is proportional to
     * speed, so it hides at 5 mm/s and only shows at 25 -- an absolute bound
     * alone would pass the slow case and call it tested. */
    char msg[176];
    (void)snprintf(msg, sizeof(msg),
                   "offset was %+.1f counts at %.1f mm/s but %+.1f at %.1f mm/s — an offset that "
                   "grows with speed is a control-tick of travel, not noise",
                   offset[0], feeds[0] / 8192.0, offset[2], feeds[2] / 8192.0);
    TEST_ASSERT_TRUE_MESSAGE(fabs(offset[2] - offset[0]) < 2.0, msg);
}

void test_a_hold_at_one_peak_only(void)
{
    VIBES_TEST("servo.waveform-asymmetric-dwell",
               "src/DEV/dev_servo.c#dev_servo_private_waveExcursion",
               "a waveform asked to hold at the upper peak and not at the lower one");
    VIBES_EXPECT_WHY("holds-only-where-asked",
                     "the carriage holds at the upper peak for the requested time and does not hold at the lower one",
                     "creep-fatigue is a hold at peak tension with no hold in compression, so a single symmetric dwell parameter cannot express the test that most needs one");
    VIBES_EXPECT_WHY("hold-is-stationary",
                     "the machine does not move while a hold is commanded",
                     "a hold that drifts is a slow ramp, and the specimen sees a different load history than the report claims");
    VIBES_EXPECT_WHY("period-is-unchanged",
                     "the cycle still takes 1/f — the hold takes its time from the traverses, not from the period",
                     "if dwell extended the period, adding a hold would silently change the frequency of a fatigue test");

    /* 0.5 Hz (2000 ticks/cycle), 0.4 s held at the top, nothing at the bottom. */
    dev_servo_waveform_S wf = *WF(0, 10000, 500000U, 2U, DEV_SERVO_WAVE_SINE);
    wf.dwellHighUs = 400000U;
    const wave_geometry_S g = measure_geometry(&wf);

    /* 2 cycles x 400 ticks of hold. Allow a tick per cycle of edge rounding. */
    TEST_ASSERT_INT_WITHIN_MESSAGE(4, 800, (int)g.highTicks,
                                   "the upper hold must last the time it was given");
    /* Not exactly zero: a traverse ENDS exactly on -A, so a tick can land on
     * the endpoint and read as a hold. The claim that matters is that the
     * lower peak is passed through rather than dwelt on. */
    TEST_ASSERT_TRUE_MESSAGE(g.lowTicks <= 4U,
                             "no hold was asked for at the lower peak, so it must be passed "
                             "through, not dwelt on");
    TEST_ASSERT_TRUE_MESSAGE(g.highTicks > (20U * g.lowTicks),
                             "the upper peak must be held and the lower one not");
    TEST_ASSERT_TRUE_MESSAGE(g.driftDuringHold <= 2.0,
                             "the machine must stand still while a hold is commanded");
    TEST_ASSERT_INT_WITHIN_MESSAGE(4, 4000, (int)g.runTicks,
                                   "two cycles at 0.5 Hz must still take two seconds");
}

void test_skew_splits_the_traverse_time_as_asked(void)
{
    VIBES_TEST("servo.waveform-skew",
               "src/DEV/dev_servo.c#dev_servo_private_planWaveform",
               "a waveform asked to spend 80% of its traversing time loading and 20% unloading");
    VIBES_EXPECT_WHY("asymmetric-rate",
                     "the descending traverse takes four times as long as the ascending one",
                     "slow-load/fast-unload is an ordinary loading history, and a symmetric cycle cannot express it at any amplitude or frequency");

    dev_servo_waveform_S wf = *WF(0, 10000, 500000U, 2U, DEV_SERVO_WAVE_SINE);
    wf.skewPerMille = 800U; /* 80% of the traverse spent going down */
    const wave_geometry_S g = measure_geometry(&wf);

    /* 2 cycles x 2000 ticks: 1600 down, 400 up per cycle. */
    TEST_ASSERT_INT_WITHIN_MESSAGE(8, 3200, (int)g.downTicks, "the down traverse must take 80%");
    TEST_ASSERT_INT_WITHIN_MESSAGE(8, 800, (int)g.upTicks, "the up traverse must take 20%");
}

void test_a_cycle_whose_holds_leave_no_time_to_move_is_refused(void)
{
    VIBES_TEST("servo.waveform-overfull-cycle-refused",
               "src/DEV/dev_servo.c#dev_servo_private_planWaveform",
               "holds that together ask for more than the whole period");
    VIBES_EXPECT_WHY("refused",
                     "the driver refuses the cycle rather than shortening the holds to fit",
                     "silently trimming a hold gives a specimen a different dwell than the report claims, and dwell is the variable the test exists to study");

    servo_init();
    /* 1 Hz: one second per cycle, and 0.6 + 0.6 s of holds asked for. */
    dev_servo_waveform_S wf = *WF(0, 10000, 1000000U, 2U, DEV_SERVO_WAVE_SINE);
    wf.dwellHighUs = 600000U;
    wf.dwellLowUs = 600000U;
    TEST_ASSERT_FALSE(dev_servo_waveformFeasible(CH, &wf));
    TEST_ASSERT_FALSE(dev_servo_startWaveform(CH, &wf));

    /* And a skew so extreme that the short traverse cannot be delivered, even
     * though the same cycle is perfectly achievable symmetrically. */
    dev_servo_waveform_S fast = *WF(0, 40000, 1000000U, 2U, DEV_SERVO_WAVE_SINE);
    fast.skewPerMille = 990U; /* 1% of the period to cover the whole stroke */
    TEST_ASSERT_FALSE_MESSAGE(dev_servo_waveformFeasible(CH, &fast),
                              "a traverse can be impossible in one direction only");
}

void test_the_one_micron_contract_holds_at_the_feasibility_boundary(void)
{
    VIBES_TEST("servo.one-micron-at-the-limit",
               "src/DEV/dev_servo.c#dev_servo_run",
               "the most demanding waveform the driver will accept at each of several amplitudes");
    VIBES_EXPECT_WHY("contract-holds-at-the-limit",
                     "the fastest accepted waveform still tracks within 0.001 mm",
                     "a tolerance demonstrated only on comfortable inputs says nothing about the ones a user will actually reach for; the claim that matters is that ACCEPTANCE implies the contract, so the test walks to the exact edge of what the driver permits and checks there");

    static const int32_t amplitudes[] = { 500, 2000, 10000, 40000 };
    for (unsigned i = 0U; i < (sizeof(amplitudes) / sizeof(amplitudes[0])); i++)
    {
        const uint32_t f = highest_feasible_freq(amplitudes[i], DEV_SERVO_WAVE_SINE);
        const double worst = worst_sine_deviation_at(0, (double)amplitudes[i], f, 2U);
        char msg[176];
        (void)snprintf(msg, sizeof(msg),
                       "amplitude %d counts at its maximum accepted %u uHz (%.3f Hz) deviated "
                       "%.2f counts (%.4f mm)",
                       amplitudes[i], f, (double)f / 1e6, worst, worst / COUNTS_PER_MM);
        /* The CONTRACT is 1 um. This guards at 0.75 um because the demonstrated
         * capability is 0.48 um, and the margin between them is not spare room
         * -- it is what the interval-average feedforward buys.
         *
         * The guard is ONE COUNT: with the feedforward exact, the cycles track
         * to the encoder's own rounding floor, so anything above a count is a
         * real term and not quantisation. That is 8x tighter than the contract
         * and is what actually holds the improvement in place. */
        TEST_ASSERT_TRUE_MESSAGE(worst <= ONE_MICRON_COUNTS, msg);
        TEST_ASSERT_TRUE_MESSAGE(worst <= 1.0, msg);
        printf("  limit: A=%6d counts -> %8u uHz (%.3f Hz), worst %.2f counts (%.3f um)\n",
               amplitudes[i], f, (double)f / 1e6, worst, worst / COUNTS_PER_MM * 1000.0);
    }
}

void test_a_triangle_is_a_trapezoidal_rate_not_an_infinite_corner(void)
{
    VIBES_TEST("servo.triangle-is-feasible",
               "src/DEV/dev_servo.c#dev_servo_run",
               "a triangle waveform, whose mathematical corners demand infinite acceleration");
    VIBES_EXPECT_WHY("bounded-rate",
                     "the driver runs a trapezoidal rate profile whose corners fit the acceleration limit",
                     "a literal triangle reverses velocity instantaneously, so handing one to the tracker would hand it something no machine can follow");

    servo_init();
    dev_servo_setPosition(CH, 0);
    (void)run_oscillate(10000.0, 1000000U, 2U, DEV_SERVO_WAVE_TRIANGLE);
    TEST_ASSERT_INT32_WITHIN_MESSAGE(dev_servo_channelConfig[CH].positionDeadband, 0,
                                     dev_servo_getPosition(CH),
                                     "a whole number of triangle cycles must also return to centre");
}

/* Two deadbands. The last few counts of a point-to-point move are the park
 * (the encoder stops correcting inside positionDeadband); that landing is a
 * different contract. The 1 um claim is about the trajectory WHILE MOVING. */
#define LANDING_COUNTS 16.0

/* Closed-form trapezoid: travel `dist` (signed) at cruise `v` limited by
 * acceleration `a`, starting from rest at t=0. Returns displacement from the
 * start, so the ideal position is start + this. */
static double trapezoid_travel(double dist, double v, double a, double t)
{
    const double D = fabs(dist);
    const double sign = (dist >= 0.0) ? 1.0 : -1.0;
    if ((D <= 0.0) || (v <= 0.0) || (a <= 0.0) || (t <= 0.0)) { return 0.0; }

    const double sAcc = (v * v) / (2.0 * a);
    if ((2.0 * sAcc) >= D)
    {
        const double vPeak = sqrt(a * D);
        const double tAcc = vPeak / a;
        const double tTotal = 2.0 * tAcc;
        if (t >= tTotal) { return dist; }
        if (t <= tAcc) { return sign * 0.5 * a * t * t; }
        const double td = tTotal - t;
        return sign * (D - (0.5 * a * td * td));
    }

    const double tAcc = v / a;
    const double tCruise = (D - (2.0 * sAcc)) / v;
    const double tTotal = (2.0 * tAcc) + tCruise;
    if (t >= tTotal) { return dist; }
    if (t <= tAcc) { return sign * 0.5 * a * t * t; }
    if (t <= (tAcc + tCruise)) { return sign * (sAcc + (v * (t - tAcc))); }
    const double td = tTotal - t;
    return sign * (D - (0.5 * a * td * td));
}

typedef struct
{
    double vsSetpoint; /* encoder vs the driver's commanded position, whole move */
    double vsProfile;  /* encoder vs the kinematic trapezoid, accel and cruise */
    unsigned samples;
    unsigned profileSamples;
} pos_dev_S;

static pos_dev_S measure_position_move(int32_t start, int32_t target, int32_t feed,
                                       int32_t maxVel, int32_t maxAccel)
{
    servo_init_envelope(maxVel, maxAccel);
    dev_servo_setPosition(CH, start);
    dev_servo_enable(CH, true);
    dev_servo_moveTo(CH, target, feed);

    pos_dev_S d;
    memset(&d, 0, sizeof(d));
    const double dist = (double)target - (double)start;
    const double cruise = (double)feed;
    const double accel = (double)maxAccel;
    /* Distance at which the closed-form trapezoid begins to brake. A move
     * that never reaches cruise (a triangle) brakes from the midpoint. */
    const double sAccCruise = (cruise * cruise) / (2.0 * accel);
    const double sBrake =
        ((2.0 * sAccCruise) >= fabs(dist)) ? (0.5 * fabs(dist)) : sAccCruise;

    for (unsigned i = 0U; (i < 400000U) && !dev_servo_atTarget(CH); i++)
    {
        tick_with_motion();
        const double t = (double)(i + 1U) * SERVO_DT_S;
        const double ideal = (double)start + trapezoid_travel(dist, cruise, accel, t);
        const double sp = (double)dev_servo_data.channel[CH].setpointPos;
        const double enc = (double)d_encoderValue;
        const double vel = fabs((double)dev_servo_data.channel[CH].setpointVel);

        /* Park: the encoder is inside the deadband and the profile has wound
         * down. Landing there is the deadband contract, not the 1 um one. */
        if ((vel < 1.0) && (fabs((double)target - enc) <= LANDING_COUNTS)) { continue; }
        if (fabs((double)target - sp) <= LANDING_COUNTS) { continue; }

        const double eSp = fabs(enc - sp);
        if (eSp > d.vsSetpoint) { d.vsSetpoint = eSp; }
        d.samples++;

        if (fabs((double)target - ideal) > (sBrake + LANDING_COUNTS))
        {
            const double ePr = fabs(enc - ideal);
            if (ePr > d.vsProfile) { d.vsProfile = ePr; }
            d.profileSamples++;
        }
    }
    TEST_ASSERT_TRUE_MESSAGE(d.samples > 20U, "the move must actually travel");
    TEST_ASSERT_TRUE_MESSAGE(d.profileSamples > 10U,
                             "accel and cruise must actually have been sampled");
    return d;
}

static double worst_cycle_on_current_machine(const dev_servo_waveform_S *wf)
{
    dev_servo_setPosition(CH, wf->centreCounts);
    dev_servo_enable(CH, true);
    TEST_ASSERT_TRUE_MESSAGE(dev_servo_startWaveform(CH, wf),
                             "the envelope case must be feasible on this machine");

    const double freqHz = (double)wf->freqMicroHz / 1e6;
    unsigned runTicks = 0U;
    double worst = 0.0;
    for (unsigned i = 0U; (i < 400000U) && !dev_servo_atTarget(CH); i++)
    {
        const bool running =
            (dev_servo_data.channel[CH].waveSegment == (uint8_t)DEV_SERVO_WAVE_RUN);
        tick_with_motion();
        if (!running ||
            (dev_servo_data.channel[CH].waveSegment != (uint8_t)DEV_SERVO_WAVE_RUN))
        {
            continue;
        }
        runTicks++;
        const double phase = fmod((double)runTicks * SERVO_DT_S * freqHz, 1.0);
        const double err = fabs((double)d_encoderValue - template_ideal(wf, phase));
        if (err > worst) { worst = err; }
    }
    TEST_ASSERT_TRUE_MESSAGE(runTicks > 100U, "the cycles must actually have run");
    return worst;
}

void test_position_moves_track_the_commanded_trapezoid_to_one_micron(void)
{
    VIBES_TEST("servo.position-move-one-micron-across-envelope",
               "src/DEV/dev_servo.c#dev_servo_run",
               "point-to-point moves at many distances, speeds and accelerations, in both directions, from rest at the origin and far along the gantry");
    VIBES_EXPECT_WHY("follows-the-setpoint",
                     "the encoder stays within 0.001 mm of the position the profile commands, on every moving tick",
                     "the specimen sees the encoder, so the loading history is the profile the loop is actually tracking");
    VIBES_EXPECT_WHY("matches-the-trapezoid",
                     "while accelerating and cruising, the encoder stays within 0.001 mm of the trapezoid that distance, speed and acceleration describe",
                     "a point-to-point move is that trapezoid, and the specimen sees every millimetre of it");

    const struct
    {
        const char *what;
        int32_t start;
        int32_t target;
        int32_t feed;
        int32_t maxVel;
        int32_t maxAccel;
    } cases[] = {
        /* Distance sweep at 10 mm/s, shipped acceleration. */
        { "0.5 mm at 10 mm/s", 0, counts_from_mm(0.5), counts_from_mm(10),
          SHIPPED_MAX_VEL_COUNTS, SHIPPED_MAX_ACCEL_COUNTS },
        { "2 mm at 10 mm/s", 0, counts_from_mm(2), counts_from_mm(10),
          SHIPPED_MAX_VEL_COUNTS, SHIPPED_MAX_ACCEL_COUNTS },
        { "10 mm at 10 mm/s", 0, counts_from_mm(10), counts_from_mm(10),
          SHIPPED_MAX_VEL_COUNTS, SHIPPED_MAX_ACCEL_COUNTS },
        { "50 mm at 10 mm/s", 0, counts_from_mm(50), counts_from_mm(10),
          SHIPPED_MAX_VEL_COUNTS, SHIPPED_MAX_ACCEL_COUNTS },
        { "200 mm at 10 mm/s", 0, counts_from_mm(200), counts_from_mm(10),
          SHIPPED_MAX_VEL_COUNTS, SHIPPED_MAX_ACCEL_COUNTS },
        /* Speed sweep at 10 mm, shipped acceleration. */
        { "10 mm at 1 mm/s", 0, counts_from_mm(10), counts_from_mm(1),
          SHIPPED_MAX_VEL_COUNTS, SHIPPED_MAX_ACCEL_COUNTS },
        { "10 mm at 5 mm/s", 0, counts_from_mm(10), counts_from_mm(5),
          SHIPPED_MAX_VEL_COUNTS, SHIPPED_MAX_ACCEL_COUNTS },
        { "10 mm at 15 mm/s", 0, counts_from_mm(10), counts_from_mm(15),
          SHIPPED_MAX_VEL_COUNTS, SHIPPED_MAX_ACCEL_COUNTS },
        { "10 mm at 40 mm/s", 0, counts_from_mm(10), counts_from_mm(40),
          SHIPPED_MAX_VEL_COUNTS, SHIPPED_MAX_ACCEL_COUNTS },
        /* Acceleration sweep at 10 mm / 15 mm/s. */
        { "10 mm at 150 mm/s^2", 0, counts_from_mm(10), counts_from_mm(15),
          SHIPPED_MAX_VEL_COUNTS, counts_from_mm(150) },
        { "10 mm at 300 mm/s^2", 0, counts_from_mm(10), counts_from_mm(15),
          SHIPPED_MAX_VEL_COUNTS, counts_from_mm(300) },
        { "10 mm at 600 mm/s^2", 0, counts_from_mm(10), counts_from_mm(15),
          SHIPPED_MAX_VEL_COUNTS, counts_from_mm(600) },
        /* Direction, origin, and a triangular (no-cruise) profile. */
        { "10 mm down at 10 mm/s", 0, counts_from_mm(-10), counts_from_mm(10),
          SHIPPED_MAX_VEL_COUNTS, SHIPPED_MAX_ACCEL_COUNTS },
        { "10 mm from 2000 mm", counts_from_mm(2000), counts_from_mm(2010),
          counts_from_mm(10), SHIPPED_MAX_VEL_COUNTS, SHIPPED_MAX_ACCEL_COUNTS },
        { "50 mm down from 100 mm", counts_from_mm(100), counts_from_mm(50),
          counts_from_mm(20), SHIPPED_MAX_VEL_COUNTS, SHIPPED_MAX_ACCEL_COUNTS },
        { "2 mm triangle at 150 mm/s^2", 0, counts_from_mm(2), counts_from_mm(40),
          SHIPPED_MAX_VEL_COUNTS, counts_from_mm(150) },
    };

    for (unsigned i = 0U; i < (sizeof(cases) / sizeof(cases[0])); i++)
    {
        const pos_dev_S got = measure_position_move(
            cases[i].start, cases[i].target, cases[i].feed, cases[i].maxVel, cases[i].maxAccel);
        const double bound = one_micron_bound_at(cases[i].start);
        char msg[192];
        printf("  %-36s vs setpoint %.2f counts (%.3f um)  vs trapezoid %.2f counts (%.3f um)\n",
               cases[i].what,
               got.vsSetpoint, got.vsSetpoint / COUNTS_PER_MM * 1000.0,
               got.vsProfile, got.vsProfile / COUNTS_PER_MM * 1000.0);
        (void)snprintf(msg, sizeof(msg),
                       "%s wandered %.2f counts (%.3f um) off the commanded profile "
                       "(bound %.2f counts)",
                       cases[i].what, got.vsSetpoint, got.vsSetpoint / COUNTS_PER_MM * 1000.0,
                       bound);
        TEST_ASSERT_TRUE_MESSAGE(got.vsSetpoint <= bound, msg);
        (void)snprintf(msg, sizeof(msg),
                       "%s sat %.2f counts (%.3f um) off the trapezoid of the request "
                       "during accel and cruise (bound %.2f counts)",
                       cases[i].what, got.vsProfile, got.vsProfile / COUNTS_PER_MM * 1000.0,
                       bound);
        TEST_ASSERT_TRUE_MESSAGE(got.vsProfile <= bound, msg);
    }
}

void test_waveforms_track_the_requested_cycle_to_one_micron_across_the_envelope(void)
{
    VIBES_TEST("servo.waveform-one-micron-across-envelope",
               "src/DEV/dev_servo.c#dev_servo_run",
               "cyclic waveforms of both traverse shapes, with and without holds and skew, at many amplitudes, frequencies and machine accelerations, including far along the gantry");
    VIBES_EXPECT_WHY("within-one-micron",
                     "the encoder stays within 0.001 mm of the requested cycle for every tick of every cycle",
                     "a tensile result is only as good as the trajectory the specimen actually saw, so the claim that has to hold is about measured motion against the request");

    const struct
    {
        const char *what;
        int32_t centre;
        int32_t amp;
        uint32_t freqMicroHz;
        uint32_t cycles;
        dev_servo_wave_E shape;
        uint32_t dwellHighUs;
        uint32_t dwellLowUs;
        uint16_t skew;
        int32_t maxVel;
        int32_t maxAccel;
    } cases[] = {
        { "sine 1.22 mm 1 Hz", 0, 10000, 1000000U, 2U, DEV_SERVO_WAVE_SINE,
          0U, 0U, DEV_SERVO_SKEW_SYMMETRIC, SHIPPED_MAX_VEL_COUNTS, SHIPPED_MAX_ACCEL_COUNTS },
        { "sine 0.25 mm 2 Hz", 0, counts_from_mm(0.25), 2000000U, 2U, DEV_SERVO_WAVE_SINE,
          0U, 0U, DEV_SERVO_SKEW_SYMMETRIC, SHIPPED_MAX_VEL_COUNTS, SHIPPED_MAX_ACCEL_COUNTS },
        { "sine 5 mm 0.5 Hz", 0, counts_from_mm(5), 500000U, 2U, DEV_SERVO_WAVE_SINE,
          0U, 0U, DEV_SERVO_SKEW_SYMMETRIC, SHIPPED_MAX_VEL_COUNTS, SHIPPED_MAX_ACCEL_COUNTS },
        { "sine 2.5 mm 1.5 Hz", 0, counts_from_mm(2.5), 1500000U, 2U, DEV_SERVO_WAVE_SINE,
          0U, 0U, DEV_SERVO_SKEW_SYMMETRIC, SHIPPED_MAX_VEL_COUNTS, SHIPPED_MAX_ACCEL_COUNTS },
        { "triangle 1.22 mm 1 Hz", 0, 10000, 1000000U, 2U, DEV_SERVO_WAVE_TRIANGLE,
          0U, 0U, DEV_SERVO_SKEW_SYMMETRIC, SHIPPED_MAX_VEL_COUNTS, SHIPPED_MAX_ACCEL_COUNTS },
        { "triangle 5 mm 0.5 Hz", 0, counts_from_mm(5), 500000U, 2U, DEV_SERVO_WAVE_TRIANGLE,
          0U, 0U, DEV_SERVO_SKEW_SYMMETRIC, SHIPPED_MAX_VEL_COUNTS, SHIPPED_MAX_ACCEL_COUNTS },
        { "sine hold at peak tension", 0, 10000, 500000U, 2U, DEV_SERVO_WAVE_SINE,
          400000U, 0U, DEV_SERVO_SKEW_SYMMETRIC, SHIPPED_MAX_VEL_COUNTS, SHIPPED_MAX_ACCEL_COUNTS },
        { "sine 80/20 skew", 0, 10000, 500000U, 2U, DEV_SERVO_WAVE_SINE,
          0U, 0U, 800U, SHIPPED_MAX_VEL_COUNTS, SHIPPED_MAX_ACCEL_COUNTS },
        { "sine holds and skew together", 0, 8000, 500000U, 2U, DEV_SERVO_WAVE_SINE,
          300000U, 100000U, 700U, SHIPPED_MAX_VEL_COUNTS, SHIPPED_MAX_ACCEL_COUNTS },
        { "triangle hold and skew", 0, counts_from_mm(1), 500000U, 2U, DEV_SERVO_WAVE_TRIANGLE,
          200000U, 100000U, 700U, SHIPPED_MAX_VEL_COUNTS, SHIPPED_MAX_ACCEL_COUNTS },
        { "sine at 500 mm", counts_from_mm(500), 10000, 1000000U, 2U, DEV_SERVO_WAVE_SINE,
          0U, 0U, DEV_SERVO_SKEW_SYMMETRIC, SHIPPED_MAX_VEL_COUNTS, SHIPPED_MAX_ACCEL_COUNTS },
        { "sine at 2000 mm", counts_from_mm(2000), 10000, 1000000U, 2U, DEV_SERVO_WAVE_SINE,
          0U, 0U, DEV_SERVO_SKEW_SYMMETRIC, SHIPPED_MAX_VEL_COUNTS, SHIPPED_MAX_ACCEL_COUNTS },
        { "sine at 300 mm/s^2", 0, counts_from_mm(2.5), 1000000U, 2U, DEV_SERVO_WAVE_SINE,
          0U, 0U, DEV_SERVO_SKEW_SYMMETRIC, SHIPPED_MAX_VEL_COUNTS, counts_from_mm(300) },
        { "sine at 150 mm/s^2", 0, counts_from_mm(1), 1000000U, 2U, DEV_SERVO_WAVE_SINE,
          0U, 0U, DEV_SERVO_SKEW_SYMMETRIC, SHIPPED_MAX_VEL_COUNTS, counts_from_mm(150) },
        { "triangle at 300 mm/s^2", 0, counts_from_mm(2), 500000U, 2U, DEV_SERVO_WAVE_TRIANGLE,
          0U, 0U, DEV_SERVO_SKEW_SYMMETRIC, SHIPPED_MAX_VEL_COUNTS, counts_from_mm(300) },
    };

    for (unsigned i = 0U; i < (sizeof(cases) / sizeof(cases[0])); i++)
    {
        servo_init_envelope(cases[i].maxVel, cases[i].maxAccel);
        dev_servo_waveform_S wf = *WF(cases[i].centre, cases[i].amp, cases[i].freqMicroHz,
                                      cases[i].cycles, cases[i].shape);
        wf.dwellHighUs = cases[i].dwellHighUs;
        wf.dwellLowUs = cases[i].dwellLowUs;
        wf.skewPerMille = cases[i].skew;

        const double worst = worst_cycle_on_current_machine(&wf);
        char msg[192];
        (void)snprintf(msg, sizeof(msg),
                       "%s deviated %.2f counts (%.3f um)",
                       cases[i].what, worst, worst / COUNTS_PER_MM * 1000.0);
        printf("  %-36s worst %.2f counts (%.3f um)\n", cases[i].what, worst,
               worst / COUNTS_PER_MM * 1000.0);
        TEST_ASSERT_TRUE_MESSAGE(worst <= ONE_MICRON_COUNTS, msg);
    }
}

/* ---- Open-loop position moves (G124, motor calibration) ---- */

/* Run the loop with the encoder frozen, summing the pulses the drive was asked
 * for (rate x tick). Returns ticks until arrival, or -1. */
static int open_loop_run(int maxTicks, double *pulses, uint32_t *peakRate, uint32_t *firstRate)
{
    *pulses = 0.0;
    *peakRate = 0U;
    *firstRate = 0U;
    for (int i = 0; i < maxTicks; i++)
    {
        tick();
        if ((i == 0) || (*firstRate == 0U)) { *firstRate = d_pulseRate; }
        if (d_pulseRate > *peakRate) { *peakRate = d_pulseRate; }
        *pulses += (double)d_pulseRate * SERVO_DT_S;
        if (dev_servo_atTarget(CH)) { return i + 1; }
    }
    return -1;
}

void test_dev_servo_open_loop_move_ignores_the_encoder(void)
{
    VIBES_TEST("servo.open-loop-move",
               "src/DEV/dev_servo.c#dev_servo_moveToOpenLoop",
               "an enabled drive given a one-millimetre open-loop move at one millimetre a second, with the encoder never moving");
    VIBES_EXPECT_WHY("arrives-on-trajectory",
                     "the move arrives when its own trajectory does, in a little over a second",
                     "with the feedback off there is no encoder truth to arrive by");
    VIBES_EXPECT("pulses-match-distance", "the pulses sent add up to the distance, to within 0.2 percent");
    VIBES_EXPECT("rate-capped", "the pulse rate never exceeds the requested feedrate, so nothing is added to chase the encoder");
    VIBES_EXPECT("ramped", "the pulse train starts below the feedrate and ramps up, as a closed-loop move does");
    VIBES_EXPECT("no-stall", "no stall is reported");
    servo_init_envelope(SHIPPED_MAX_VEL_COUNTS, 81920); /* 10 mm/s^2: a ramp long enough to see */
    dev_servo_enable(CH, true);
    tick();
    dev_servo_moveToOpenLoop(CH, 8192, 8192);
    double pulses = 0.0;
    uint32_t peak = 0U;
    uint32_t first = 0U;
    const int ticks = open_loop_run(3000, &pulses, &peak, &first);
    TEST_ASSERT_TRUE(ticks > 1000);
    TEST_ASSERT_TRUE(ticks < 1300);
    TEST_ASSERT_TRUE(fabs(pulses - 8192.0) <= 0.002 * 8192.0);
    TEST_ASSERT_TRUE(peak <= 8192U);
    TEST_ASSERT_TRUE(first < 8192U);
    TEST_ASSERT_FALSE(dev_servo_isStalled(CH));
}

void test_dev_servo_open_loop_moves_out_and_back_send_equal_pulses(void)
{
    VIBES_TEST("servo.open-loop-out-and-back",
               "src/DEV/dev_servo.c#dev_servo_moveToOpenLoop",
               "an open-loop move out one millimetre and back to where it was commanded from, with the encoder frozen");
    VIBES_EXPECT("back-equals-out", "the pulses sent back equal the pulses sent out");
    VIBES_EXPECT("back-reverses", "the drive is driven the other way on the way back");
    servo_init();
    dev_servo_enable(CH, true);
    tick();
    dev_servo_moveToOpenLoop(CH, 8192, 8192);
    double out = 0.0;
    uint32_t peak = 0U;
    uint32_t first = 0U;
    TEST_ASSERT_TRUE(open_loop_run(3000, &out, &peak, &first) > 0);
    const bool outActive = d_gpioActive;
    dev_servo_moveToOpenLoop(CH, 0, 8192);
    double back = 0.0;
    TEST_ASSERT_TRUE(open_loop_run(3000, &back, &peak, &first) > 0);
    TEST_ASSERT_TRUE(fabs(back - out) <= 0.002 * out);
    TEST_ASSERT_TRUE(d_gpioActive != outActive);
}

void test_dev_servo_leaving_open_loop_holds_where_the_encoder_is(void)
{
    VIBES_TEST("servo.open-loop-hands-back-in-place",
               "src/DEV/dev_servo.c#dev_servo_run",
               "an open-loop move commanded one millimetre while the encoder moved only a third of that, followed by a stop");
    VIBES_EXPECT_WHY("no-pull-back",
                     "the drive holds where the encoder now is and sends no pulses",
                     "the closed loop must not drag the carriage toward where the open-loop pulses said it went");
    servo_init();
    dev_servo_enable(CH, true);
    tick();
    dev_servo_moveToOpenLoop(CH, 8192, 8192);
    double pulses = 0.0;
    uint32_t peak = 0U;
    uint32_t first = 0U;
    TEST_ASSERT_TRUE(open_loop_run(3000, &pulses, &peak, &first) > 0);
    d_encoderValue = 2731;
    d_carriage = 2731.0;
    dev_servo_stop(CH);
    for (int i = 0; i < 50; i++)
    {
        tick();
    }
    TEST_ASSERT_EQUAL_INT32(0, dev_servo_getVelocity(CH));
    TEST_ASSERT_EQUAL_UINT32(0U, d_pulseRate);
    TEST_ASSERT_INT32_WITHIN(1, 2731, dev_servo_getSetpoint(CH));
}

void test_dev_servo_a_closed_loop_move_turns_the_feedback_back_on(void)
{
    VIBES_TEST("servo.closed-loop-after-open-loop",
               "src/DEV/dev_servo.c#dev_servo_moveTo",
               "an open-loop move, then an ordinary move, with the encoder frozen");
    VIBES_EXPECT_WHY("stall-guard-back",
                     "the ordinary move reports a stall when the encoder does not follow it",
                     "only the open-loop move switches the feedback and its stall guard off");
    servo_init();
    dev_servo_enable(CH, true);
    tick();
    dev_servo_moveToOpenLoop(CH, 8192, 8192);
    double pulses = 0.0;
    uint32_t peak = 0U;
    uint32_t first = 0U;
    TEST_ASSERT_TRUE(open_loop_run(3000, &pulses, &peak, &first) > 0);
    dev_servo_moveTo(CH, 40960, 40960);
    for (int i = 0; i < 400; i++)
    {
        tick();
    }
    TEST_ASSERT_TRUE(dev_servo_isStalled(CH));
}

void test_dev_servo_profile_gains_are_used(void)
{
    VIBES_TEST("servo.profile-gains",
               "src/DEV/dev_servo.c#dev_servo_setGains",
               "servo gains of 4 per second and 2 per second squared given from the machine profile");
    VIBES_EXPECT("gains-applied", "the loop runs with those gains");
    VIBES_EXPECT("zero-keeps-default", "a proportional gain of zero leaves the built-in gain in place");
    servo_init();
    dev_servo_setGains(4000, 2000);
    TEST_ASSERT_EQUAL_FLOAT(4.0f, (float)dev_servo_channelConfig[CH].kpNum / (float)dev_servo_channelConfig[CH].kpDen);
    TEST_ASSERT_EQUAL_FLOAT(2.0f, (float)dev_servo_channelConfig[CH].kiNum / (float)dev_servo_channelConfig[CH].kiDen);
    servo_init();
    dev_servo_setGains(0, 0);
    TEST_ASSERT_EQUAL_FLOAT((float)dev_servo_channelConfigDefault[CH].kpNum / (float)dev_servo_channelConfigDefault[CH].kpDen,
                            (float)dev_servo_channelConfig[CH].kpNum / (float)dev_servo_channelConfig[CH].kpDen);
}

/**********************************************************************
 * The integral term, and parking, on a lagging plant
 **********************************************************************/

/* The bench machine: 2400 encoder counts per mm, 5 mm/s, 50 mm/s^2, Kp 10. */
#define BENCH_COUNTS_PER_MM 2400
#define BENCH_MAX_VEL_COUNTS (5 * BENCH_COUNTS_PER_MM)
#define BENCH_MAX_ACCEL_COUNTS (50 * BENCH_COUNTS_PER_MM)
#define BENCH_ONE_MICRON_COUNTS (BENCH_COUNTS_PER_MM / 1000.0)

/* A carriage with inertia, like the SIL plant: its speed follows the pulsed
 * rate as a first-order lag of d_plantTauS, so it falls behind its trajectory
 * while that accelerates. d_plantLoss (counts/s) is a constant load pulling it
 * back, all the time, the way a sample pulls against the drive. */
static double d_plantVel;
static double d_plantTauS;
static double d_plantLoss;

static void plant_reset(double tauS, double lossCountsPerS)
{
    d_plantVel = 0.0;
    d_plantTauS = tauS;
    d_plantLoss = lossCountsPerS;
}

static void tick_with_plant(void)
{
    global_timeus += 1000U;
    dev_servo_run();
    const double dir = d_gpioActive ? -1.0 : 1.0;
    const double pulsed = dir * (double)d_pulseRate;
    d_plantVel += (pulsed - d_plantVel) * (SERVO_DT_S / d_plantTauS);
    d_carriage += (d_plantVel - d_plantLoss) * SERVO_DT_S;
    d_encoderValue = (int32_t)(d_carriage < 0.0 ? (d_carriage - 0.5) : (d_carriage + 0.5));
}

/* Gains as the machine profile states them: Kp whole, Ki in thousandths. */
static void set_gains(int32_t kp, int32_t kiMilli)
{
    dev_servo_channelConfig[CH].kpNum = kp;
    dev_servo_channelConfig[CH].kpDen = 1;
    dev_servo_channelConfig[CH].kiNum = kiMilli;
    dev_servo_channelConfig[CH].kiDen = 1000;
}

static void bench_init(int32_t kiMilli, double tauS, double lossCountsPerS)
{
    servo_init_scaled(BENCH_MAX_VEL_COUNTS, BENCH_MAX_ACCEL_COUNTS, BENCH_COUNTS_PER_MM,
                      BENCH_COUNTS_PER_MM);
    set_gains(10, kiMilli);
    plant_reset(tauS, lossCountsPerS);
    dev_servo_enable(CH, true);
}

/* The calibration's tracking move: 10 mm at 5 mm/s. Returns the overshoot past
 * the target in counts, and where the carriage parked. */
/* The carriage lag in seconds (2 ms); the servo.integral-ignores-ramp-lag
 * given states it, so change both together. */
#define BENCH_TAU_S 0.002
static double bench_move_overshoot(int32_t kiMilli, int32_t *parkedAt, bool *arrived)
{
    bench_init(kiMilli, BENCH_TAU_S, 0.0);
    const int32_t target = 10 * BENCH_COUNTS_PER_MM;
    dev_servo_moveTo(CH, target, 0);
    double overshoot = 0.0;
    int i = 0;
    for (; (i < 20000) && !dev_servo_atTarget(CH); i++)
    {
        tick_with_plant();
        if ((d_carriage - (double)target) > overshoot) { overshoot = d_carriage - (double)target; }
    }
    *arrived = dev_servo_atTarget(CH);
    for (int j = 0; j < 500; j++)
    {
        tick_with_plant();
        if ((d_carriage - (double)target) > overshoot) { overshoot = d_carriage - (double)target; }
    }
    *parkedAt = d_encoderValue;
    return overshoot;
}

void test_the_integral_does_not_turn_ramp_lag_into_overshoot(void)
{
    VIBES_TEST("servo.integral-ignores-ramp-lag",
               "src/DEV/dev_servo.c#dev_servo_private_integrate",
               "a 2400 counts/mm machine with proportional gain 10, whose carriage lags its pulses by 2 ms, making a 10 mm move at 5 mm/s and 50 mm/s^2");
    VIBES_EXPECT_WHY("overshoot-as-without-integral",
                     "with integral gain 12.5 or 50 the move overshoots its target by at most 0.25 um more than with the integral off",
                     "the carriage falls behind while its trajectory accelerates; that lag is transient, and an integral that learned it would push the carriage past the target when the move stops");
    VIBES_EXPECT("arrives", "every move reports arrival");

    int32_t parked = 0;
    bool arrived = false;
    const double base = bench_move_overshoot(0, &parked, &arrived);
    TEST_ASSERT_TRUE(arrived);
    const int32_t kis[2] = { 12500, 50000 };
    for (unsigned k = 0U; k < 2U; k++)
    {
        const double os = bench_move_overshoot(kis[k], &parked, &arrived);
        char msg[160];
        (void)snprintf(msg, sizeof(msg),
                       "Ki %.1f overshot %.2f um against %.2f um with Ki 0",
                       kis[k] / 1000.0, os / BENCH_ONE_MICRON_COUNTS, base / BENCH_ONE_MICRON_COUNTS);
        printf("  %s\n", msg);
        TEST_ASSERT_TRUE(arrived);
        TEST_ASSERT_TRUE_MESSAGE(os <= base + (0.25 * BENCH_ONE_MICRON_COUNTS), msg);
    }
}

/* Mean following error (setpoint - carriage, counts) over the last `window`
 * ticks of `ticks` ticks driven on the plant. */
static double mean_following_error(int ticks, int window)
{
    double sum = 0.0;
    for (int i = 0; i < ticks; i++)
    {
        tick_with_plant();
        if (i >= (ticks - window))
        {
            sum += (double)dev_servo_data.channel[CH].setpointPos - d_carriage;
        }
    }
    return sum / (double)window;
}

/* A load costing the carriage 0.05 mm/s of the speed it is pulsed at. */
#define BENCH_LOAD_COUNTS_PER_S (0.05 * BENCH_COUNTS_PER_MM)

void test_the_integral_nulls_a_steady_load_while_moving(void)
{
    VIBES_TEST("servo.integral-nulls-load-while-moving",
               "src/DEV/dev_servo.c#dev_servo_private_integrate",
               "a 2400 counts/mm machine with proportional gain 10, pulling at a steady 0.5 mm/s against a constant load that costs the carriage 0.05 mm/s");
    VIBES_EXPECT_WHY("standoff-without-integral",
                     "with the integral off the carriage trails its trajectory by the load divided by the proportional gain (5 um)",
                     "the proportional term only pushes harder once it is behind, so it settles where its push matches the load");
    VIBES_EXPECT("nulled-with-integral",
                 "with integral gain 50 the carriage tracks its trajectory to within 0.25 um once the speed has held for a few seconds");

    const int32_t feed = BENCH_COUNTS_PER_MM / 2;
    bench_init(0, BENCH_TAU_S, BENCH_LOAD_COUNTS_PER_S);
    dev_servo_moveTo(CH, 100 * BENCH_COUNTS_PER_MM, feed);
    const double pOnly = mean_following_error(8000, 1000);
    printf("  Ki 0: trailing %.2f um\n", pOnly / BENCH_ONE_MICRON_COUNTS);
    TEST_ASSERT_TRUE(fabs(pOnly - (BENCH_LOAD_COUNTS_PER_S / 10.0)) <= 0.5);

    bench_init(50000, BENCH_TAU_S, BENCH_LOAD_COUNTS_PER_S);
    dev_servo_moveTo(CH, 100 * BENCH_COUNTS_PER_MM, feed);
    const double pi = mean_following_error(8000, 1000);
    printf("  Ki 50: trailing %.2f um\n", pi / BENCH_ONE_MICRON_COUNTS);
    TEST_ASSERT_TRUE(fabs(pi) <= (0.25 * BENCH_ONE_MICRON_COUNTS));
}

void test_the_integral_nulls_a_steady_load_while_holding(void)
{
    VIBES_TEST("servo.integral-nulls-load-while-holding",
               "src/DEV/dev_servo.c#dev_servo_private_integrate",
               "a 2400 counts/mm machine with proportional gain 10 and integral gain 50, stopped and holding station against a constant load that pulls the carriage back at 0.05 mm/s");
    VIBES_EXPECT("nulled", "the carriage holds its position to within 0.25 um once it has been held for a few seconds");

    bench_init(50000, BENCH_TAU_S, BENCH_LOAD_COUNTS_PER_S);
    dev_servo_stop(CH);
    const double err = mean_following_error(6000, 1000);
    printf("  holding: off by %.2f um\n", err / BENCH_ONE_MICRON_COUNTS);
    TEST_ASSERT_TRUE(fabs(err) <= (0.25 * BENCH_ONE_MICRON_COUNTS));
}

void test_the_parking_deadband_is_a_micron_of_any_encoder_scale(void)
{
    VIBES_TEST("servo.parking-deadband-in-microns",
               "src/DEV/dev_servo.c#dev_servo_init",
               "machine profiles whose encoders count 8192, 2400 and 1000 steps per mm");
    VIBES_EXPECT_WHY("whole-counts-within-a-micron",
                     "a move counts as arrived within the most whole encoder counts that fit in 0.001 mm: 8 at 8192 per mm, 2 at 2400",
                     "the positioning contract is a length, and the same number of counts is three times as far on a 2400 counts/mm encoder as on an 8192 one");
    VIBES_EXPECT_WHY("two-count-floor",
                     "an encoder too coarse to fit two counts in 0.001 mm still gets two counts",
                     "a one-count flicker of a carriage standing still must not count as leaving the target");
    VIBES_EXPECT("parks-within-a-micron",
                 "on the 2400 counts/mm machine, a 10 mm move whose carriage overshoots comes to rest within 0.001 mm of its target");

    servo_init_scaled(SHIPPED_MAX_VEL_COUNTS, SHIPPED_MAX_ACCEL_COUNTS, 8192, 8192);
    TEST_ASSERT_EQUAL_INT32(8, dev_servo_channelConfig[CH].positionDeadband);
    servo_init_scaled(SHIPPED_MAX_VEL_COUNTS, SHIPPED_MAX_ACCEL_COUNTS, 2400, 2400);
    TEST_ASSERT_EQUAL_INT32(2, dev_servo_channelConfig[CH].positionDeadband);
    servo_init_scaled(SHIPPED_MAX_VEL_COUNTS, SHIPPED_MAX_ACCEL_COUNTS, 1000, 1000);
    TEST_ASSERT_EQUAL_INT32(2, dev_servo_channelConfig[CH].positionDeadband);

    int32_t parked = 0;
    bool arrived = false;
    const double os = bench_move_overshoot(0, &parked, &arrived);
    printf("  overshoot %.2f um, parked %d counts off\n", os / BENCH_ONE_MICRON_COUNTS,
           (int)(parked - (10 * BENCH_COUNTS_PER_MM)));
    TEST_ASSERT_TRUE(arrived);
    TEST_ASSERT_TRUE_MESSAGE(os > 0.0, "the plant must overshoot for this to test parking");
    TEST_ASSERT_INT32_WITHIN(2, 10 * BENCH_COUNTS_PER_MM, parked);
}

int main(void)
{
    UNITY_BEGIN();
    RUN_TEST(test_dev_servo_initialStateDisabledAtTarget);
    RUN_TEST(test_dev_servo_firstTickDrivesEnableOutputOff);
    RUN_TEST(test_dev_servo_enableTurnsEnableOutputOn);
    RUN_TEST(test_dev_servo_disableTurnsEnableOutputOff);
    RUN_TEST(test_dev_servo_enableActiveLowInvertsEnableOutput);
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
    RUN_TEST(test_dev_servo_stallThroughEncoderBuzz);
    RUN_TEST(test_dev_servo_stallWhenCarriageCrawls);
    RUN_TEST(test_dev_servo_noStallWhileCarriageLags);
    RUN_TEST(test_dev_servo_noStallOnFullSpeedMove);
    RUN_TEST(test_dev_servo_runawayIsReportedAsStall);
    RUN_TEST(test_dev_servo_noStallThroughFullSpeedStopsOnALaggingDrive);
    RUN_TEST(test_dev_servo_noStallThroughAWaveformOnALaggingDrive);
    RUN_TEST(test_dev_servo_errorPastTheCeilingStallsAtOnce);
    RUN_TEST(test_dev_servo_errorHeldInTheSoftBandStalls);
    RUN_TEST(test_dev_servo_errorAtTheBandDoesNotStall);
    RUN_TEST(test_dev_servo_briefErrorInTheSoftBandDoesNotStall);
    RUN_TEST(test_dev_servo_slowFallingBehindStallsInTheSoftBand);
    RUN_TEST(test_dev_servo_stallUsesProfilePulseScale);
    RUN_TEST(test_dev_servo_stallThresholdsFollowTheEncoderScale);
    RUN_TEST(test_dev_servo_encoderStoppingNearTheTargetStalls);
    RUN_TEST(test_dev_servo_encoderStoppingDuringAWaveformStalls);
    RUN_TEST(test_dev_servo_jamNearTheTargetStalls);
    RUN_TEST(test_dev_servo_jamAtTensileSpeedStalls);
    RUN_TEST(test_dev_servo_travelCheckFollowsTheEncoderScale);
    RUN_TEST(test_dev_servo_stallHoldsThroughNewCommands);
    RUN_TEST(test_dev_servo_slowCrawlStalls);
    RUN_TEST(test_dev_servo_reEnableAfterAStallHoldsStill);
    RUN_TEST(test_dev_servo_frameRedefinedMidTickIsNotAStall);
    RUN_TEST(test_dev_servo_frameRedefinedMidTickWhileParked);
    RUN_TEST(test_dev_servo_pulsesAtTheProfileScale);
    RUN_TEST(test_dev_servo_moveAtProfileScaleArrivesWithoutStall);

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
    RUN_TEST(test_oscillate_returns_to_its_centre_after_whole_cycles);
    RUN_TEST(test_oscillate_counts_whole_cycles_and_stops);
    RUN_TEST(test_an_unknown_wire_shape_is_refused_not_defaulted);
    RUN_TEST(test_an_infeasible_waveform_is_rejected_not_approximated);
    RUN_TEST(test_a_triangle_is_a_trapezoidal_rate_not_an_infinite_corner);
    RUN_TEST(test_the_shape_bit_selects_a_genuinely_different_rate_profile);
    RUN_TEST(test_the_machine_reproduces_the_commanded_waveform_to_one_micron);
    RUN_TEST(test_the_phase_accumulator_loses_nothing_over_whole_cycles);
    RUN_TEST(test_tracking_does_not_degrade_along_the_machine);
    RUN_TEST(test_the_one_micron_contract_holds_at_the_feasibility_boundary);
    RUN_TEST(test_a_move_does_not_run_ahead_of_its_own_trajectory);
    RUN_TEST(test_a_hold_at_one_peak_only);
    RUN_TEST(test_dwell_and_skew_still_track_to_one_micron);
    RUN_TEST(test_skew_splits_the_traverse_time_as_asked);
    RUN_TEST(test_a_cycle_whose_holds_leave_no_time_to_move_is_refused);
    RUN_TEST(test_position_moves_track_the_commanded_trapezoid_to_one_micron);
    RUN_TEST(test_waveforms_track_the_requested_cycle_to_one_micron_across_the_envelope);
    RUN_TEST(test_dev_servo_open_loop_move_ignores_the_encoder);
    RUN_TEST(test_dev_servo_profile_gains_are_used);
    RUN_TEST(test_dev_servo_open_loop_moves_out_and_back_send_equal_pulses);
    RUN_TEST(test_dev_servo_leaving_open_loop_holds_where_the_encoder_is);
    RUN_TEST(test_dev_servo_a_closed_loop_move_turns_the_feedback_back_on);
    RUN_TEST(test_the_integral_does_not_turn_ramp_lag_into_overshoot);
    RUN_TEST(test_the_integral_nulls_a_steady_load_while_moving);
    RUN_TEST(test_the_integral_nulls_a_steady_load_while_holding);
    RUN_TEST(test_the_parking_deadband_is_a_micron_of_any_encoder_scale);
    return UNITY_END();
}
