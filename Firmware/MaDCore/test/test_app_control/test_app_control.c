/*
 * Unit tests for src/APP/app_control.c — the machine-level state machine that
 * fuses faults, restrictions, and the motion-enable request into one of:
 *   DISABLED → RESTRICTED → MANUAL → TEST  (see APP/app_control.h)
 *
 * app_control_run() is an INPUT-SNAPSHOT pipeline: each call reads every
 * collaborator once, recomputes faults/restrictions/state, then publishes the
 * outputs. So: set the double values BEFORE the run() that snapshots them, and
 * read the resulting state/outputs AFTER that same run().
 *
 * Coverage focus (meaningful behavior, no vacuous asserts):
 *   - init: maxMachineTension is loaded from the NVRAM machine profile; state
 *     starts DISABLED.
 *   - fault detection + first-fault-wins priority ordering, and the DISABLED
 *     override (a fault forces DISABLED regardless of motionEnabled).
 *   - restriction detection: machine-tension boundary is strictly '>', endstop
 *     / door GPIOs, sample force/displacement via app_monitor flags while a
 *     test is running, and first-restriction-wins ordering. Restrictions are
 *     only reflected as RESTRICTED once motion is enabled and there's no fault.
 *   - desired-state precedence: fault > !motionEnabled > restriction >
 *     !testRunning(MANUAL) > TEST.
 *   - per-state outputs (motionEnabled / speedLimited).
 *   - request handling: triggerMotionEnabled is gated on no-fault and only
 *     takes effect on the next run(); triggerMotionDisabled always latches.
 *
 * Library/ (lib_*) is compiled for real. Every peer dependency below is a local
 * controllable double. HAL_lock is the native mock from test/mock_propeller2.c.
 */

#include <unity.h>
#include "vibes_behaviour.h"
#include <string.h>
#include <stdint.h>
#include <stdbool.h>
#include <stddef.h>

#include "HAL_lock.h"
#include "HAL_GPIO.h"
#include "app_gauge.h"               // app_gauge_coord_E
#include "dev_stepper_config.h"      // dev_stepper_channel_E
#include "dev_forceGauge_config.h"   // dev_forceGauge_channel_E
#include "dev_nvram_config.h"        // dev_nvram_channel_t
#include "dev_nvram_machineProfile.h"// MachineProfile

/* The module under test. Bare header includes resolve via -I; only the .c
 * needs the relative path. */
#include "../../src/APP/app_control.c"

/**********************************************************************
 * Shared HAL mock (test/mock_propeller2.c)
 **********************************************************************/
extern void HAL_lock_mock_reset(void);
extern uint32_t global_timeus;
extern int _stdio_debug_lock; /* defined in mock_propeller2.c */

/**********************************************************************
 * Test doubles for peer dependencies (controllable via static globals)
 **********************************************************************/

/* --- app_gauge --- */
static int32_t d_machineForce; /* app_gauge_getForce(MACHINE) */
int32_t app_gauge_getForce(app_gauge_coord_E coord)
{
    /* Machine tension uses MACHINE frame; sample limits come from app_monitor. */
    TEST_ASSERT_EQUAL_INT(APP_GAUGE_COORD_MACHINE, coord);
    return d_machineForce;
}

/* --- app_monitor (sample restriction flags) --- */
static bool d_forceExceeded;
static bool d_displacementExceeded;
bool app_monitor_isForceExceeded(void) { return d_forceExceeded; }
bool app_monitor_isDisplacementExceeded(void) { return d_displacementExceeded; }

/* --- app_testManagement --- */
static bool d_testRunning; /* app_testManagement_isRunning() */
bool app_testManagement_isRunning(void) { return d_testRunning; }

/* --- dev_cogManager --- */
static bool d_cogAllRunning; /* dev_cogManager_isAllRunning() */
bool dev_cogManager_isAllRunning(void) { return d_cogAllRunning; }

/* --- watchdog --- */
static bool d_watchdogAlive; /* watchdog_isAllAlive() */
bool watchdog_isAllAlive(void) { return d_watchdogAlive; }

/* --- HAL_GPIO --- */
static bool d_gpio[HAL_GPIO_COUNT]; /* HAL_GPIO_getActive(channel) */
bool HAL_GPIO_getActive(HAL_GPIO_channel_E channel)
{
    TEST_ASSERT_TRUE(channel >= 0 && channel < HAL_GPIO_COUNT);
    return d_gpio[channel];
}

/* --- actuator (the MOTOR-cog driver app_control gates on; APP_MOTION_USE_SERVO
 *     picks which one, exactly as in the module under test) --- */
static bool d_actuatorReady;
#if APP_MOTION_USE_SERVO
bool dev_servo_isReady(dev_servo_channel_E ch)
{
    TEST_ASSERT_EQUAL_INT(DEV_SERVO_CHANNEL_MAIN, ch);
    return d_actuatorReady;
}
#else
bool dev_stepper_isReady(dev_stepper_channel_E ch)
{
    TEST_ASSERT_EQUAL_INT(DEV_STEPPER_CHANNEL_MAIN, ch);
    return d_actuatorReady;
}
#endif

/* --- dev_forceGauge --- */
static bool d_forceGaugeReady; /* dev_forceGauge_isReady(MAIN) */
bool dev_forceGauge_isReady(dev_forceGauge_channel_E channel)
{
    TEST_ASSERT_EQUAL_INT(DEV_FORCEGAUGE_CHANNEL_MAIN, channel);
    return d_forceGaugeReady;
}

/* --- dev_nvram (init only reads the machine profile) --- */
static int32_t d_nvramMaxForceTensile;
static bool d_nvramGetReturn;
static int d_nvramGetCalls;
static dev_nvram_channel_t d_nvramLastChannel;
bool dev_nvram_getChannelData(dev_nvram_channel_t channel, void *data, size_t size)
{
    d_nvramGetCalls++;
    d_nvramLastChannel = channel;
    if (data != NULL && size >= sizeof(MachineProfile))
    {
        MachineProfile mp;
        memset(&mp, 0, sizeof(mp));
        mp.maxForceTensile = d_nvramMaxForceTensile;
        memcpy(data, &mp, sizeof(MachineProfile));
    }
    return d_nvramGetReturn;
}

