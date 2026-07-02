//
// Created by Riley McCarthy on 25/04/24.
//
/**********************************************************************
 * Includes
 **********************************************************************/
#include "app_control.h"
#include "app_gauge.h"
#include "app_monitor.h"
#include "app_messageSlave.h"
#include "app_testManagement.h"

#include "dev_nvram.h"
#include "dev_cogManager.h"
#include "dev_forceGauge.h"
#include "dev_stepper.h"
#include "watchdog.h"

#include "HAL_GPIO.h"
#include "HAL_lock.h"
#include <string.h>
#include "emulation_helpers.h"
/**********************************************************************
 * Constants
 **********************************************************************/

/* ===== BENCH TEST BYPASS (TEMPORARY) =====
 * 1 = bench testing with the force gauge / stepper / encoder DISCONNECTED.
 * Forces the hardware-communication + ESD/endstop safety gates clear so motion
 * can be enabled and a test can run without sensors attached. The stepper is
 * open-loop (pulse generation), so moves still execute. The COG and WATCHDOG
 * integrity faults are left ACTIVE. MUST be 0 for any real machine. */
#define APP_CONTROL_BENCH_TEST_BYPASS 1

/*********************************************************************
 * Macros
 **********************************************************************/
#define APP_CONTROL_LOCK_REQ() HAL_lock_try(app_control_data.lock)
#define APP_CONTROL_LOCK_REQ_BLOCK()        \
    while (APP_CONTROL_LOCK_REQ() == false) \
    {                                       \
        EMULATION_YIELD_LOCK();            \
    }
#define APP_CONTROL_LOCK_REL() (void)HAL_lock_release(app_control_data.lock)
/**********************************************************************
 * Typedefs
 **********************************************************************/

typedef struct
{
    bool triggerMotionEnabled;
    bool triggerMotionDisabled;
} app_control_request_S;

typedef struct
{
    bool motionEnabled;
    bool limitSpeed;
} app_control_output_S;

typedef struct
{
    int32_t maxMachineTension;
} app_control_nvram_S;

typedef struct
{
    app_control_request_S request;

    bool fault[APP_CONTROL_FAULT_COUNT];
    bool restriction[APP_CONTROL_RESTRICTION_COUNT];
    app_control_output_S out;

    bool motionEnabled;
    bool testRunning;
    app_control_fault_E faultedReason;
    app_control_restriction_E restrictedReason;

    app_control_state_E state;
    app_control_nvram_S nvram;

    int32_t lock;
} app_control_data_S;
/**********************************************************************
 * External Variables
 **********************************************************************/

/**********************************************************************
 * Private Variable Definitions
 **********************************************************************/
static app_control_data_S app_control_data;
/**********************************************************************
 * Private Function Prototypes
 **********************************************************************/

static void app_control_private_processRequests(void);
static app_control_fault_E app_control_private_processFaults(void);
static app_control_restriction_E app_control_private_processRestrictions(void);
static app_control_state_E app_control_private_getDesiredState(void);

/**********************************************************************
 * Private Function Definitions
 **********************************************************************/

static void app_control_private_processRequests(void)
{
    APP_CONTROL_LOCK_REQ_BLOCK();
    if (app_control_data.request.triggerMotionEnabled)
    {
        app_control_data.motionEnabled = true;
        app_control_data.request.triggerMotionEnabled = false;
    }

    if (app_control_data.request.triggerMotionDisabled)
    {
        app_control_data.motionEnabled = false;
        app_control_data.request.triggerMotionDisabled = false;
    }
    APP_CONTROL_LOCK_REL();
}

