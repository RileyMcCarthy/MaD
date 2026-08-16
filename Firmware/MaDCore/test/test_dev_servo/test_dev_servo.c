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
 *
 * HAL_encoder / HAL_pulseOut / HAL_GPIO / HAL_time are local doubles.
 * Library is real (linked by native_test). Module is #included after doubles.
 */

#include <unity.h>
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
int32_t HAL_encoder_value(HAL_encoder_channel_E ch)
{
    (void)ch;
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

/**********************************************************************
 * Tests
 **********************************************************************/

void test_dev_servo_initialStateDisabledAtTarget(void)
{
    servo_init();
    TEST_ASSERT_TRUE(dev_servo_atTarget(CH));
    TEST_ASSERT_FALSE(dev_servo_isStalled(CH));
    TEST_ASSERT_EQUAL_INT32(0, dev_servo_getPosition(CH));
    TEST_ASSERT_EQUAL_INT32(0, dev_servo_getVelocity(CH));
    TEST_ASSERT_EQUAL_INT32(0, dev_servo_getFollowingError(CH));
}

void test_dev_servo_disabledParksAndReportsEncoder(void)
{
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
    servo_init();
    dev_servo_moveTo(CH, 5000, 10000);
    TEST_ASSERT_EQUAL_INT32(5000, dev_servo_getTarget(CH));
    /* Not applied until enable + run. */
    TEST_ASSERT_EQUAL_INT32(0, dev_servo_getPosition(CH));
}

void test_dev_servo_moveToInvalidFeedrateUsesMax(void)
{
    servo_init();
    /* 0 and oversize clamp to maxVelocity (100000 from init). */
    dev_servo_moveTo(CH, 100, 0);
    TEST_ASSERT_EQUAL_INT32(100000, dev_servo_data.channel[CH].req.feedrate);
    dev_servo_moveTo(CH, 100, 999999);
    TEST_ASSERT_EQUAL_INT32(100000, dev_servo_data.channel[CH].req.feedrate);
}

void test_dev_servo_atTargetWhenEncoderSettledOnTarget(void)
{
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
    servo_init();
    dev_servo_setPosition(CH, 4096);
    TEST_ASSERT_EQUAL_INT32(4096, d_encoderLastSet);
    TEST_ASSERT_EQUAL_INT32(4096, d_encoderValue);
    TEST_ASSERT_EQUAL_INT32(4096, dev_servo_getTarget(CH));
}

void test_dev_servo_followingErrorReflectsOffset(void)
{
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
    return UNITY_END();
}
