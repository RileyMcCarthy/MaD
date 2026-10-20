// Unity unit-test suite for src/APP/app_motorCalibration.c
//
// The sequencer drives a fixed number of step pulses each way open loop and
// reports how far the encoder moved. Its peers are doubles: app_control
// (motion enable, fault, restricted speed), app_motion / app_testManagement (busy), the end
// stop GPIOs, and dev_servo's open-loop API. The dev_servo double is a small
// plant: it emits pulses at the requested rate, one control tick per run, and
// moves an encoder by a configurable number of counts per pulse and sign, so
// a test can describe the machine it wants ("half a count per pulse, wired
// backwards") and read back what the sequencer reported.
//
// Library/ (lib_timer) is real; HAL_time comes from mock_propeller2.c.

#include <unity.h>
#include "vibes_behaviour.h"
#include <string.h>
#include <stdint.h>
#include <stdbool.h>

#include "HAL_lock.h"
#include "HAL_GPIO.h"
#include "dev_servo.h"
#include "app_control.h"
#include "app_motorCalibration.h"

extern void HAL_lock_mock_reset(void);
extern uint32_t global_timeus;
extern int _stdio_debug_lock;

/**********************************************************************
 * Doubles
 **********************************************************************/
static bool d_motionEnabled;
static app_control_fault_E d_fault;
static bool d_motionIdle;
static bool d_testRunning;
static bool d_endstopUpper;
static bool d_endstopLower;
static bool d_restricted;

bool app_control_motionEnabled(void) { return d_motionEnabled; }
bool app_control_speedLimited(void) { return d_restricted; }
app_control_fault_E app_control_getFault(void) { return d_fault; }
bool app_motion_isIdle(void) { return d_motionIdle; }
bool app_testManagement_isRunning(void) { return d_testRunning; }
bool HAL_GPIO_getActive(HAL_GPIO_channel_E ch)
{
    if (ch == HAL_GPIO_ENDSTOP_UPPER) { return d_endstopUpper; }
    if (ch == HAL_GPIO_ENDSTOP_LOWER) { return d_endstopLower; }
    return false;
}

/* The plant. */
static double d_countsPerPulse; /* signed: negative = encoder wired backwards */
static bool d_drivesMotion;     /* false = pulses go out but nothing moves */
static double d_encoder;
static int32_t d_olPulses;
static uint32_t d_olFreq;
static uint32_t d_olEmitted;
static bool d_olRunning;
static bool d_olDone;
static int d_startCount;
static int d_stopCount;
static int32_t d_startPulses[4];

bool dev_servo_startOpenLoop(dev_servo_channel_E ch, int32_t signedPulses, uint32_t freqHz)
{
    (void)ch;
    if (d_startCount < 4) { d_startPulses[d_startCount] = signedPulses; }
    d_startCount++;
    d_olPulses = signedPulses;
    d_olFreq = freqHz;
    d_olEmitted = 0U;
    d_olRunning = true;
    d_olDone = false;
    return true;
}
bool dev_servo_openLoopDone(dev_servo_channel_E ch, uint32_t *emitted)
{
    (void)ch;
    if (emitted != NULL) { *emitted = d_olEmitted; }
    return d_olDone;
}
bool dev_servo_isOpenLoop(dev_servo_channel_E ch)
{
    (void)ch;
    return d_olRunning;
}
void dev_servo_stop(dev_servo_channel_E ch)
{
    (void)ch;
    d_stopCount++;
    d_olRunning = false;
}
int32_t dev_servo_getPosition(dev_servo_channel_E ch)
{
    (void)ch;
    return (int32_t)((d_encoder < 0.0) ? (d_encoder - 0.5) : (d_encoder + 0.5));
}