static app_control_fault_E app_control_private_processFaults(void)
{
    app_control_data.fault[APP_CONTROL_FAULT_COG] = dev_cogManager_isAllRunning() == false;
    app_control_data.fault[APP_CONTROL_FAULT_WATCHDOG] = watchdog_isAllAlive() == false;
    app_control_data.fault[APP_CONTROL_FAULT_ESD_POWER] = HAL_GPIO_getActive(HAL_GPIO_ESD_POWER);
    app_control_data.fault[APP_CONTROL_FAULT_ESD_SWITCH] = HAL_GPIO_getActive(HAL_GPIO_ESD_SWITCH);
    app_control_data.fault[APP_CONTROL_FAULT_ESD_UPPER] = HAL_GPIO_getActive(HAL_GPIO_ESD_UPPER);
    app_control_data.fault[APP_CONTROL_FAULT_ESD_LOWER] = HAL_GPIO_getActive(HAL_GPIO_ESD_LOWER);
    app_control_data.fault[APP_CONTROL_FAULT_SERVO_COMMUNICATION] = (dev_stepper_isReady(DEV_STEPPER_CHANNEL_MAIN) == false);
    app_control_data.fault[APP_CONTROL_FAULT_FORCE_GAUGE_COMMUNICATION] = (dev_forceGauge_isReady(DEV_FORCEGAUGE_CHANNEL_MAIN) == false);

#if APP_CONTROL_BENCH_TEST_BYPASS
    /* Sensors/actuators disconnected on the bench: clear the hardware-comm and
     * ESD gates so motion can be enabled. COG/WATCHDOG above stay real. */
    app_control_data.fault[APP_CONTROL_FAULT_ESD_POWER] = false;
    app_control_data.fault[APP_CONTROL_FAULT_ESD_SWITCH] = false;
    app_control_data.fault[APP_CONTROL_FAULT_ESD_UPPER] = false;
    app_control_data.fault[APP_CONTROL_FAULT_ESD_LOWER] = false;
    app_control_data.fault[APP_CONTROL_FAULT_SERVO_COMMUNICATION] = false;
    app_control_data.fault[APP_CONTROL_FAULT_FORCE_GAUGE_COMMUNICATION] = false;
#endif

    // Select the first fault as the reason
    app_control_fault_E fault = APP_CONTROL_FAULT_NONE;
    for (app_control_fault_E index = (app_control_fault_E)0U; index < APP_CONTROL_FAULT_COUNT; index++)
    {
        if (app_control_data.fault[index])
        {
            fault = index;
            break;
        }
    }

    return fault;
}

static app_control_restriction_E app_control_private_processRestrictions(void)
{
    if (app_control_data.testRunning)
    {
        /*// Check sample profile limits during test execution
        int32_t currentForce = app_gauge_getForce(APP_GAUGE_COORD_SAMPLE);
        int32_t currentPosition = app_gauge_getPosition(APP_GAUGE_COORD_SAMPLE);

        // Convert current force from mN to N for comparison
        float currentForceN = currentForce / 1000.0f;

        // Check force limits
        if (currentForceN > app_control_data.sampleProfile.maxForce)
        {
            app_control_data.restriction[APP_CONTROL_RESTRICTION_SAMPLE_TENSION] = true;
        }
        else if (currentForceN < -app_control_data.sampleProfile.maxForce)
        {
            app_control_data.restriction[APP_CONTROL_RESTRICTION_SAMPLE_TENSION] = true;
        }
        else
        {
            app_control_data.restriction[APP_CONTROL_RESTRICTION_SAMPLE_TENSION] = false;
        }

        // Check position limits (convert from um to mm)
        float currentPositionMm = currentPosition / 1000.0f;
        float maxStretch = app_control_data.sampleProfile.length * (app_control_data.sampleProfile.stretchMax / 100.0f);

        if (currentPositionMm > maxStretch)
        {
            app_control_data.restriction[APP_CONTROL_RESTRICTION_SAMPLE_LENGTH] = true;
        }
        else
        {
            app_control_data.restriction[APP_CONTROL_RESTRICTION_SAMPLE_LENGTH] = false;
        }*/
    }
    else
    {
        // Do not check sample conditions unless test is running
        app_control_data.restriction[APP_CONTROL_RESTRICTION_SAMPLE_LENGTH] = false;
        app_control_data.restriction[APP_CONTROL_RESTRICTION_SAMPLE_TENSION] = false;
    }

    app_control_data.restriction[APP_CONTROL_RESTRICTION_MACHINE_TENSION] =
        (app_gauge_getForce(APP_GAUGE_COORD_MACHINE) > app_control_data.nvram.maxMachineTension);
    app_control_data.restriction[APP_CONTROL_RESTRICTION_UPPER_ENDSTOP] = HAL_GPIO_getActive(HAL_GPIO_ENDSTOP_UPPER);
    app_control_data.restriction[APP_CONTROL_RESTRICTION_LOWER_ENDSTOP] = HAL_GPIO_getActive(HAL_GPIO_ENDSTOP_LOWER);
    app_control_data.restriction[APP_CONTROL_RESTRICTION_DOOR] = HAL_GPIO_getActive(HAL_GPIO_ENDSTOP_DOOR);

#if APP_CONTROL_BENCH_TEST_BYPASS
    /* Disconnected force gauge reads garbage and the endstop/door GPIOs float;
     * clear these so the machine stays in MANUAL/TEST instead of RESTRICTED. */
    app_control_data.restriction[APP_CONTROL_RESTRICTION_MACHINE_TENSION] = false;
    app_control_data.restriction[APP_CONTROL_RESTRICTION_UPPER_ENDSTOP] = false;
    app_control_data.restriction[APP_CONTROL_RESTRICTION_LOWER_ENDSTOP] = false;
    app_control_data.restriction[APP_CONTROL_RESTRICTION_DOOR] = false;
#endif

    // Select the first condition as the reason
    app_control_restriction_E condition = APP_CONTROL_RESTRICTION_NONE;
    for (app_control_restriction_E index = (app_control_restriction_E)0U; index < APP_CONTROL_RESTRICTION_COUNT; index++)
    {
        if (app_control_data.restriction[index])
        {
            condition = index;
            break;
        }
    }

    return condition;
}

