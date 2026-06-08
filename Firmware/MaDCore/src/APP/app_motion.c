//
// Created by Riley McCarthy on 25/04/24.
//
/**********************************************************************
 * Includes
 **********************************************************************/
#include <string.h>
#include <stdlib.h>
#include "HAL_lock.h"
#include <math.h>

#include "app_motion.h"
#include "app_control.h"

#include "dev_stepper.h"
#include "dev_nvram.h"

#include "HAL_GPIO.h"

#include "lib_staticQueue.h"
#include "lib_timer.h"
#include "lib_utility.h"

#include "IO_Debug.h"
#include "IO_positionFeedback.h"
#include "emulation_helpers.h"
#include "watchdog.h"
/**********************************************************************
 * Constants
 **********************************************************************/

/*********************************************************************
 * Macros
 **********************************************************************/
#define MOTION_QUEUE_SIZE 100

#define APP_MOTION_LOCK_REQ() HAL_lock_try(app_motion_data.lock)
#define APP_MOTION_LOCK_REQ_BLOCK()        \
    while (APP_MOTION_LOCK_REQ() == false) \
    {                                      \
        EMULATION_YIELD_LOCK();            \
    }
#define APP_MOTION_LOCK_REL() HAL_lock_release(app_motion_data.lock)
/**********************************************************************
 * Typedefs
 **********************************************************************/

/* All external state read by this module must be cached here by
 * app_motion_private_processInputs() so the rest of the tick operates on a
 * single consistent snapshot. Do not call external getters from helpers,
 * state-machine handlers, or processOutputs. */
typedef struct
{
    bool motionEnabled;
    bool limitSpeed;
    int32_t positionSteps;
    bool atTarget;
    int32_t gaugeSetpointSteps;     /* dev_stepper_getTarget(MAIN)            */
    bool endstopUpperActive;        /* HAL_GPIO_getActive(ENDSTOP_UPPER)      */
} app_motion_dataInputs_t;

typedef struct
{
    int32_t setpoint; // um
    int32_t position; // um
} app_motion_outputs_t;

typedef struct
{
    app_motion_dataInputs_t inputs;
    lib_staticQueue_S queue;

    bool absoluteMode;
    lib_timer_S dwellTimer;
    lib_timer_S endstopTimer;
    int32_t stepsPerMM;
    int32_t maxPosition;
    int32_t homingVelocity;
    int32_t homingOffset;
    int32_t jawOffset;
    app_motion_move_t currentMove;
    app_motion_state_E state;
    int lock;
    app_motion_home_E homeState;

    app_motion_outputs_t output;

    app_motion_move_t queueBuffer[MOTION_QUEUE_SIZE];
} app_motion_data_t;
/**********************************************************************
 * Variable Definitions
 **********************************************************************/
static app_motion_data_t app_motion_data;
/**********************************************************************
 * Private Function Prototypes
 **********************************************************************/

static void app_motion_private_processInputs(void);
static void app_motion_private_processOutputs(void);
static app_motion_state_E app_motion_private_getDesiredState(void);
static void app_motion_private_moveManager_start(void);
static bool app_motion_private_moveManager_run(void);

/**********************************************************************
 * Private Functions
 **********************************************************************/

static void app_motion_private_processInputs(void)
{
    app_motion_data.inputs.motionEnabled = app_control_motionEnabled();
    app_motion_data.inputs.limitSpeed = app_control_speedLimited();
    app_motion_data.inputs.positionSteps = dev_stepper_getSteps(DEV_STEPPER_CHANNEL_MAIN);
    app_motion_data.inputs.atTarget = dev_stepper_atTarget(DEV_STEPPER_CHANNEL_MAIN);
    app_motion_data.inputs.gaugeSetpointSteps = dev_stepper_getTarget(DEV_STEPPER_CHANNEL_MAIN);
    app_motion_data.inputs.endstopUpperActive = HAL_GPIO_getActive(HAL_GPIO_ENDSTOP_UPPER);
}

static void app_motion_private_processOutputs(void)
{
    int32_t setpoint = 0;
    if (app_motion_data.stepsPerMM != 0)
    {
        setpoint = (int32_t)(((int64_t)app_motion_data.inputs.gaugeSetpointSteps * 1000LL) / app_motion_data.stepsPerMM);
    }
    APP_MOTION_LOCK_REQ_BLOCK();
    app_motion_data.output.setpoint = setpoint;
    APP_MOTION_LOCK_REL();
}