/* One millisecond of the drive. */
static void plant_tick(void)
{
    global_timeus += 1000U;
    if (!d_olRunning || d_olDone) { return; }
    const uint32_t wanted = (uint32_t)((d_olPulses < 0) ? -d_olPulses : d_olPulses);
    uint32_t step = d_olFreq / 1000U;
    if (step == 0U) { step = 1U; }
    if (d_olEmitted + step > wanted) { step = wanted - d_olEmitted; }
    d_olEmitted += step;
    if (d_drivesMotion)
    {
        const double dir = (d_olPulses < 0) ? -1.0 : 1.0;
        d_encoder += dir * d_countsPerPulse * (double)step;
    }
    if (d_olEmitted >= wanted) { d_olDone = true; }
}

/* Module under test after doubles. */
#include "../../src/APP/app_motorCalibration.c"

/**********************************************************************
 * Helpers
 **********************************************************************/
static const app_motorCalibration_request_S REQ_1MM = { 8192U, 8192U, 3U * 8192U }; /* 1 mm at 1 mm/s on 8192/mm */

static void healthy_machine(void)
{
    d_motionEnabled = true;
    d_fault = APP_CONTROL_FAULT_NONE;
    d_motionIdle = true;
    d_testRunning = false;
    d_endstopUpper = false;
    d_endstopLower = false;
    d_restricted = false;
    d_countsPerPulse = 1.0;
    d_drivesMotion = true;
    d_encoder = 1000.0;
}

static void step(void)
{
    plant_tick();
    app_motorCalibration_run();
}

static app_motorCalibration_result_S result(void)
{
    app_motorCalibration_result_S r;
    app_motorCalibration_getResult(&r);
    return r;
}

/* Run until the sequencer leaves the active states, or give up. */
static app_motorCalibration_result_S run_to_end(int maxTicks)
{
    for (int i = 0; (i < maxTicks) && app_motorCalibration_isActive(); i++)
    {
        step();
    }
    return result();
}

void setUp(void)
{
    HAL_lock_mock_reset();
    _stdio_debug_lock = HAL_lock_create();
    global_timeus = 0U;
    d_olPulses = 0;
    d_olFreq = 0U;
    d_olEmitted = 0U;
    d_olRunning = false;
    d_olDone = false;
    d_startCount = 0;
    d_stopCount = 0;
    memset(d_startPulses, 0, sizeof(d_startPulses));
    healthy_machine();
    app_motorCalibration_init(HAL_lock_create());
}

void tearDown(void) {}

/**********************************************************************
 * Tests
 **********************************************************************/
void test_a_matched_machine_reports_one_count_per_pulse_both_ways(void)
{
    VIBES_TEST("motorcal.matched-drive-and-encoder",
               "src/APP/app_motorCalibration.c#app_motorCalibration_run",
               "a motor calibration on a machine whose encoder counts once per drive pulse, wired the right way round");
    VIBES_EXPECT("forward-then-reverse",
                 "the carriage is driven the requested number of pulses forward, then the same number back");
    VIBES_EXPECT("pulses-reported", "the pulses sent each way are reported, signed by direction");
    VIBES_EXPECT("counts-reported", "the encoder change each way is reported, and matches the pulses sent");
    VIBES_EXPECT_WHY("held-afterwards",
                     "once both ways are measured the drive is handed back to the closed-loop hold",
                     "the open-loop run must not leave the drive emitting pulses with nothing watching");

    TEST_ASSERT_TRUE(app_motorCalibration_request(&REQ_1MM));
    const app_motorCalibration_result_S r = run_to_end(10000);

    TEST_ASSERT_EQUAL_INT(2, d_startCount);
    TEST_ASSERT_EQUAL_INT32(8192, d_startPulses[0]);
    TEST_ASSERT_EQUAL_INT32(-8192, d_startPulses[1]);
    TEST_ASSERT_EQUAL_INT(APP_MOTORCALIBRATION_STATE_DONE, r.state);
    TEST_ASSERT_EQUAL_INT32(8192, r.pulsesForward);
    TEST_ASSERT_EQUAL_INT32(-8192, r.pulsesReverse);
    TEST_ASSERT_EQUAL_INT32(8192, r.countsForward);
    TEST_ASSERT_EQUAL_INT32(-8192, r.countsReverse);
    TEST_ASSERT_TRUE(d_stopCount >= 1);
    TEST_ASSERT_FALSE(d_olRunning);
}

