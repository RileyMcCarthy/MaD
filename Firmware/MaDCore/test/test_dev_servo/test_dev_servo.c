/*
 * Unit tests for dev_servo — the closed-loop position/velocity controller that
 * runs on the MOTOR cog with the encoder as the single source of truth.
 *
 * dev_servo.c is #included directly (it is NOT in build_src_filter), so the
 * suite owns the module instance and its file-static dev_servo_data. The module
 * seeds its own channel config from compile-time defaults, so no config fixture
 * is needed. The HAL collaborators it touches — pulse train, direction GPIO and
 * encoder — are replaced by controllable doubles below; HAL_lock and HAL_time
 * come from test/mock_propeller2.c (drive time with `global_timeus`).
 *
 * The focus is the CROSS-COG CONTRACT the APP layer depends on: commands are
 * issued from the CONTROL cog while dev_servo_run() ticks on the MOTOR cog, so
 * every published verdict must describe the command currently in force. A
 * caller that issues a move and polls atTarget must never see the *previous*
 * move's "arrived" — that would retire the new move without moving the gantry.
 *
 * Not covered (and why): the LOCK_REQ_BLOCK spin path is unreachable under the
 * mock (a held lock makes HAL_lock_try TEST_FAIL, so it degrades to a single
 * acquire); the PID/trajectory tuning constants are validated against the SIL
 * plant model, not here — these tests pin behaviour, not gains.
 */

#include <unity.h>
#include <string.h>
#include <stdint.h>

#include "HAL_lock.h"

#include "../../src/DEV/dev_servo.c"

extern void HAL_lock_mock_reset(void);
extern uint32_t global_timeus;
extern int _stdio_debug_lock;

/* ====================================================================== *
 * Test doubles — the HAL surface dev_servo drives.                       *
 * ====================================================================== */

static int32_t d_encoder;          /* the "carriage": HAL_encoder_value reads it */
static double d_carriage;          /* same position, kept sub-count accurate */
static uint32_t d_pulseFreq;       /* last commanded pulse frequency */
static bool d_pulseRunning;
static bool d_dirActive;           /* SERVO_DIR: active=false => CW => +counts */
static uint32_t d_stopCount, d_startVelCount, d_setFreqCount;

/* Optional one-shot hook fired from inside HAL_encoder_value — which the control
 * loop reads every tick, right AFTER it has snapshotted the request. That is
 * exactly the window a command issued by another cog can land in, so it models
 * the CONTROL cog commanding a move mid-tick on the MOTOR cog. */
static void (*d_midTickHook)(void);

int32_t HAL_encoder_value(HAL_encoder_channel_E channel)
{
    TEST_ASSERT_EQUAL_INT(HAL_ENCODER_CHANNEL_SERVO, channel);
    if (d_midTickHook != NULL)
    {
        void (*hook)(void) = d_midTickHook;
        d_midTickHook = NULL; /* one-shot */
        hook();
    }
    return d_encoder;
}

void HAL_encoder_set(HAL_encoder_channel_E channel, int32_t value)
{
    TEST_ASSERT_EQUAL_INT(HAL_ENCODER_CHANNEL_SERVO, channel);
    d_encoder = value;
    d_carriage = (double)value;
}

void HAL_encoder_start(HAL_encoder_channel_E channel) { (void)channel; }

void HAL_GPIO_setActive(HAL_GPIO_channel_E channel, bool active)
{
    TEST_ASSERT_EQUAL_INT(HAL_GPIO_SERVO_DIR, channel);
    d_dirActive = active;
}

void HAL_pulseOut_stop(HAL_pulseOut_channel_E channel)
{
    (void)channel;
    d_stopCount++;
    d_pulseRunning = false;
    d_pulseFreq = 0U;
}

void HAL_pulseOut_startVelocity(HAL_pulseOut_channel_E channel, uint32_t frequency)
{
    (void)channel;
    d_startVelCount++;
    d_pulseRunning = true;
    d_pulseFreq = frequency;
}

void HAL_pulseOut_setFrequency(HAL_pulseOut_channel_E channel, uint32_t frequency)
{
    (void)channel;
    d_setFreqCount++;
    d_pulseFreq = frequency;
}

bool HAL_pulseOut_run(HAL_pulseOut_channel_E channel, uint32_t *pulses)
{
    (void)channel;
    if (pulses != NULL) { *pulses = 0U; }
    return false;
}

/* ====================================================================== *
 * Fixture                                                                *
 * ====================================================================== */

#define CH DEV_SERVO_CHANNEL_MAIN
#define TICK_US 1000U

static void advance_tick(void) { global_timeus += TICK_US; }

/* Run one control tick at the nominal loop rate. */
static void servo_tick(void)
{
    advance_tick();
    dev_servo_run();
}

/* Model an ideal carriage: the encoder integrates the commanded pulse rate
 * exactly. Position is carried at sub-count precision so the slow final approach
 * (rates below one count per tick) still moves — integer truncation there would
 * stall the carriage short of the deadband and mask real settling behaviour.
 * Enough to exercise the trajectory/settling logic without a plant model. */