/**********************************************************************
 * Fixture helpers
 **********************************************************************/

/* "All clear" default inputs: no faults, no restrictions, motion not enabled. */
static void doubles_reset(void)
{
    d_machineForce = 0;
    d_testRunning = false;
    d_forceExceeded = false;
    d_displacementExceeded = false;

    /* No-fault baseline: cogs running, watchdog alive, ESD GPIOs inactive,
     * servo + force gauge ready. */
    d_cogAllRunning = true;
    d_watchdogAlive = true;
    d_actuatorReady = true;
    d_forceGaugeReady = true;

    memset(d_gpio, 0, sizeof(d_gpio));

    d_nvramMaxForceTensile = 5000;
    d_nvramGetReturn = true;
    d_nvramGetCalls = 0;
    d_nvramLastChannel = (dev_nvram_channel_t)0;
}

static void control_init(void)
{
    /* Matrix tests call control_init() many times in one RUN_TEST; reset the
     * lock pool so we never exhaust the mock's 8-slot table mid-test. */
    HAL_lock_mock_reset();
    _stdio_debug_lock = HAL_lock_create();
    doubles_reset();
    /* app_control_data is a single file-static instance and app_control_init()
     * only assigns a few fields — the motionEnabled latch and pending request
     * flags persist across tests. Zero it for per-test isolation (legitimate
     * because we #include the module and own its storage in this binary). */
    memset(&app_control_data, 0, sizeof(app_control_data));
    app_control_init(HAL_lock_create());
}

/* Run() to a state where motion is enabled, no fault, no restriction → MANUAL,
 * which is the precondition for observing RESTRICTED/TEST transitions. */
static void enableMotion(void)
{
    TEST_ASSERT_TRUE(app_control_triggerMotionEnabled());
    app_control_run(); /* processes the request, recomputes state */
    TEST_ASSERT_EQUAL_INT(APP_CONTROL_STATE_MANUAL, app_control_data.state);
    TEST_ASSERT_TRUE(app_control_motionEnabled());
}

void setUp(void)
{
    HAL_lock_mock_reset();
    _stdio_debug_lock = HAL_lock_create();
    global_timeus = 0;
}

void tearDown(void) {}

/**********************************************************************
 * init
 **********************************************************************/

void test_init_loadsMaxMachineTensionAndDisabled(void)
{
    VIBES_TEST("control.starts-disabled-with-stored-max-tension",
               "src/APP/app_control.c#app_control_init",
               "the controller starting up");
    VIBES_EXPECT("max-tension-from-profile",
                 "the maximum tension comes from the stored machine profile");
    VIBES_EXPECT("starts-disabled", "the machine starts disabled with motion off");
    doubles_reset();
    d_nvramMaxForceTensile = 12345;
    app_control_init(HAL_lock_create());

    /* init pulls the machine profile from the MACHINE_PROFILE channel ... */
    TEST_ASSERT_EQUAL_INT(1, d_nvramGetCalls);
    TEST_ASSERT_EQUAL_INT(DEV_NVRAM_CHANNEL_MACHINE_PROFILE, d_nvramLastChannel);
    TEST_ASSERT_EQUAL_INT32(12345, app_control_data.nvram.maxMachineTension);

    /* ... and starts DISABLED with motion off. */
    TEST_ASSERT_EQUAL_INT(APP_CONTROL_STATE_DISABLED, app_control_data.state);
    TEST_ASSERT_FALSE(app_control_motionEnabled());
}

/**********************************************************************
 * Fault detection + priority
 **********************************************************************/

void test_run_noFaultWhenAllInputsHealthy(void)
{
    VIBES_TEST("control.no-fault-when-healthy",
               "src/APP/app_control.c#app_control_run",
               "a freshly started controller with nothing tripped, stalled or unresponsive");
    VIBES_EXPECT_WHY("no-fault",
                     "the machine reports no fault",
                     "a fault raised when nothing is wrong holds the machine disabled and no test can be started");
    control_init();
    app_control_run();
    TEST_ASSERT_EQUAL_INT(APP_CONTROL_FAULT_NONE, app_control_getFault());
}

void test_run_cogFaultDetected(void)
{
    VIBES_TEST("control.stopped-core-is-a-fault",
               "src/APP/app_control.c#app_control_run",
               "one of the cores stops reporting that it is running");
    VIBES_EXPECT_WHY("core-fault-reported",
                     "the machine faults and names a processor core as the reason",
                     "the motion and monitoring loops run on separate cores; one dying silently would leave the machine moving unsupervised");
    control_init();
    d_cogAllRunning = false; /* set BEFORE the run() that snapshots it */
    app_control_run();
    TEST_ASSERT_EQUAL_INT(APP_CONTROL_FAULT_COG, app_control_getFault());
}

void test_run_watchdogFaultDetected(void)
{
    VIBES_TEST("control.watchdog-stall-fault",
               "src/APP/app_control.c#app_control_run",
               "a loop the watchdog supervises stops checking in, with every processor core still running");
    VIBES_EXPECT_WHY("watchdog-fault-reported",
                     "the machine faults and names the watchdog as the reason",
                     "a core counts as running even when the loop on it has wedged, so the check-in is the only thing that catches a stalled loop");
    control_init();
    d_watchdogAlive = false;
    app_control_run();
    TEST_ASSERT_EQUAL_INT(APP_CONTROL_FAULT_WATCHDOG, app_control_getFault());
}

void test_run_esdPowerFaultDetected(void)
{
    VIBES_TEST("control.esd-power-loss-faults",
               "src/APP/app_control.c#app_control_run",
               "the emergency-stop power line reporting lost power, with everything else healthy");
    VIBES_EXPECT_WHY("power-fault-reported",
                     "the machine faults, giving the emergency-stop power supply as the reason",
                     "each emergency-stop reason sends the operator to a different part of the wiring to clear and reset");
    control_init();
    d_gpio[HAL_GPIO_ESD_POWER] = true;
    app_control_run();
    TEST_ASSERT_EQUAL_INT(APP_CONTROL_FAULT_ESD_POWER, app_control_getFault());
}

