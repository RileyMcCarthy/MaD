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
 *     / door GPIOs, and first-restriction-wins ordering. Restrictions are only
 *     reflected as RESTRICTED once motion is enabled and there's no fault.
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
    /* Restrictions only ever query the MACHINE frame (the SAMPLE block is
     * commented out in the module today). */
    TEST_ASSERT_EQUAL_INT(APP_GAUGE_COORD_MACHINE, coord);
    return d_machineForce;
}

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

/* --- dev_stepper --- */
static bool d_stepperReady; /* dev_stepper_isReady(MAIN) */
bool dev_stepper_isReady(dev_stepper_channel_E ch)
{
    TEST_ASSERT_EQUAL_INT(DEV_STEPPER_CHANNEL_MAIN, ch);
    return d_stepperReady;
}

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

    /* No-fault baseline: cogs running, watchdog alive, ESD GPIOs inactive,
     * servo + force gauge ready. */
    d_cogAllRunning = true;
    d_watchdogAlive = true;
    d_stepperReady = true;
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
    control_init();
    app_control_run();
    TEST_ASSERT_EQUAL_INT(APP_CONTROL_FAULT_NONE, app_control_getFault());
}

void test_run_cogFaultDetected(void)
{
    control_init();
    d_cogAllRunning = false; /* set BEFORE the run() that snapshots it */
    app_control_run();
    TEST_ASSERT_EQUAL_INT(APP_CONTROL_FAULT_COG, app_control_getFault());
}

void test_run_watchdogFaultDetected(void)
{
    control_init();
    d_watchdogAlive = false;
    app_control_run();
    TEST_ASSERT_EQUAL_INT(APP_CONTROL_FAULT_WATCHDOG, app_control_getFault());
}

void test_run_esdPowerFaultDetected(void)
{
    control_init();
    d_gpio[HAL_GPIO_ESD_POWER] = true;
    app_control_run();
    TEST_ASSERT_EQUAL_INT(APP_CONTROL_FAULT_ESD_POWER, app_control_getFault());
}

void test_run_servoCommunicationFaultWhenNotReady(void)
{
    control_init();
    d_stepperReady = false; /* dev_stepper_isReady == false → fault */
    app_control_run();
    TEST_ASSERT_EQUAL_INT(APP_CONTROL_FAULT_SERVO_COMMUNICATION, app_control_getFault());
}

void test_run_forceGaugeCommunicationFaultWhenNotReady(void)
{
    control_init();
    d_forceGaugeReady = false;
    app_control_run();
    TEST_ASSERT_EQUAL_INT(APP_CONTROL_FAULT_FORCE_GAUGE_COMMUNICATION, app_control_getFault());
}

/* First-fault-wins: COG precedes WATCHDOG in the enum, so with both tripped the
 * reported fault is the lower-index one (COG). */
void test_run_firstFaultWinsPriority(void)
{
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
    control_init();
    d_gpio[HAL_GPIO_ENDSTOP_DOOR] = true; /* restriction present */
    app_control_run();
    TEST_ASSERT_EQUAL_INT(APP_CONTROL_STATE_DISABLED, app_control_data.state);
}

/* Motion enabled, no fault, no restriction, test not running → MANUAL. */
void test_run_manualWhenEnabledAndIdle(void)
{
    control_init();
    enableMotion();
    app_control_run(); /* steady-state */
    TEST_ASSERT_EQUAL_INT(APP_CONTROL_STATE_MANUAL, app_control_data.state);
}

/* Motion enabled, no fault, no restriction, test running → TEST. */
void test_run_testStateWhenRunning(void)
{
    control_init();
    enableMotion();
    d_testRunning = true;
    app_control_run();
    TEST_ASSERT_EQUAL_INT(APP_CONTROL_STATE_TEST, app_control_data.state);
}

/* A restriction outranks the test-running flag → RESTRICTED, not TEST. */
void test_run_restrictionOutranksTest(void)
{
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
    control_init();
    app_control_run(); /* DISABLED (motion never enabled) */
    TEST_ASSERT_EQUAL_INT(APP_CONTROL_STATE_DISABLED, app_control_data.state);
    TEST_ASSERT_FALSE(app_control_motionEnabled());
    TEST_ASSERT_FALSE(app_control_speedLimited());
}

void test_outputs_restrictedLimitsSpeed(void)
{
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
    control_init();
    enableMotion(); /* MANUAL */
    TEST_ASSERT_TRUE(app_control_motionEnabled());
    TEST_ASSERT_FALSE(app_control_speedLimited());
}

void test_outputs_testEnablesMotionFullSpeed(void)
{
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
    d_stepperReady = true;
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
        d_stepperReady = false;
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
            d_stepperReady = false;
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

/* Sample length/tension paths are currently compiled out (commented) — pin that
 * they stay inactive so re-enabling them without tests fails this lock. */
void test_m4_sample_restrictions_inactive_today(void)
{
    control_init();
    enableMotion();
    d_testRunning = true;
    d_machineForce = 0; /* no machine tension */
    app_control_run();
    TEST_ASSERT_FALSE(app_control_data.restriction[APP_CONTROL_RESTRICTION_SAMPLE_LENGTH]);
    TEST_ASSERT_FALSE(app_control_data.restriction[APP_CONTROL_RESTRICTION_SAMPLE_TENSION]);
    /* Still TEST (no active restriction). */
    TEST_ASSERT_EQUAL_INT(APP_CONTROL_STATE_TEST, app_control_data.state);
}

/* Restriction priority chain: MACHINE_TENSION < UPPER < LOWER < DOOR indices. */
void test_m4_restriction_priority_chain(void)
{
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
    RUN_TEST(test_m4_sample_restrictions_inactive_today);
    RUN_TEST(test_m4_restriction_priority_chain);

    return UNITY_END();
}