static void servo_tick_with_motion(void)
{
    advance_tick();
    dev_servo_run();
    const double dir = d_dirActive ? -1.0 : 1.0;
    if (d_pulseRunning)
    {
        d_carriage += dir * (double)d_pulseFreq * ((double)TICK_US / 1000000.0);
        d_encoder = (int32_t)(d_carriage < 0.0 ? (d_carriage - 0.5) : (d_carriage + 0.5));
    }
}

void setUp(void)
{
    HAL_lock_mock_reset();
    _stdio_debug_lock = HAL_lock_create();
    global_timeus = 1000U;
    memset(&dev_servo_data, 0, sizeof(dev_servo_data));
    d_encoder = 0;
    d_carriage = 0.0;
    d_pulseFreq = 0U;
    d_pulseRunning = false;
    d_dirActive = false;
    d_stopCount = d_startVelCount = d_setFreqCount = 0U;
    d_midTickHook = NULL;
    /* Machine-profile limits in encoder counts: 20 mm/s, 50 mm/s^2 @ 8192 c/mm. */
    dev_servo_init(HAL_lock_create(), 163840, 409600);
}

void tearDown(void) {}

/* ====================================================================== *
 * Liveness (dev_servo_isReady) — what APP gates the machine on           *
 * ====================================================================== */

/* The MOTOR cog owns the only call site of dev_servo_run(); until it has ticked
 * once the driver cannot claim to be servicing the actuator. */
void test_isReady_false_until_first_tick(void)
{
    TEST_ASSERT_FALSE(dev_servo_isReady(CH));
    servo_tick();
    TEST_ASSERT_TRUE(dev_servo_isReady(CH));
}

/* Disabled is not dead: the loop is still ticking, so the machine must not read
 * a communication fault just because motion is off. */
void test_isReady_true_while_disabled_but_ticking(void)
{
    dev_servo_enable(CH, false);
    servo_tick();
    TEST_ASSERT_TRUE(dev_servo_isReady(CH));
}

void test_isReady_rejects_out_of_range_channel(void)
{
    servo_tick();
    TEST_ASSERT_FALSE(dev_servo_isReady(DEV_SERVO_CHANNEL_COUNT));
}

/* ====================================================================== *
 * atTarget — the flag app_motion retires a move on                       *
 * ====================================================================== */

/* Drive the loop until it reports arrival, or give up. Returns tick count. */
static int settle(int maxTicks)
{
    int ticks = 0;
    while ((ticks < maxTicks) && !dev_servo_atTarget(CH))
    {
        servo_tick_with_motion();
        ticks++;
    }
    return ticks;
}

/* 1 mm at 5 mm/s is a 200 ms move = ~200 ticks; allow generous slack for the
 * accel ramp and the final settle, but NOT an unbounded hunt (see below). */
#define SETTLE_TICK_BUDGET 400

void test_move_reports_atTarget_once_encoder_settles(void)
{
    dev_servo_enable(CH, true);
    dev_servo_moveTo(CH, 8192, 40960); /* 1 mm at 5 mm/s */
    const int ticks = settle(SETTLE_TICK_BUDGET);
    TEST_ASSERT_TRUE(dev_servo_atTarget(CH));
    TEST_ASSERT_TRUE(ticks > 1); /* it actually had to travel */
    TEST_ASSERT_INT32_WITHIN(dev_servo_channelConfig[CH].positionDeadband, 8192, d_encoder);
}

/* REGRESSION: the approach must CONVERGE, not hunt. The braking law
 * v = sqrt(2*a*d) is singular at the target — for a sub-count remainder it still
 * demands hundreds of counts/s, so without a one-tick-reach cap the setpoint
 * steps over the target every tick and oscillates forever. The encoder parks
 * inside the deadband but the profile never winds down, so atTarget never
 * latches and the move is retired only if some later tick happens to land in
 * the window: moves that "sometimes take 3 s and sometimes 15 s". Assert the
 * profile actually comes to rest on the target within the budget. */
void test_move_settles_deterministically_without_hunting(void)
{
    dev_servo_enable(CH, true);
    /* Several distances, including ones that do not divide evenly into a tick's
     * travel, so the final approach lands mid-tick. */
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
        TEST_ASSERT_INT32_WITHIN(dev_servo_channelConfig[CH].positionDeadband, targets[t], d_encoder);
    }
}

/* REGRESSION: a new target must invalidate the previous verdict IMMEDIATELY —
 * before the MOTOR cog has had a chance to tick. app_motion issues the move and
 * polls atTarget on its very next cycle; if the stale "parked at the last
 * target" true survives, the move is retired without the gantry moving, the
 * test recording stops early and the profile's path comes up short. */
void test_new_move_clears_previous_arrival_before_any_tick(void)
{
    dev_servo_enable(CH, true);
    dev_servo_moveTo(CH, 8192, 40960);
    (void)settle(20000);
    TEST_ASSERT_TRUE(dev_servo_atTarget(CH)); /* parked on the first target */

    dev_servo_moveTo(CH, 16384, 40960);       /* a second, different target */
    TEST_ASSERT_FALSE(dev_servo_atTarget(CH));/* no tick yet => cannot have arrived */
}