void test_run_servoCommunicationFaultWhenNotReady(void)
{
    VIBES_TEST("control.motor-drive-communication-fault",
               "src/APP/app_control.c#app_control_run",
               "the drive that moves the gantry stops reporting that it is ready");
    VIBES_EXPECT_WHY("drive-fault-reported",
                     "the machine reports a drive communication fault",
                     "the machine is built with one of two motor drives, and only the drive actually running reports its readiness, so the controller asks the active one");
    control_init();
    d_actuatorReady = false; /* the active actuator's isReady == false → fault */
    app_control_run();
    TEST_ASSERT_EQUAL_INT(APP_CONTROL_FAULT_SERVO_COMMUNICATION, app_control_getFault());
}

void test_run_forceGaugeCommunicationFaultWhenNotReady(void)
{
    VIBES_TEST("control.unresponsive-load-cell-is-a-fault",
               "src/APP/app_control.c#app_control_run",
               "the load cell stops reporting that it is ready");
    VIBES_EXPECT_WHY("load-cell-fault-reported",
                     "the machine faults and names the load cell as the reason",
                     "both the frame and the sample force limits are judged from the load cell, so a gauge gone quiet would leave the gantry pulling against a stale reading");
    control_init();
    d_forceGaugeReady = false;
    app_control_run();
    TEST_ASSERT_EQUAL_INT(APP_CONTROL_FAULT_FORCE_GAUGE_COMMUNICATION, app_control_getFault());
}

/* First-fault-wins: COG precedes WATCHDOG in the enum, so with both tripped the
 * reported fault is the lower-index one (COG). */
void test_run_firstFaultWinsPriority(void)
{
    VIBES_TEST("control.first-fault-wins",
               "src/APP/app_control.c#app_control_run",
               "a stopped core, a stalled watchdog and an unresponsive load cell together");
    VIBES_EXPECT("stopped-core-reported", "the machine reports the stopped core as the fault");
    control_init();
    d_cogAllRunning = false;       /* APP_CONTROL_FAULT_COG (index 1) */
    d_watchdogAlive = false;       /* APP_CONTROL_FAULT_WATCHDOG (index 2) */
    d_forceGaugeReady = false;     /* a much later fault */
    app_control_run();
    TEST_ASSERT_EQUAL_INT(APP_CONTROL_FAULT_COG, app_control_getFault());
}

/**********************************************************************
 * Restriction detection + priority
 **********************************************************************/

/* Machine-tension restriction uses a strict '>' against maxMachineTension.
 * At exactly the threshold it must NOT trip; one above it must. */
void test_run_machineTensionBoundaryStrictGreater(void)
{
    VIBES_TEST("control.machine-tension-strict-boundary",
               "src/APP/app_control.c#app_control_run",
               "machine force at the configured maximum, then one unit above");
    VIBES_EXPECT("at-maximum-unrestricted",
                 "the machine stays unrestricted at the maximum");
    VIBES_EXPECT("above-maximum-restricts",
                 "one unit above the maximum it restricts motion and names frame tension");
    control_init();
    enableMotion();
    /* maxMachineTension defaults to 5000 from the profile. */

    /* Exactly at threshold → not restricted. */
    d_machineForce = 5000;
    app_control_run();
    TEST_ASSERT_FALSE(app_control_data.restriction[APP_CONTROL_RESTRICTION_MACHINE_TENSION]);
    TEST_ASSERT_EQUAL_INT(APP_CONTROL_STATE_MANUAL, app_control_data.state);

    /* One above threshold → restricted. */
    d_machineForce = 5001;
    app_control_run();
    TEST_ASSERT_TRUE(app_control_data.restriction[APP_CONTROL_RESTRICTION_MACHINE_TENSION]);
    TEST_ASSERT_EQUAL_INT(APP_CONTROL_RESTRICTION_MACHINE_TENSION, app_control_getRestriction());
    TEST_ASSERT_EQUAL_INT(APP_CONTROL_STATE_RESTRICTED, app_control_data.state);
}

void test_run_doorRestrictionDetected(void)
{
    VIBES_TEST("control.open-door-restricts",
               "src/APP/app_control.c#app_control_run",
               "the door endstop reporting open while motion is enabled");
    VIBES_EXPECT_WHY("door-named",
                     "the machine names the door as the reason",
                     "the door is the last limit the controller checks, so a check stopping one short would leave the machine at full speed with the guard open");
    VIBES_EXPECT("restricted", "the machine goes to the restricted state");
    control_init();
    enableMotion();
    d_gpio[HAL_GPIO_ENDSTOP_DOOR] = true;
    app_control_run();
    TEST_ASSERT_EQUAL_INT(APP_CONTROL_RESTRICTION_DOOR, app_control_getRestriction());
    TEST_ASSERT_EQUAL_INT(APP_CONTROL_STATE_RESTRICTED, app_control_data.state);
}

/* First-restriction-wins: UPPER_ENDSTOP (index 4) precedes DOOR (index 6). */
void test_run_firstRestrictionWinsPriority(void)
{
    VIBES_TEST("control.first-restriction-wins",
               "src/APP/app_control.c#app_control_run",
               "the upper endstop reached and the door open together, with motion enabled");
    VIBES_EXPECT("upper-endstop-named",
                 "the machine names the upper endstop as the restriction");
    control_init();
    enableMotion();
    d_gpio[HAL_GPIO_ENDSTOP_UPPER] = true; /* RESTRICTION_UPPER_ENDSTOP */
    d_gpio[HAL_GPIO_ENDSTOP_DOOR] = true;  /* RESTRICTION_DOOR */
    app_control_run();
    TEST_ASSERT_EQUAL_INT(APP_CONTROL_RESTRICTION_UPPER_ENDSTOP, app_control_getRestriction());
}

/* Machine-tension precedes the endstops in the enum, so it wins over a door
 * restriction even though both are active. */