static app_motion_state_E app_motion_private_getDesiredState(void)
{
    app_motion_state_E desiredState = app_motion_data.state;
    if (app_motion_data.inputs.motionEnabled == false)
    {
        lib_staticQueue_empty(&app_motion_data.queue);
        dev_stepper_stop(DEV_STEPPER_CHANNEL_MAIN);
        dev_stepper_enable(DEV_STEPPER_CHANNEL_MAIN, false);
        desiredState = APP_MOTION_DISABLED;
    }
    else
    {
        switch (app_motion_data.state)
        {
        case APP_MOTION_DISABLED:
            dev_stepper_enable(DEV_STEPPER_CHANNEL_MAIN, true);
            desiredState = APP_MOTION_WAITING;
            break;
        case APP_MOTION_WAITING:
            if (lib_staticQueue_pop(&app_motion_data.queue, &app_motion_data.currentMove))
            {
                app_motion_private_moveManager_start();
                desiredState = APP_MOTION_MOVING;
            }
            break;
        case APP_MOTION_MOVING:
            if (app_motion_private_moveManager_run())
            {
                desiredState = APP_MOTION_WAITING;
            }
            break;
        case APP_MOTION_COUNT:
        default:
            break;
        }
    }
    return desiredState;
}

static bool app_motion_private_homing_run(void)
{
    bool complete = false;
    switch (app_motion_data.homeState)
    {
    case APP_MOTION_HOME_START:
        DEBUG_INFO("%s", "Homing Moving\n");
        dev_stepper_move(DEV_STEPPER_CHANNEL_MAIN, app_motion_data.inputs.positionSteps - app_motion_data.stepsPerMM * app_motion_data.maxPosition, app_motion_data.homingVelocity * app_motion_data.stepsPerMM);
        app_motion_data.homeState = APP_MOTION_HOME_MOVING;
        break;
    case APP_MOTION_HOME_MOVING:
        if (app_motion_data.inputs.endstopUpperActive)
        {
            DEBUG_INFO("%s", "Homing Endstop\n");
            lib_timer_start(&app_motion_data.endstopTimer);
            dev_stepper_stop(DEV_STEPPER_CHANNEL_MAIN);
            app_motion_data.homeState = APP_MOTION_HOME_ENDSTOP;
        }
        else if (app_motion_data.inputs.atTarget)
        {
            DEBUG_INFO("%s", "Homing Failed\n");
            app_motion_data.homeState = APP_MOTION_HOME_COMPLETE;
        }
        break;
    case APP_MOTION_HOME_ENDSTOP:
        if (lib_timer_expired(&app_motion_data.endstopTimer))
        {
            DEBUG_INFO("%s", "Homing Backoff\n");
            // Set both encoder and stepper positions to jaw offset to establish coordinate system.
            // Important: set encoder synchronously before starting backoff move so pulse-out
            // snapshots the correct base position.
            const int32_t jawOffsetSteps = app_motion_data.stepsPerMM * app_motion_data.jawOffset;
            const int32_t homingOffsetSteps = app_motion_data.stepsPerMM * app_motion_data.homingOffset;
            (void)IO_positionFeedback_setValue(
                IO_POSITION_FEEDBACK_CHANNEL_SERVO_FEEDBACK,
                LIB_UTILITY_MM_TO_UM(app_motion_data.jawOffset));
            dev_stepper_setPosition(DEV_STEPPER_CHANNEL_MAIN, jawOffsetSteps);
            dev_stepper_move(DEV_STEPPER_CHANNEL_MAIN, jawOffsetSteps + homingOffsetSteps, (app_motion_data.homingVelocity * app_motion_data.stepsPerMM));
            app_motion_data.homeState = APP_MOTION_HOME_BACKOFF;
        }
        break;
    case APP_MOTION_HOME_BACKOFF:
        if (app_motion_data.inputs.atTarget)
        {
            DEBUG_INFO("%s", "Homing complete\n");
            app_motion_data.homeState = APP_MOTION_HOME_COMPLETE;
        }
        break;
    case APP_MOTION_HOME_COMPLETE:
        complete = true;
        app_motion_data.homeState = APP_MOTION_HOME_START;
        break;
    case APP_MOTION_HOME_COUNT:
    default:
        break;
    }
    return complete;
}