void test_a_mismatched_backwards_encoder_is_reported_as_measured(void)
{
    VIBES_TEST("motorcal.reports-raw-measurement",
               "src/APP/app_motorCalibration.c#app_motorCalibration_run",
               "a motor calibration on a machine whose encoder counts once every three drive pulses and is wired backwards");
    VIBES_EXPECT_WHY("raw-counts",
                     "the encoder change each way is reported as measured, a third of the pulses and opposite in sign",
                     "the machine reports what happened; the app judges it against the machine profile");
    VIBES_EXPECT("completes", "the calibration completes");

    d_countsPerPulse = -1.0 / 3.0;
    const app_motorCalibration_request_S req = { 3000U, 3000U, 10000U };
    TEST_ASSERT_TRUE(app_motorCalibration_request(&req));
    const app_motorCalibration_result_S r = run_to_end(10000);

    TEST_ASSERT_EQUAL_INT32(-1000, r.countsForward);
    TEST_ASSERT_EQUAL_INT32(1000, r.countsReverse);
    TEST_ASSERT_EQUAL_INT(APP_MOTORCALIBRATION_STATE_DONE, r.state);
}

void test_an_encoder_read_waits_for_the_carriage_to_settle(void)
{
    VIBES_TEST("motorcal.reads-after-settling",
               "src/APP/app_motorCalibration.c#app_motorCalibration_run",
               "a drive that is still moving the carriage just after its last pulse");
    VIBES_EXPECT_WHY("settled-count",
                     "the encoder is read a quarter of a second after the last pulse, so the late movement is counted",
                     "a step and direction servo drive lags the pulses it is sent");

    TEST_ASSERT_TRUE(app_motorCalibration_request(&REQ_1MM));
    /* Run the forward pulses out. */
    while (!d_olDone) { step(); }
    /* The carriage creeps on after the last pulse... */
    d_encoder += 40.0;
    for (int i = 0; i < (int)APP_MOTORCALIBRATION_SETTLE_MS - 10; i++) { step(); }
    TEST_ASSERT_EQUAL_INT(APP_MOTORCALIBRATION_STATE_FORWARD, result().state);
    d_encoder += 2.0; /* ...right up to the read */
    for (int i = 0; i < 20; i++) { step(); }

    TEST_ASSERT_EQUAL_INT32(8192 + 42, result().countsForward);
}

void test_a_request_is_reported_as_starting_at_once(void)
{
    VIBES_TEST("motorcal.starting-at-once",
               "src/APP/app_motorCalibration.c#app_motorCalibration_request",
               "a finished calibration, then a new one is requested");
    VIBES_EXPECT_WHY("starting-reported",
                     "the result reads as starting, with the previous measurements cleared, before the control loop has run",
                     "the app reads the result straight after asking and must never mistake the last run's numbers for this one's");
    VIBES_EXPECT("busy-meanwhile", "the calibration counts as in progress from the moment it is accepted");

    TEST_ASSERT_TRUE(app_motorCalibration_request(&REQ_1MM));
    (void)run_to_end(10000);
    TEST_ASSERT_TRUE(app_motorCalibration_request(&REQ_1MM));

    const app_motorCalibration_result_S r = result();
    TEST_ASSERT_EQUAL_INT(APP_MOTORCALIBRATION_STATE_STARTING, r.state);
    TEST_ASSERT_EQUAL_INT32(0, r.countsForward);
    TEST_ASSERT_EQUAL_INT32(0, r.pulsesForward);
    TEST_ASSERT_TRUE(app_motorCalibration_isActive());
}