void test_run_machineTensionWinsOverDoor(void)
{
    control_init();
    enableMotion();
    d_machineForce = 99999;                /* RESTRICTION_MACHINE_TENSION (idx 3) */
    d_gpio[HAL_GPIO_ENDSTOP_DOOR] = true;  /* RESTRICTION_DOOR (idx 6) */
    app_control_run();
    TEST_ASSERT_EQUAL_INT(APP_CONTROL_RESTRICTION_MACHINE_TENSION, app_control_getRestriction());
}

/**********************************************************************
 * Desired-state precedence
 **********************************************************************/

/* A fault forces DISABLED even though motion is enabled AND a restriction is
 * present (fault outranks everything). */
void test_run_faultForcesDisabledOverEverything(void)
{
    VIBES_TEST("control.fault-outranks-restriction",
               "src/APP/app_control.c#app_control_run",
               "a stopped core and an open door together, after the operator has enabled motion");
    VIBES_EXPECT_WHY("stays-disabled",
                     "the machine stays disabled",
                     "the restricted state only caps speed, so a restriction outranking a fault would keep the gantry pulling while something was known to be broken");
    VIBES_EXPECT("core-named", "the stopped core is given as the reason");
    control_init();
    enableMotion();

    d_cogAllRunning = false;               /* fault */
    d_gpio[HAL_GPIO_ENDSTOP_DOOR] = true;  /* restriction too */
    app_control_run();
    TEST_ASSERT_EQUAL_INT(APP_CONTROL_STATE_DISABLED, app_control_data.state);
    TEST_ASSERT_EQUAL_INT(APP_CONTROL_FAULT_COG, app_control_getFault());
}

/* No fault but motion not enabled → DISABLED, even though a restriction exists.
 * (motionEnabled is false at boot, so we never call enableMotion here.) */
void test_run_motionDisabledOutranksRestriction(void)
{
    VIBES_TEST("control.motion-off-outranks-restriction",
               "src/APP/app_control.c#app_control_run",
               "a just-started machine with no faults, motion never enabled, and the door open");
    VIBES_EXPECT_WHY("stays-disabled",
                     "the machine stays disabled",
                     "the restricted state still lets the gantry move, so a limit reached must never be what brings the machine out of disabled");
    control_init();
    d_gpio[HAL_GPIO_ENDSTOP_DOOR] = true; /* restriction present */
    app_control_run();
    TEST_ASSERT_EQUAL_INT(APP_CONTROL_STATE_DISABLED, app_control_data.state);
}

/* Motion enabled, no fault, no restriction, test not running → MANUAL. */
void test_run_manualWhenEnabledAndIdle(void)
{
    VIBES_TEST("control.manual-holds-while-idle",
               "src/APP/app_control.c#app_control_run",
               "an operator enabling motion with no fault, no limit reached and no test running, then nothing changing");
    VIBES_EXPECT("manual-held", "the machine holds manual mode across the following update");
    control_init();
    enableMotion();
    app_control_run(); /* steady-state */
    TEST_ASSERT_EQUAL_INT(APP_CONTROL_STATE_MANUAL, app_control_data.state);
}

/* Motion enabled, no fault, no restriction, test running → TEST. */
void test_run_testStateWhenRunning(void)
{
    VIBES_TEST("control.test-run-leaves-manual",
               "src/APP/app_control.c#app_control_run",
               "a machine settled in manual control, then a test run starts");
    VIBES_EXPECT("test-state", "the machine leaves manual control and enters the test state");
    control_init();
    enableMotion();
    d_testRunning = true;
    app_control_run();
    TEST_ASSERT_EQUAL_INT(APP_CONTROL_STATE_TEST, app_control_data.state);
}

/* A restriction outranks the test-running flag → RESTRICTED, not TEST. */
void test_run_restrictionOutranksTest(void)
{
    VIBES_TEST("control.restriction-outranks-running-test",
               "src/APP/app_control.c#app_control_run",
               "a test already running with motion enabled, then the lower endstop reached");
    VIBES_EXPECT_WHY("restricted",
                     "the machine enters the restricted state",
                     "a limit reached during a test caps speed straight away, whatever stage the test has got to");
    VIBES_EXPECT("lower-endstop-named", "the lower endstop is given as the reason");
    control_init();
    enableMotion();
    d_testRunning = true;
    d_gpio[HAL_GPIO_ENDSTOP_LOWER] = true;
    app_control_run();
    TEST_ASSERT_EQUAL_INT(APP_CONTROL_STATE_RESTRICTED, app_control_data.state);
    TEST_ASSERT_EQUAL_INT(APP_CONTROL_RESTRICTION_LOWER_ENDSTOP, app_control_getRestriction());
}

/**********************************************************************
 * Per-state outputs (motionEnabled / speedLimited)
 **********************************************************************/

void test_outputs_disabledStateGatesMotion(void)
{
    VIBES_TEST("control.motion-stays-off-until-enabled",
               "src/APP/app_control.c#app_control_run",
               "a freshly started machine with every input healthy and nobody having asked for motion");
    VIBES_EXPECT_WHY("no-motion",
                     "the machine allows no motion at all",
                     "a gantry that armed itself the moment everything looked healthy could start pulling with an operator's hands in the frame");
    VIBES_EXPECT("stays-disabled", "the machine stays disabled");
    control_init();
    app_control_run(); /* DISABLED (motion never enabled) */
    TEST_ASSERT_EQUAL_INT(APP_CONTROL_STATE_DISABLED, app_control_data.state);
    TEST_ASSERT_FALSE(app_control_motionEnabled());
    TEST_ASSERT_FALSE(app_control_speedLimited());
}

void test_outputs_restrictedLimitsSpeed(void)
{
    VIBES_TEST("control.restricted-caps-speed",
               "src/APP/app_control.c#app_control_run",
               "motion enabled with no fault, then the door reporting open");
    VIBES_EXPECT_WHY("motion-kept",
                     "the machine enters the restricted state and keeps driving the gantry",
                     "a limit is something the operator still has to drive back off, so motion stays available");
    VIBES_EXPECT("speed-capped", "the gantry speed is capped");
    control_init();
    enableMotion();
    d_gpio[HAL_GPIO_ENDSTOP_DOOR] = true;
    app_control_run(); /* RESTRICTED */
    TEST_ASSERT_EQUAL_INT(APP_CONTROL_STATE_RESTRICTED, app_control_data.state);
    /* RESTRICTED keeps motion enabled but caps the speed. */
    TEST_ASSERT_TRUE(app_control_motionEnabled());
    TEST_ASSERT_TRUE(app_control_speedLimited());
}