static app_control_state_E app_control_private_getDesiredState(void)
{
    app_control_state_E desiredState;
    if (app_control_data.faultedReason != APP_CONTROL_FAULT_NONE)
    {
        desiredState = APP_CONTROL_STATE_DISABLED;
    }
    else if (app_control_data.motionEnabled == false)
    {
        desiredState = APP_CONTROL_STATE_DISABLED;
    }
    else if (app_control_data.restrictedReason != APP_CONTROL_RESTRICTION_NONE)
    {
        desiredState = APP_CONTROL_STATE_RESTRICTED;
    }
    else if (app_control_data.testRunning == false)
    {
        desiredState = APP_CONTROL_STATE_MANUAL;
    }
    else
    {
        desiredState = APP_CONTROL_STATE_TEST;
    }
    return desiredState;
}

static void app_control_private_setOutput(void)
{
    APP_CONTROL_LOCK_REQ_BLOCK();
    switch (app_control_data.state)
    {
    case APP_CONTROL_STATE_DISABLED:
        app_control_data.out.motionEnabled = false;
        app_control_data.out.limitSpeed = false;
        break;
    case APP_CONTROL_STATE_RESTRICTED:
        app_control_data.out.motionEnabled = true;
        app_control_data.out.limitSpeed = true;
        break;
    case APP_CONTROL_STATE_MANUAL:
        app_control_data.out.motionEnabled = true;
        app_control_data.out.limitSpeed = false;
        break;
    case APP_CONTROL_STATE_TEST:
        app_control_data.out.motionEnabled = true;
        app_control_data.out.limitSpeed = false;
        break;
    case APP_CONTROL_STATE_COUNT:
    default:
        break;
    }
    APP_CONTROL_LOCK_REL();
}
/**********************************************************************
 * Public Function Definitions
 **********************************************************************/

void app_control_init(int lock)
{
    app_control_data.lock = lock;
    app_control_data.state = APP_CONTROL_STATE_DISABLED;
    MachineProfile machineProfile;
    (void)dev_nvram_getChannelData(DEV_NVRAM_CHANNEL_MACHINE_PROFILE, &machineProfile, sizeof(MachineProfile));
    app_control_data.nvram.maxMachineTension = machineProfile.maxForceTensile;
}

void app_control_run(void)
{
    app_control_private_processRequests();
    app_control_data.testRunning = app_testManagement_isRunning();
    app_control_data.faultedReason = app_control_private_processFaults();
    app_control_data.restrictedReason = app_control_private_processRestrictions();
    app_control_data.state = app_control_private_getDesiredState();
    app_control_private_setOutput();
}

bool app_control_motionEnabled(void)
{
    APP_CONTROL_LOCK_REQ_BLOCK();
    const bool motionEnabled = app_control_data.out.motionEnabled;
    APP_CONTROL_LOCK_REL();
    return motionEnabled;
}

// Logging only
app_control_fault_E app_control_getFault(void)
{
    // This is not thread safe, might be fine cause setting is atomic
    APP_CONTROL_LOCK_REQ_BLOCK();
    const app_control_fault_E fault = app_control_data.faultedReason;
    APP_CONTROL_LOCK_REL();
    return fault;
}

app_control_restriction_E app_control_getRestriction(void)
{
    // This is not thread safe, might be fine cause setting is atomic
    APP_CONTROL_LOCK_REQ_BLOCK();
    const app_control_restriction_E condition = app_control_data.restrictedReason;
    APP_CONTROL_LOCK_REL();
    return condition;
}

// End of logging

bool app_control_speedLimited(void)
{
    APP_CONTROL_LOCK_REQ_BLOCK();
    const bool limitSpeed = app_control_data.out.limitSpeed;
    APP_CONTROL_LOCK_REL();
    return limitSpeed;
}

bool app_control_triggerMotionEnabled(void)
{
    bool motionReady = false;
    APP_CONTROL_LOCK_REQ_BLOCK();
    if (app_control_data.faultedReason == APP_CONTROL_FAULT_NONE)
    {
        app_control_data.request.triggerMotionEnabled = true;
        motionReady = true;
    }
    APP_CONTROL_LOCK_REL();
    return motionReady;
}

bool app_control_triggerMotionDisabled(void)
{
    APP_CONTROL_LOCK_REQ_BLOCK();
    app_control_data.request.triggerMotionDisabled = true;
    APP_CONTROL_LOCK_REL();
    return true;
}

/**********************************************************************
 * End of File
 **********************************************************************/