static void app_motion_private_moveManager_start(void)
{
    DEBUG_INFO("Processing move: %d\n", app_motion_data.currentMove.g);
    switch (app_motion_data.currentMove.g)
    {
    case G0_RAPID_MOVE:
    case G1_LINEAR_MOVE:
        if (app_motion_data.currentMove.f == 0U)
        {
            DEBUG_WARNING("G0/G1 Command has zero feedrate: %d\n", app_motion_data.currentMove.f);
        }
        else
        {
            /* move.x on SD is machine µm (host converts sample G-code at upload). */
            const int32_t moveTargetUm = app_motion_data.currentMove.x;
            int32_t steps = (int32_t)(((int64_t)moveTargetUm * app_motion_data.stepsPerMM) / 1000LL);
            const int32_t feedrate = (int32_t)(((int64_t)app_motion_data.currentMove.f * app_motion_data.stepsPerMM) / 1000LL);
            if (app_motion_data.absoluteMode == false)
            {
                steps += app_motion_data.inputs.positionSteps;
            }
            DEBUG_INFO("G0 command moving to steps %d at %d steps/s\n", steps, feedrate);
            DEBUG_INFO("moving from position (mm) %d to setpoint (mm) %d\n", app_motion_data.inputs.positionSteps / app_motion_data.stepsPerMM, steps / app_motion_data.stepsPerMM);
            dev_stepper_move(DEV_STEPPER_CHANNEL_MAIN, steps, feedrate);
        }
        break;
    case G2_CW_ARC_MOVE:
    case G3_CCW_ARC_MOVE:
    case G4_DWELL:
        DEBUG_INFO("G4 command pausing for %u ms", app_motion_data.currentMove.p);
        lib_timer_init(&app_motion_data.dwellTimer, app_motion_data.currentMove.p);
        lib_timer_start(&app_motion_data.dwellTimer);
        break;
    case G28_HOME:
        DEBUG_INFO("%s", "Homing\n");
        app_motion_data.homeState = APP_MOTION_HOME_START;
        break;
    case G90_ABSOLUTE:
        DEBUG_INFO("%s", "Setting absolute mode\n");
        app_motion_data.absoluteMode = true;
        break;
    case G91_INCREMENTAL:
        DEBUG_INFO("%s", "Setting incremental mode\n");
        app_motion_data.absoluteMode = false;
        break;
    case G122_STOP:
        /* Test lifecycle owns G122. app_testManagement intercepts it before
         * pushing to motion; this case is defensive and treats it as a no-op. */
        break;
    default:
        break;
    }
}

static bool app_motion_private_moveManager_run(void)
{
    bool moveComplete = false;
    switch (app_motion_data.currentMove.g)
    {
    case G0_RAPID_MOVE:
    case G1_LINEAR_MOVE:
        moveComplete = app_motion_data.inputs.atTarget;
        break;
    case G2_CW_ARC_MOVE:
    case G3_CCW_ARC_MOVE:
    case G4_DWELL:
        moveComplete = lib_timer_expired(&app_motion_data.dwellTimer);
        break;
    case G28_HOME:
        moveComplete = app_motion_private_homing_run();
        break;
    case G90_ABSOLUTE:
    case G91_INCREMENTAL:
    case G122_STOP:
        moveComplete = true;
        break;
    default:
        break;
    }
    return moveComplete;
}

/**********************************************************************
 * Function Definitions
 **********************************************************************/

void app_motion_init(int lock)
{
    app_motion_data.lock = lock;
    app_motion_data.absoluteMode = true; // Default absolute cordinates
    MachineProfile machineProfile;
    dev_nvram_getChannelData(DEV_NVRAM_CHANNEL_MACHINE_PROFILE, &machineProfile, sizeof(MachineProfile));
    app_motion_data.stepsPerMM = machineProfile.servoStepsPerMM;
    app_motion_data.maxPosition = machineProfile.maxPosition;
    app_motion_data.homingVelocity = machineProfile.homingVelocity;
    app_motion_data.homingOffset = machineProfile.homingOffset;
    app_motion_data.jawOffset = machineProfile.jawOffset;
    (void)lib_staticQueue_init(&app_motion_data.queue, app_motion_data.queueBuffer, MOTION_QUEUE_SIZE, sizeof(app_motion_move_t), lock);
    lib_timer_init(&app_motion_data.endstopTimer, 1000);
}

void app_motion_run(void)
{
    app_motion_private_processInputs();
    app_motion_data.state = app_motion_private_getDesiredState();
    app_motion_private_processOutputs();
}

bool app_motion_addMove(const app_motion_move_t *move)
{
    return lib_staticQueue_push(&app_motion_data.queue, (void *)move);
}

void app_motion_abortAndClear(void)
{
    dev_stepper_stop(DEV_STEPPER_CHANNEL_MAIN);
    lib_staticQueue_empty(&app_motion_data.queue);
    if (app_motion_data.state == APP_MOTION_MOVING)
    {
        app_motion_data.state = APP_MOTION_WAITING;
    }
}

int32_t app_motion_getSetpoint(void)
{
    APP_MOTION_LOCK_REQ_BLOCK();
    int32_t setpoint = app_motion_data.output.setpoint;
    APP_MOTION_LOCK_REL();
    return setpoint;
}

int32_t app_motion_getPosition(void)
{
    int32_t position = 0;
    APP_MOTION_LOCK_REQ_BLOCK();
    if (app_motion_data.stepsPerMM != 0)
    {
        position = (int32_t)(((int64_t)app_motion_data.inputs.positionSteps * 1000LL) / app_motion_data.stepsPerMM);
    }
    APP_MOTION_LOCK_REL();
    return position;
}