void test_outputs_manualEnablesMotionFullSpeed(void)
{
    VIBES_TEST("control.manual-runs-at-full-speed",
               "src/APP/app_control.c#app_control_run",
               "an operator enabling motion on a clean machine with no test running");
    VIBES_EXPECT("motion-allowed", "the machine permits motion");
    VIBES_EXPECT("full-speed", "the gantry runs at full speed");
    control_init();
    enableMotion(); /* MANUAL */
    TEST_ASSERT_TRUE(app_control_motionEnabled());
    TEST_ASSERT_FALSE(app_control_speedLimited());
}

void test_outputs_testEnablesMotionFullSpeed(void)
{
    VIBES_TEST("control.running-test-not-speed-limited",
               "src/APP/app_control.c#app_control_run",
               "a healthy machine with motion enabled and a test reported as running");
    VIBES_EXPECT_WHY("full-speed",
                     "the gantry runs at full speed",
                     "a tensile test is only valid if the gantry travels at the programmed rate");
    VIBES_EXPECT("test-state", "the machine enters the test state");
    VIBES_EXPECT("motion-kept", "motion stays available");
    control_init();
    enableMotion();
    d_testRunning = true;
    app_control_run(); /* TEST */
    TEST_ASSERT_EQUAL_INT(APP_CONTROL_STATE_TEST, app_control_data.state);
    TEST_ASSERT_TRUE(app_control_motionEnabled());
    TEST_ASSERT_FALSE(app_control_speedLimited());
}

/**********************************************************************
 * Motion-enable request handling
 **********************************************************************/

/* The request only takes effect on the NEXT run(); reading state before the
 * run still shows DISABLED. */
void test_request_motionEnabledTakesEffectNextRun(void)
{
    VIBES_TEST("control.motion-enable-takes-effect-next-cycle",
               "src/APP/app_control.c#app_control_run",
               "a fault-free machine sitting disabled, an operator asking to enable motion, with motion checked before and after the next control update");
    VIBES_EXPECT("request-accepted", "the request is accepted at once");
    VIBES_EXPECT_WHY("off-until-update",
                     "motion stays off until that update",
                     "that same update re-reads the cores, the load cell, the endstops and the door, so an accepted request can never move the machine without a fresh safety check");
    VIBES_EXPECT("enabled-by-update",
                 "that update puts the machine under manual control with motion on");
    control_init();
    TEST_ASSERT_TRUE(app_control_triggerMotionEnabled());

    /* Before any run, the latched output still reflects boot DISABLED. */
    TEST_ASSERT_FALSE(app_control_motionEnabled());

    app_control_run();
    TEST_ASSERT_EQUAL_INT(APP_CONTROL_STATE_MANUAL, app_control_data.state);
    TEST_ASSERT_TRUE(app_control_motionEnabled());
}

/* triggerMotionEnabled is gated on no active fault. With a fault latched, the
 * request is refused (returns false) and motion never enables. */
void test_request_motionEnabledRefusedWhileFaulted(void)
{
    VIBES_TEST("control.refused-enable-not-queued",
               "src/APP/app_control.c#app_control_run",
               "a stopped core, a request to enable motion made while that fault stands, then the core healthy again");
    VIBES_EXPECT("enable-refused", "the request is turned down while the fault stands");
    VIBES_EXPECT_WHY("stays-disabled",
                     "the machine stays disabled with motion off, and enabling it takes a fresh request",
                     "the gantry moves only when an operator asks for it with the machine already healthy");
    control_init();
    d_cogAllRunning = false;
    app_control_run(); /* latch the COG fault into faultedReason */
    TEST_ASSERT_EQUAL_INT(APP_CONTROL_FAULT_COG, app_control_getFault());

    TEST_ASSERT_FALSE(app_control_triggerMotionEnabled());

    /* Even after the fault clears, motion stays disabled because the request
     * was refused (never latched). */
    d_cogAllRunning = true;
    app_control_run();
    TEST_ASSERT_EQUAL_INT(APP_CONTROL_STATE_DISABLED, app_control_data.state);
    TEST_ASSERT_FALSE(app_control_motionEnabled());
}

/* triggerMotionDisabled always latches and disables motion on the next run. */
void test_request_motionDisabledAlwaysLatches(void)
{
    VIBES_TEST("control.stop-request-never-refused",
               "src/APP/app_control.c#app_control_run",
               "a machine under manual control with motion enabled, and an operator request to stop motion");
    VIBES_EXPECT_WHY("request-accepted",
                     "the request is accepted",
                     "a request to enable motion can be turned down by an active fault, but the stop path has no such gate");
    VIBES_EXPECT("disabled-next-update",
                 "the next update leaves the machine disabled with motion off");
    control_init();
    enableMotion(); /* MANUAL, motion enabled */

    TEST_ASSERT_TRUE(app_control_triggerMotionDisabled());
    app_control_run();
    TEST_ASSERT_EQUAL_INT(APP_CONTROL_STATE_DISABLED, app_control_data.state);
    TEST_ASSERT_FALSE(app_control_motionEnabled());
}

/**********************************************************************
 * M4 — fault × restriction matrices (parameterized tables)
 **********************************************************************/