void test_malformed_or_overlapping_requests_are_refused(void)
{
    VIBES_TEST("motorcal.request-limits",
               "src/APP/app_motorCalibration.c#app_motorCalibration_request",
               "motor calibration requests outside its limits, or while one is running");
    VIBES_EXPECT("zero-refused", "a request for no pulses, at no rate, or with no travel bound is refused");
    VIBES_EXPECT_WHY("caps-enforced",
                     "a request for more than 200000 pulses or faster than 20000 pulses a second is refused",
                     "the calibration is meant to be short and slow whatever the host asks for");
    VIBES_EXPECT("one-at-a-time", "a second request while one is running is refused");

    const app_motorCalibration_request_S noPulses = { 0U, 1000U, 100U };
    const app_motorCalibration_request_S noRate = { 1000U, 0U, 100U };
    const app_motorCalibration_request_S noBound = { 1000U, 1000U, 0U };
    const app_motorCalibration_request_S tooFar = { APP_MOTORCALIBRATION_MAX_PULSES + 1U, 1000U, 100U };
    const app_motorCalibration_request_S tooFast = { 1000U, APP_MOTORCALIBRATION_MAX_FREQUENCY + 1U, 100U };
    TEST_ASSERT_FALSE(app_motorCalibration_request(&noPulses));
    TEST_ASSERT_FALSE(app_motorCalibration_request(&noRate));
    TEST_ASSERT_FALSE(app_motorCalibration_request(&noBound));
    TEST_ASSERT_FALSE(app_motorCalibration_request(&tooFar));
    TEST_ASSERT_FALSE(app_motorCalibration_request(&tooFast));

    TEST_ASSERT_TRUE(app_motorCalibration_request(&REQ_1MM));
    TEST_ASSERT_FALSE(app_motorCalibration_request(&REQ_1MM));
}

void test_disabled_motion_refuses_the_calibration(void)
{
    VIBES_TEST("motorcal.refused-motion-off",
               "src/APP/app_motorCalibration.c#app_motorCalibration_run",
               "a motor calibration is requested while motion is disabled");
    VIBES_EXPECT("refused", "the calibration is refused and says motion was off");
    VIBES_EXPECT("no-pulses", "no pulses are sent");

    d_motionEnabled = false;
    TEST_ASSERT_TRUE(app_motorCalibration_request(&REQ_1MM));
    const app_motorCalibration_result_S r = run_to_end(10);

    TEST_ASSERT_EQUAL_INT(APP_MOTORCALIBRATION_STATE_REFUSED_MOTION_DISABLED, r.state);
    TEST_ASSERT_EQUAL_INT(0, d_startCount);
}

void test_a_busy_machine_refuses_the_calibration(void)
{
    VIBES_TEST("motorcal.refused-busy",
               "src/APP/app_motorCalibration.c#app_motorCalibration_run",
               "a motor calibration is requested while a move or a test is running");
    VIBES_EXPECT("refused", "the calibration is refused and says the machine was busy");
    VIBES_EXPECT("no-pulses", "no pulses are sent");

    d_motionIdle = false;
    TEST_ASSERT_TRUE(app_motorCalibration_request(&REQ_1MM));
    TEST_ASSERT_EQUAL_INT(APP_MOTORCALIBRATION_STATE_REFUSED_BUSY, run_to_end(10).state);

    d_motionIdle = true;
    d_testRunning = true;
    TEST_ASSERT_TRUE(app_motorCalibration_request(&REQ_1MM));
    TEST_ASSERT_EQUAL_INT(APP_MOTORCALIBRATION_STATE_REFUSED_BUSY, run_to_end(10).state);
    TEST_ASSERT_EQUAL_INT(0, d_startCount);
}