/* Same hazard, narrower window: the command lands INSIDE a tick, after the loop
 * snapshotted the old target but before it publishes its verdict. The published
 * verdict must not be attributed to the new target. */
static void issue_new_move_midtick(void) { dev_servo_moveTo(CH, 16384, 40960); }

void test_command_landing_midtick_is_not_reported_as_arrival(void)
{
    dev_servo_enable(CH, true);
    dev_servo_moveTo(CH, 8192, 40960);
    (void)settle(20000);
    TEST_ASSERT_TRUE(dev_servo_atTarget(CH));

    /* This tick would otherwise publish atTarget=true for the OLD target. */
    d_midTickHook = issue_new_move_midtick;
    servo_tick();
    TEST_ASSERT_FALSE(dev_servo_atTarget(CH));
    TEST_ASSERT_EQUAL_INT32(16384, dev_servo_getTarget(CH));
}

void test_setVelocity_clears_arrival(void)
{
    dev_servo_enable(CH, true);
    dev_servo_moveTo(CH, 8192, 40960);
    (void)settle(20000);
    TEST_ASSERT_TRUE(dev_servo_atTarget(CH));

    dev_servo_setVelocity(CH, 4096);
    TEST_ASSERT_FALSE(dev_servo_atTarget(CH));
}

void test_stop_clears_arrival(void)
{
    dev_servo_enable(CH, true);
    dev_servo_moveTo(CH, 8192, 40960);
    (void)settle(20000);
    TEST_ASSERT_TRUE(dev_servo_atTarget(CH));

    dev_servo_stop(CH);
    TEST_ASSERT_FALSE(dev_servo_atTarget(CH));
}

/* Homing re-defines the coordinate frame, which moves the target with it, so the
 * previous verdict no longer describes anything the caller can act on. */
void test_setPosition_clears_arrival_and_adopts_frame(void)
{
    dev_servo_enable(CH, true);
    dev_servo_moveTo(CH, 8192, 40960);
    (void)settle(20000);
    TEST_ASSERT_TRUE(dev_servo_atTarget(CH));

    dev_servo_setPosition(CH, 0);
    TEST_ASSERT_FALSE(dev_servo_atTarget(CH));
    TEST_ASSERT_EQUAL_INT32(0, d_encoder);
    TEST_ASSERT_EQUAL_INT32(0, dev_servo_getTarget(CH));
    /* With target == position the loop re-confirms arrival on the next tick. */
    servo_tick();
    TEST_ASSERT_TRUE(dev_servo_atTarget(CH));
}

/* ====================================================================== *
 * Commanding                                                             *
 * ====================================================================== */

void test_disabled_servo_emits_no_pulses(void)
{
    dev_servo_enable(CH, false);
    dev_servo_moveTo(CH, 8192, 40960);
    for (int i = 0; i < 50; i++) { servo_tick_with_motion(); }
    TEST_ASSERT_FALSE(d_pulseRunning);
    TEST_ASSERT_EQUAL_INT32(0, d_encoder);
}

void test_moveTo_clamps_invalid_feedrate_to_max(void)
{
    dev_servo_enable(CH, true);
    dev_servo_moveTo(CH, 81920, 0); /* 0 => full speed */
    servo_tick();
    TEST_ASSERT_EQUAL_INT32(163840, dev_servo_data.channel[CH].req.feedrate);

    dev_servo_moveTo(CH, 81920, 999999999); /* above the profile limit => clamped */
    servo_tick();
    TEST_ASSERT_EQUAL_INT32(163840, dev_servo_data.channel[CH].req.feedrate);
}

/* Negative velocity drives the direction pin the other way (active=true => CCW). */
void test_velocity_mode_sets_direction_from_sign(void)
{
    dev_servo_enable(CH, true);
    dev_servo_setVelocity(CH, -40960);
    for (int i = 0; i < 200; i++) { servo_tick_with_motion(); }
    TEST_ASSERT_TRUE(d_dirActive);
    TEST_ASSERT_TRUE(d_encoder < 0);
}

int main(void)
{
    UNITY_BEGIN();
    RUN_TEST(test_isReady_false_until_first_tick);
    RUN_TEST(test_isReady_true_while_disabled_but_ticking);
    RUN_TEST(test_isReady_rejects_out_of_range_channel);

    RUN_TEST(test_move_reports_atTarget_once_encoder_settles);
    RUN_TEST(test_move_settles_deterministically_without_hunting);
    RUN_TEST(test_new_move_clears_previous_arrival_before_any_tick);
    RUN_TEST(test_command_landing_midtick_is_not_reported_as_arrival);
    RUN_TEST(test_setVelocity_clears_arrival);
    RUN_TEST(test_stop_clears_arrival);
    RUN_TEST(test_setPosition_clears_arrival_and_adopts_frame);

    RUN_TEST(test_disabled_servo_emits_no_pulses);
    RUN_TEST(test_moveTo_clamps_invalid_feedrate_to_max);
    RUN_TEST(test_velocity_mode_sets_direction_from_sign);
    return UNITY_END();
}