/* Trip exactly one fault source, leave all others healthy. */
static void trip_fault_only(app_control_fault_E fault)
{
    doubles_reset();
    d_cogAllRunning = true;
    d_watchdogAlive = true;
    d_actuatorReady = true;
    d_forceGaugeReady = true;
    memset(d_gpio, 0, sizeof(d_gpio));
    switch (fault)
    {
    case APP_CONTROL_FAULT_COG:
        d_cogAllRunning = false;
        break;
    case APP_CONTROL_FAULT_WATCHDOG:
        d_watchdogAlive = false;
        break;
    case APP_CONTROL_FAULT_ESD_POWER:
        d_gpio[HAL_GPIO_ESD_POWER] = true;
        break;
    case APP_CONTROL_FAULT_ESD_SWITCH:
        d_gpio[HAL_GPIO_ESD_SWITCH] = true;
        break;
    case APP_CONTROL_FAULT_ESD_UPPER:
        d_gpio[HAL_GPIO_ESD_UPPER] = true;
        break;
    case APP_CONTROL_FAULT_ESD_LOWER:
        d_gpio[HAL_GPIO_ESD_LOWER] = true;
        break;
    case APP_CONTROL_FAULT_SERVO_COMMUNICATION:
        d_actuatorReady = false;
        break;
    case APP_CONTROL_FAULT_FORCE_GAUGE_COMMUNICATION:
        d_forceGaugeReady = false;
        break;
    case APP_CONTROL_FAULT_NONE:
    case APP_CONTROL_FAULT_COUNT:
    default:
        break;
    }
}

/* Every non-NONE fault alone → getFault() == that fault, state DISABLED. */
void test_m4_each_fault_alone_reported_and_disables(void)
{
    VIBES_TEST("control.every-fault-alone-disables",
               "src/APP/app_control.c#app_control_run",
               "each of the eight fault sources tripped in turn, with every other input healthy");
    VIBES_EXPECT_WHY("fault-named",
                     "the machine names that fault as the reason",
                     "the reported reason is what the operator reads to diagnose a machine that will not move, and each one points at a different part of the machine");
    VIBES_EXPECT("stays-disabled", "the machine stays disabled");
    VIBES_EXPECT("no-motion", "no motion is allowed");
    static const app_control_fault_E faults[] = {
        APP_CONTROL_FAULT_COG,
        APP_CONTROL_FAULT_WATCHDOG,
        APP_CONTROL_FAULT_ESD_POWER,
        APP_CONTROL_FAULT_ESD_SWITCH,
        APP_CONTROL_FAULT_ESD_UPPER,
        APP_CONTROL_FAULT_ESD_LOWER,
        APP_CONTROL_FAULT_SERVO_COMMUNICATION,
        APP_CONTROL_FAULT_FORCE_GAUGE_COMMUNICATION,
    };
    for (size_t i = 0; i < sizeof(faults) / sizeof(faults[0]); i++)
    {
        control_init();
        trip_fault_only(faults[i]);
        app_control_run();
        TEST_ASSERT_EQUAL_INT(faults[i], app_control_getFault());
        TEST_ASSERT_EQUAL_INT(APP_CONTROL_STATE_DISABLED, app_control_data.state);
        TEST_ASSERT_FALSE(app_control_motionEnabled());
    }
}

/* Enable is refused while each fault is latched. */
void test_m4_enable_refused_for_each_fault(void)
{
    VIBES_TEST("control.no-enable-while-any-fault",
               "src/APP/app_control.c#app_control_run",
               "each fault source tripped on its own, with the operator then asking to enable motion");
    VIBES_EXPECT("enable-refused", "the request is turned down");
    VIBES_EXPECT("stays-disabled", "the machine stays disabled with motion off");
    static const app_control_fault_E faults[] = {
        APP_CONTROL_FAULT_COG,
        APP_CONTROL_FAULT_WATCHDOG,
        APP_CONTROL_FAULT_ESD_POWER,
        APP_CONTROL_FAULT_ESD_SWITCH,
        APP_CONTROL_FAULT_ESD_UPPER,
        APP_CONTROL_FAULT_ESD_LOWER,
        APP_CONTROL_FAULT_SERVO_COMMUNICATION,
        APP_CONTROL_FAULT_FORCE_GAUGE_COMMUNICATION,
    };
    for (size_t i = 0; i < sizeof(faults) / sizeof(faults[0]); i++)
    {
        control_init();
        trip_fault_only(faults[i]);
        app_control_run();
        TEST_ASSERT_FALSE(app_control_triggerMotionEnabled());
        app_control_run();
        TEST_ASSERT_FALSE(app_control_motionEnabled());
        TEST_ASSERT_EQUAL_INT(APP_CONTROL_STATE_DISABLED, app_control_data.state);
    }
}

/* First-fault-wins across consecutive enum pairs (i beats i+1). */
void test_m4_first_fault_wins_adjacent_pairs(void)
{
    VIBES_TEST("control.fault-priority-order",
               "src/APP/app_control.c#app_control_run",
               "each adjacent pair of fault causes tripped at the same time, in turn");
    VIBES_EXPECT_WHY("earlier-cause-reported",
                     "the machine reports the earlier one in a fixed order: stopped core, stalled watchdog, emergency-stop inputs, drive, load cell",
                     "causes near the front produce the ones behind them, since a dead core also stops the drive answering, so this order names the root cause");
    /* Pair sources that can be co-asserted via independent doubles. */
    typedef struct
    {
        app_control_fault_E lower;
        app_control_fault_E higher;
    } pair_t;
    static const pair_t pairs[] = {
        {APP_CONTROL_FAULT_COG, APP_CONTROL_FAULT_WATCHDOG},
        {APP_CONTROL_FAULT_WATCHDOG, APP_CONTROL_FAULT_ESD_POWER},
        {APP_CONTROL_FAULT_ESD_POWER, APP_CONTROL_FAULT_ESD_SWITCH},
        {APP_CONTROL_FAULT_ESD_SWITCH, APP_CONTROL_FAULT_ESD_UPPER},
        {APP_CONTROL_FAULT_ESD_UPPER, APP_CONTROL_FAULT_ESD_LOWER},
        {APP_CONTROL_FAULT_ESD_LOWER, APP_CONTROL_FAULT_SERVO_COMMUNICATION},
        {APP_CONTROL_FAULT_SERVO_COMMUNICATION, APP_CONTROL_FAULT_FORCE_GAUGE_COMMUNICATION},
    };
    for (size_t i = 0; i < sizeof(pairs) / sizeof(pairs[0]); i++)
    {
        control_init();
        /* Assert both; lower index must win. */
        trip_fault_only(pairs[i].lower);
        /* Add the higher fault without clearing the lower. */
        switch (pairs[i].higher)
        {
        case APP_CONTROL_FAULT_WATCHDOG:
            d_watchdogAlive = false;
            break;
        case APP_CONTROL_FAULT_ESD_POWER:
            d_gpio[HAL_GPIO_ESD_POWER] = true;
            break;
        case APP_CONTROL_FAULT_ESD_SWITCH:
            d_gpio[HAL_GPIO_ESD_SWITCH] = true;
            break;
        case APP_CONTROL_FAULT_ESD_UPPER:
            d_gpio[HAL_GPIO_ESD_UPPER] = true;
            break;
        case APP_CONTROL_FAULT_ESD_LOWER:
            d_gpio[HAL_GPIO_ESD_LOWER] = true;
            break;
        case APP_CONTROL_FAULT_SERVO_COMMUNICATION:
            d_actuatorReady = false;
            break;
        case APP_CONTROL_FAULT_FORCE_GAUGE_COMMUNICATION:
            d_forceGaugeReady = false;
            break;
        default:
            break;
        }
        app_control_run();
        TEST_ASSERT_EQUAL_INT(pairs[i].lower, app_control_getFault());
    }
}