void test_a_made_end_stop_refuses_the_calibration(void)
{
    VIBES_TEST("motorcal.refused-at-endstop",
               "src/APP/app_motorCalibration.c#app_motorCalibration_run",
               "a motor calibration is requested with the carriage on an end stop");
    VIBES_EXPECT_WHY("refused",
                     "the calibration is refused and says an end stop was made",
                     "the calibration drives both ways, so one of them would push into the stop");
    VIBES_EXPECT("no-pulses", "no pulses are sent");

    d_endstopLower = true;
    TEST_ASSERT_TRUE(app_motorCalibration_request(&REQ_1MM));
    TEST_ASSERT_EQUAL_INT(APP_MOTORCALIBRATION_STATE_REFUSED_AT_ENDSTOP, run_to_end(10).state);
    TEST_ASSERT_EQUAL_INT(0, d_startCount);
}

void test_disabling_motion_mid_run_abandons_it(void)
{
    VIBES_TEST("motorcal.aborted-motion-off",
               "src/APP/app_motorCalibration.c#app_motorCalibration_run",
               "motion is disabled part way through the forward pulses of a motor calibration");
    VIBES_EXPECT("abandoned", "the calibration is abandoned and says motion was turned off");
    VIBES_EXPECT("no-reverse", "the reverse pulses are never sent");

    TEST_ASSERT_TRUE(app_motorCalibration_request(&REQ_1MM));
    for (int i = 0; i < 100; i++) { step(); }
    d_motionEnabled = false;
    const app_motorCalibration_result_S r = run_to_end(10);

    TEST_ASSERT_EQUAL_INT(APP_MOTORCALIBRATION_STATE_ABORTED_MOTION_DISABLED, r.state);
    TEST_ASSERT_EQUAL_INT(1, d_startCount);
}

void test_a_fault_mid_run_abandons_it_and_stops_the_drive(void)
{
    VIBES_TEST("motorcal.aborted-fault",
               "src/APP/app_motorCalibration.c#app_motorCalibration_run",
               "the machine faults part way through a motor calibration");
    VIBES_EXPECT("abandoned", "the calibration is abandoned and says the machine faulted");
    VIBES_EXPECT("drive-stopped", "the drive stops sending pulses");

    TEST_ASSERT_TRUE(app_motorCalibration_request(&REQ_1MM));
    for (int i = 0; i < 100; i++) { step(); }
    d_fault = APP_CONTROL_FAULT_ESD_SWITCH;
    const app_motorCalibration_result_S r = run_to_end(10);

    TEST_ASSERT_EQUAL_INT(APP_MOTORCALIBRATION_STATE_ABORTED_FAULT, r.state);
    TEST_ASSERT_FALSE(d_olRunning);
}

void test_reaching_an_end_stop_mid_run_abandons_it(void)
{
    VIBES_TEST("motorcal.aborted-endstop",
               "src/APP/app_motorCalibration.c#app_motorCalibration_run",
               "the carriage reaches an end stop part way through a motor calibration");
    VIBES_EXPECT("abandoned", "the calibration is abandoned and says an end stop was reached");
    VIBES_EXPECT("drive-stopped", "the drive stops sending pulses");

    TEST_ASSERT_TRUE(app_motorCalibration_request(&REQ_1MM));
    for (int i = 0; i < 100; i++) { step(); }
    d_endstopUpper = true;
    const app_motorCalibration_result_S r = run_to_end(10);

    TEST_ASSERT_EQUAL_INT(APP_MOTORCALIBRATION_STATE_ABORTED_ENDSTOP, r.state);
    TEST_ASSERT_FALSE(d_olRunning);
}

void test_an_encoder_running_past_its_bound_abandons_the_run(void)
{
    VIBES_TEST("motorcal.aborted-overtravel",
               "src/APP/app_motorCalibration.c#app_motorCalibration_run",
               "a motor calibration whose encoder moves further than the request allows");
    VIBES_EXPECT_WHY("abandoned",
                     "the calibration is abandoned as soon as the bound is passed, and says it overtravelled",
                     "a drive set far finer than the profile claims carries the carriage much further than intended");
    VIBES_EXPECT("drive-stopped", "the drive stops sending pulses before they are all out");

    d_countsPerPulse = 5.0;
    TEST_ASSERT_TRUE(app_motorCalibration_request(&REQ_1MM)); /* bound: 3 x 8192 counts */
    const app_motorCalibration_result_S r = run_to_end(10000);

    TEST_ASSERT_EQUAL_INT(APP_MOTORCALIBRATION_STATE_ABORTED_OVERTRAVEL, r.state);
    TEST_ASSERT_FALSE(d_olRunning);
    TEST_ASSERT_TRUE(d_olEmitted < 8192U);
}

void test_a_leg_that_never_finishes_times_out(void)
{
    VIBES_TEST("motorcal.aborted-timeout",
               "src/APP/app_motorCalibration.c#app_motorCalibration_run",
               "a motor calibration whose drive never finishes sending its pulses");
    VIBES_EXPECT("waits-its-time",
                 "the calibration keeps waiting for up to twice the time the pulses should take, plus a second");
    VIBES_EXPECT("abandoned", "the calibration is then abandoned and says it timed out");

    TEST_ASSERT_TRUE(app_motorCalibration_request(&REQ_1MM)); /* nominal 1 s => 3 s limit */
    step();
    d_olFreq = 0U; /* the plant still ticks, but emits only one pulse per ms... */
    d_olPulses = 100000000; /* ...towards a count it never reaches in time */
    for (int i = 0; i < 2900; i++) { step(); }
    TEST_ASSERT_EQUAL_INT(APP_MOTORCALIBRATION_STATE_FORWARD, result().state);
    for (int i = 0; i < 200; i++) { step(); }

    TEST_ASSERT_EQUAL_INT(APP_MOTORCALIBRATION_STATE_ABORTED_TIMEOUT, result().state);
}

void test_pulses_without_movement_still_complete(void)
{
    VIBES_TEST("motorcal.encoder-silent",
               "src/APP/app_motorCalibration.c#app_motorCalibration_run",
               "a motor calibration on a machine whose encoder never counts");
    VIBES_EXPECT_WHY("completes-with-zero",
                     "the calibration completes and reports no encoder change in either direction",
                     "an encoder that is not coupled to the motor is exactly what the check is for");

    d_drivesMotion = false;
    TEST_ASSERT_TRUE(app_motorCalibration_request(&REQ_1MM));
    const app_motorCalibration_result_S r = run_to_end(10000);

    TEST_ASSERT_EQUAL_INT(APP_MOTORCALIBRATION_STATE_DONE, r.state);
    TEST_ASSERT_EQUAL_INT32(0, r.countsForward);
    TEST_ASSERT_EQUAL_INT32(0, r.countsReverse);
    TEST_ASSERT_EQUAL_INT32(8192, r.pulsesForward);
}

void test_a_restricted_machine_refuses_the_calibration(void)
{
    VIBES_TEST("motorcal.refused-restricted",
               "src/APP/app_motorCalibration.c#app_motorCalibration_run",
               "a motor calibration is requested while the machine is speed-restricted, for example with the door open");
    VIBES_EXPECT_WHY("refused",
                     "the calibration is refused and says the machine was restricted",
                     "the calibration drives at the speed it was asked for, and the restricted-speed cap is what protects someone reaching in through an open door");
    VIBES_EXPECT("no-pulses", "no pulses are sent");

    d_restricted = true;
    TEST_ASSERT_TRUE(app_motorCalibration_request(&REQ_1MM));
    TEST_ASSERT_EQUAL_INT(APP_MOTORCALIBRATION_STATE_REFUSED_RESTRICTED, run_to_end(10).state);
    TEST_ASSERT_EQUAL_INT(0, d_startCount);
}