/* Active (non-commented) restrictions each alone → RESTRICTED when motion on. */
void test_m4_each_active_restriction_alone(void)
{
    VIBES_TEST("control.every-physical-limit-restricts-alone",
               "src/APP/app_control.c#app_control_run",
               "motion enabled with no faults, then one limit tripped from a fresh start: frame tension, either travel endstop, or the door open");
    VIBES_EXPECT_WHY("limit-named",
                     "the machine names that limit as the reason",
                     "each limit is wired into the state machine separately, so one never connected would let the gantry run at full speed into the frame with nothing reported");
    VIBES_EXPECT("restricted", "the machine goes to the restricted state");
    /* MACHINE_TENSION */
    control_init();
    enableMotion();
    d_machineForce = 5001;
    app_control_run();
    TEST_ASSERT_EQUAL_INT(APP_CONTROL_RESTRICTION_MACHINE_TENSION, app_control_getRestriction());
    TEST_ASSERT_EQUAL_INT(APP_CONTROL_STATE_RESTRICTED, app_control_data.state);
    TEST_ASSERT_TRUE(app_control_speedLimited());

    control_init();
    enableMotion();
    d_gpio[HAL_GPIO_ENDSTOP_UPPER] = true;
    app_control_run();
    TEST_ASSERT_EQUAL_INT(APP_CONTROL_RESTRICTION_UPPER_ENDSTOP, app_control_getRestriction());
    TEST_ASSERT_EQUAL_INT(APP_CONTROL_STATE_RESTRICTED, app_control_data.state);

    control_init();
    enableMotion();
    d_gpio[HAL_GPIO_ENDSTOP_LOWER] = true;
    app_control_run();
    TEST_ASSERT_EQUAL_INT(APP_CONTROL_RESTRICTION_LOWER_ENDSTOP, app_control_getRestriction());
    TEST_ASSERT_EQUAL_INT(APP_CONTROL_STATE_RESTRICTED, app_control_data.state);

    control_init();
    enableMotion();
    d_gpio[HAL_GPIO_ENDSTOP_DOOR] = true;
    app_control_run();
    TEST_ASSERT_EQUAL_INT(APP_CONTROL_RESTRICTION_DOOR, app_control_getRestriction());
    TEST_ASSERT_EQUAL_INT(APP_CONTROL_STATE_RESTRICTED, app_control_data.state);
}

/* Sample restrictions (SAMPLE_LENGTH / SAMPLE_TENSION) active only while a
 * test is running and app_monitor reports limit exceeded. */
void test_m4_sample_restrictions_inactive_when_not_running(void)
{
    VIBES_TEST("control.sample-limits-only-during-test",
               "src/APP/app_control.c#app_control_run",
               "motion enabled with no test running, and the sample past both its force and extension limits");
    VIBES_EXPECT_WHY("no-sample-restriction",
                     "neither sample limit restricts the machine",
                     "a specimen left gripped past its limits would otherwise hold the machine speed-limited while the operator jogs the gantry to unload it");
    VIBES_EXPECT("manual-kept", "the machine stays in manual control");
    control_init();
    enableMotion();
    d_forceExceeded = true;
    d_displacementExceeded = true;
    d_testRunning = false;
    app_control_run();
    TEST_ASSERT_FALSE(app_control_data.restriction[APP_CONTROL_RESTRICTION_SAMPLE_LENGTH]);
    TEST_ASSERT_FALSE(app_control_data.restriction[APP_CONTROL_RESTRICTION_SAMPLE_TENSION]);
    TEST_ASSERT_EQUAL_INT(APP_CONTROL_STATE_MANUAL, app_control_data.state);
}

void test_m4_sample_tension_restricts_while_test_running(void)
{
    VIBES_TEST("control.sample-force-limit-restricts-during-test",
               "src/APP/app_control.c#app_control_run",
               "a test under way, the sample over its own force limit, and frame tension near zero");
    VIBES_EXPECT_WHY("force-limit-named",
                     "the machine names the sample force limit as the reason",
                     "the operator's configured force limit is what protects the specimen for the whole of a test");
    VIBES_EXPECT("restricted", "the machine enters the restricted state");
    VIBES_EXPECT("speed-capped", "the gantry speed is capped");
    control_init();
    enableMotion();
    d_testRunning = true;
    d_machineForce = 0;
    d_forceExceeded = true;
    app_control_run();
    TEST_ASSERT_TRUE(app_control_data.restriction[APP_CONTROL_RESTRICTION_SAMPLE_TENSION]);
    TEST_ASSERT_EQUAL_INT(APP_CONTROL_RESTRICTION_SAMPLE_TENSION, app_control_getRestriction());
    TEST_ASSERT_EQUAL_INT(APP_CONTROL_STATE_RESTRICTED, app_control_data.state);
    TEST_ASSERT_TRUE(app_control_speedLimited());
}