void test_an_end_stop_is_named_ahead_of_the_restriction_it_causes(void)
{
    VIBES_TEST("motorcal.endstop-named-before-restriction",
               "src/APP/app_motorCalibration.c#app_motorCalibration_run",
               "a motor calibration is requested with the carriage on an end stop, which also restricts the machine's speed");
    VIBES_EXPECT_WHY("says-endstop",
                     "the calibration is refused and says the carriage is on an end stop",
                     "jogging clear of the stop is what the operator has to do, and a bare 'restricted' would not say so");

    d_endstopUpper = true;
    d_restricted = true;
    TEST_ASSERT_TRUE(app_motorCalibration_request(&REQ_1MM));
    TEST_ASSERT_EQUAL_INT(APP_MOTORCALIBRATION_STATE_REFUSED_AT_ENDSTOP, run_to_end(10).state);
}

void test_a_restriction_mid_run_abandons_it(void)
{
    VIBES_TEST("motorcal.aborted-restricted",
               "src/APP/app_motorCalibration.c#app_motorCalibration_run",
               "the machine becomes speed-restricted, for example the door is opened, part way through a motor calibration");
    VIBES_EXPECT("abandoned", "the calibration is abandoned and says the machine became restricted");
    VIBES_EXPECT("drive-stopped", "the drive stops sending pulses");
    VIBES_EXPECT("no-reverse", "the reverse pulses are never sent");

    TEST_ASSERT_TRUE(app_motorCalibration_request(&REQ_1MM));
    for (int i = 0; i < 100; i++) { step(); }
    d_restricted = true;
    const app_motorCalibration_result_S r = run_to_end(10);

    TEST_ASSERT_EQUAL_INT(APP_MOTORCALIBRATION_STATE_ABORTED_RESTRICTED, r.state);
    TEST_ASSERT_FALSE(d_olRunning);
    TEST_ASSERT_EQUAL_INT(1, d_startCount);
}

void test_a_jog_acked_before_the_calibration_starts_takes_the_drive(void)
{
    VIBES_TEST("motorcal.gives-way-to-an-acked-jog",
               "src/APP/app_motorCalibration.c#app_motorCalibration_run",
               "a motor calibration starts while motion is idle, and on a later tick motion starts a move that takes the drive out of open loop, as a jog queued after the request does");
    VIBES_EXPECT_WHY("starts",
                     "the calibration starts its forward pulses, because nothing is moving yet",
                     "an acknowledged jog waits in a request slot until the next tick, so neither motion nor the test runner can see it yet");
    VIBES_EXPECT_WHY("gives-way-at-once",
                     "on the tick the jog starts moving, the calibration is abandoned and says a jog took the drive",
                     "a leg is measured only while the drive is in open loop, so the outcome has to name the jog the tick it takes over");
    VIBES_EXPECT_WHY("jog-not-cancelled",
                     "the drive is left running the jog",
                     "the operator asked for that move, and motion has already capped its speed");
    VIBES_EXPECT("no-reverse", "the reverse pulses are never sent");

    /* Tick N: the jog is ACKed into a request slot after the slots were
     * drained, then the calibration request lands: motion still reads idle. */
    TEST_ASSERT_TRUE(app_motorCalibration_request(&REQ_1MM));
    step();
    TEST_ASSERT_EQUAL_INT(APP_MOTORCALIBRATION_STATE_FORWARD, result().state);
    TEST_ASSERT_EQUAL_INT(1, d_startCount);

    /* Tick N+1: the jog is queued and app_motion starts it, which takes the
     * drive out of open loop (the leg will never report done). */
    d_motionIdle = false;
    d_olRunning = false;
    step();

    TEST_ASSERT_EQUAL_INT(APP_MOTORCALIBRATION_STATE_ABORTED_JOG, result().state);
    TEST_ASSERT_EQUAL_INT(0, d_stopCount);
    TEST_ASSERT_EQUAL_INT(1, d_startCount);
}

void test_a_jog_mode_change_keeps_the_run_until_the_jog_takes_the_drive(void)
{
    VIBES_TEST("motorcal.busy-motion-without-the-drive",
               "src/APP/app_motorCalibration.c#app_motorCalibration_run",
               "part way through a motor calibration, Control jogs: motion runs the G91 that leaves the drive in open loop, goes idle, and on a later tick starts the G0 that takes the drive");
    VIBES_EXPECT_WHY("keeps-running",
                     "while motion runs the G91 and after it, the calibration carries on its forward leg and still counts as in progress",
                     "the jog's G0 starts after its G91 has finished, and the jog is capped only while the calibration is in progress");
    VIBES_EXPECT("abandoned", "on the tick the G0 takes the drive, the calibration is abandoned and says a jog took the drive");
    VIBES_EXPECT_WHY("jog-not-cancelled",
                     "the drive is left running the jog",
                     "the operator asked for that move, and motion started it at the capped speed");
    VIBES_EXPECT("single-leg", "only the forward pulses are sent");

    TEST_ASSERT_TRUE(app_motorCalibration_request(&REQ_1MM));
    for (int i = 0; i < 100; i++) { step(); }
    TEST_ASSERT_EQUAL_INT(APP_MOTORCALIBRATION_STATE_FORWARD, result().state);

    /* Tick K: motion runs the G91; the drive is still in open loop. */
    d_motionIdle = false;
    step();
    TEST_ASSERT_EQUAL_INT(APP_MOTORCALIBRATION_STATE_FORWARD, result().state);
    TEST_ASSERT_TRUE(app_motorCalibration_isActive());

    /* Tick K+1: the G91 is done; the G0 is popped on the next tick, and
     * app_motion reads the calibration as active when it starts it. */
    d_motionIdle = true;
    step();
    TEST_ASSERT_EQUAL_INT(APP_MOTORCALIBRATION_STATE_FORWARD, result().state);
    TEST_ASSERT_TRUE(app_motorCalibration_isActive());
    TEST_ASSERT_EQUAL_INT(0, d_stopCount);

    /* Tick K+2: the G0 starts and takes the drive out of open loop. */
    d_motionIdle = false;
    d_olRunning = false;
    step();

    TEST_ASSERT_EQUAL_INT(APP_MOTORCALIBRATION_STATE_ABORTED_JOG, result().state);
    TEST_ASSERT_FALSE(app_motorCalibration_isActive());
    TEST_ASSERT_EQUAL_INT(0, d_stopCount);
    TEST_ASSERT_EQUAL_INT(1, d_startCount);
}

int main(void)
{
    UNITY_BEGIN();
    RUN_TEST(test_a_matched_machine_reports_one_count_per_pulse_both_ways);
    RUN_TEST(test_a_mismatched_backwards_encoder_is_reported_as_measured);
    RUN_TEST(test_an_encoder_read_waits_for_the_carriage_to_settle);
    RUN_TEST(test_a_request_is_reported_as_starting_at_once);
    RUN_TEST(test_malformed_or_overlapping_requests_are_refused);
    RUN_TEST(test_disabled_motion_refuses_the_calibration);
    RUN_TEST(test_a_busy_machine_refuses_the_calibration);
    RUN_TEST(test_a_made_end_stop_refuses_the_calibration);
    RUN_TEST(test_disabling_motion_mid_run_abandons_it);
    RUN_TEST(test_a_fault_mid_run_abandons_it_and_stops_the_drive);
    RUN_TEST(test_reaching_an_end_stop_mid_run_abandons_it);
    RUN_TEST(test_an_encoder_running_past_its_bound_abandons_the_run);
    RUN_TEST(test_a_leg_that_never_finishes_times_out);
    RUN_TEST(test_pulses_without_movement_still_complete);
    RUN_TEST(test_a_restricted_machine_refuses_the_calibration);
    RUN_TEST(test_an_end_stop_is_named_ahead_of_the_restriction_it_causes);
    RUN_TEST(test_a_restriction_mid_run_abandons_it);
    RUN_TEST(test_a_jog_acked_before_the_calibration_starts_takes_the_drive);
    RUN_TEST(test_a_jog_mode_change_keeps_the_run_until_the_jog_takes_the_drive);
    return UNITY_END();
}