void test_m4_sample_length_restricts_while_test_running(void)
{
    VIBES_TEST("control.sample-extension-limit-restricts-during-test",
               "src/APP/app_control.c#app_control_run",
               "a test running with motion enabled, the sample past its extension limit, and frame tension low");
    VIBES_EXPECT_WHY("extension-limit-named",
                     "the machine names the sample extension limit as the reason",
                     "the operator's configured extension limit holds for the whole of a test");
    VIBES_EXPECT("restricted", "the machine enters the restricted state");
    control_init();
    enableMotion();
    d_testRunning = true;
    d_machineForce = 0;
    d_displacementExceeded = true;
    app_control_run();
    TEST_ASSERT_TRUE(app_control_data.restriction[APP_CONTROL_RESTRICTION_SAMPLE_LENGTH]);
    /* SAMPLE_LENGTH has lower enum index than SAMPLE_TENSION → wins alone. */
    TEST_ASSERT_EQUAL_INT(APP_CONTROL_RESTRICTION_SAMPLE_LENGTH, app_control_getRestriction());
    TEST_ASSERT_EQUAL_INT(APP_CONTROL_STATE_RESTRICTED, app_control_data.state);
}

void test_m4_sample_length_wins_over_sample_tension(void)
{
    VIBES_TEST("control.sample-extension-limit-reported-over-force-limit",
               "src/APP/app_control.c#app_control_run",
               "a test under way with the sample past both its force and its extension limit at once");
    VIBES_EXPECT_WHY("extension-limit-named",
                     "the machine names the extension limit as the reason for the restriction",
                     "the two trip together as a specimen yields, so the reason shown to the operator is a fixed choice");
    control_init();
    enableMotion();
    d_testRunning = true;
    d_forceExceeded = true;
    d_displacementExceeded = true;
    app_control_run();
    TEST_ASSERT_EQUAL_INT(APP_CONTROL_RESTRICTION_SAMPLE_LENGTH, app_control_getRestriction());
}

/* Restriction priority chain: MACHINE_TENSION < UPPER < LOWER < DOOR indices. */
void test_m4_restriction_priority_chain(void)
{
    VIBES_TEST("control.restriction-priority-order",
               "src/APP/app_control.c#app_control_run",
               "tension above the frame maximum with both endstops and the door open; then tension back in range; then only the lower endstop and the door");
    VIBES_EXPECT_WHY("fixed-order",
                     "the machine names just one, in a fixed order: frame tension, the upper endstop, the lower endstop, then the door",
                     "only one reason is reported at a time, and when the top condition clears the next one down takes over");
    control_init();
    enableMotion();
    d_machineForce = 99999; /* idx MACHINE_TENSION */
    d_gpio[HAL_GPIO_ENDSTOP_UPPER] = true;
    d_gpio[HAL_GPIO_ENDSTOP_LOWER] = true;
    d_gpio[HAL_GPIO_ENDSTOP_DOOR] = true;
    app_control_run();
    TEST_ASSERT_EQUAL_INT(APP_CONTROL_RESTRICTION_MACHINE_TENSION, app_control_getRestriction());

    control_init();
    enableMotion();
    d_gpio[HAL_GPIO_ENDSTOP_UPPER] = true;
    d_gpio[HAL_GPIO_ENDSTOP_LOWER] = true;
    d_gpio[HAL_GPIO_ENDSTOP_DOOR] = true;
    app_control_run();
    TEST_ASSERT_EQUAL_INT(APP_CONTROL_RESTRICTION_UPPER_ENDSTOP, app_control_getRestriction());

    control_init();
    enableMotion();
    d_gpio[HAL_GPIO_ENDSTOP_LOWER] = true;
    d_gpio[HAL_GPIO_ENDSTOP_DOOR] = true;
    app_control_run();
    TEST_ASSERT_EQUAL_INT(APP_CONTROL_RESTRICTION_LOWER_ENDSTOP, app_control_getRestriction());
}

/**********************************************************************
 * main
 **********************************************************************/

int main(void)
{
    UNITY_BEGIN();

    RUN_TEST(test_init_loadsMaxMachineTensionAndDisabled);

    RUN_TEST(test_run_noFaultWhenAllInputsHealthy);
    RUN_TEST(test_run_cogFaultDetected);
    RUN_TEST(test_run_watchdogFaultDetected);
    RUN_TEST(test_run_esdPowerFaultDetected);
    RUN_TEST(test_run_servoCommunicationFaultWhenNotReady);
    RUN_TEST(test_run_forceGaugeCommunicationFaultWhenNotReady);
    RUN_TEST(test_run_firstFaultWinsPriority);

    RUN_TEST(test_run_machineTensionBoundaryStrictGreater);
    RUN_TEST(test_run_doorRestrictionDetected);
    RUN_TEST(test_run_firstRestrictionWinsPriority);
    RUN_TEST(test_run_machineTensionWinsOverDoor);

    RUN_TEST(test_run_faultForcesDisabledOverEverything);
    RUN_TEST(test_run_motionDisabledOutranksRestriction);
    RUN_TEST(test_run_manualWhenEnabledAndIdle);
    RUN_TEST(test_run_testStateWhenRunning);
    RUN_TEST(test_run_restrictionOutranksTest);

    RUN_TEST(test_outputs_disabledStateGatesMotion);
    RUN_TEST(test_outputs_restrictedLimitsSpeed);
    RUN_TEST(test_outputs_manualEnablesMotionFullSpeed);
    RUN_TEST(test_outputs_testEnablesMotionFullSpeed);

    RUN_TEST(test_request_motionEnabledTakesEffectNextRun);
    RUN_TEST(test_request_motionEnabledRefusedWhileFaulted);
    RUN_TEST(test_request_motionDisabledAlwaysLatches);

    RUN_TEST(test_m4_each_fault_alone_reported_and_disables);
    RUN_TEST(test_m4_enable_refused_for_each_fault);
    RUN_TEST(test_m4_first_fault_wins_adjacent_pairs);
    RUN_TEST(test_m4_each_active_restriction_alone);
    RUN_TEST(test_m4_sample_restrictions_inactive_when_not_running);
    RUN_TEST(test_m4_sample_tension_restricts_while_test_running);
    RUN_TEST(test_m4_sample_length_restricts_while_test_running);
    RUN_TEST(test_m4_sample_length_wins_over_sample_tension);
    RUN_TEST(test_m4_restriction_priority_chain);

    return UNITY_END();
}
