//
// Created by Riley McCarthy on 18/10/26.
//
/**********************************************************************
 * Includes
 **********************************************************************/
#include <string.h>
#include "HAL_lock.h"

#include "app_motorCalibration.h"
#include "app_control.h"
#include "app_motion.h"
#include "app_testManagement.h"

#include "dev_servo.h"

#include "HAL_GPIO.h"

#include "lib_timer.h"

#include "IO_Debug.h"
/**********************************************************************
 * Constants
 **********************************************************************/
#define APP_MOTORCALIBRATION_CH DEV_SERVO_CHANNEL_MAIN
/* A leg may take twice its nominal time, plus this, before it is abandoned. */
#define APP_MOTORCALIBRATION_TIMEOUT_MARGIN_MS 1000U
/*********************************************************************
 * Macros
 **********************************************************************/
#define APP_MOTORCALIBRATION_LOCK_REQ_BLOCK()                       \
    while (HAL_lock_try(app_motorCalibration_data.lock) == false) \
    {                                                             \
    }
#define APP_MOTORCALIBRATION_LOCK_REL() (void)HAL_lock_release(app_motorCalibration_data.lock)
/**********************************************************************
 * Typedefs
 **********************************************************************/
/* Every external read this tick, taken once up front so the sequencer works
 * on one consistent snapshot (the app_motion convention). */
typedef struct
{
    bool motionEnabled;
    bool faulted;
    bool atEndstop;
    bool busy;
    int32_t position;
    bool legDone;
    uint32_t legEmitted;
} app_motorCalibration_inputs_S;

typedef struct
{
    int lock;
    /* Shared with other cogs: guarded by the lock. */
    app_motorCalibration_request_S request;
    app_motorCalibration_result_S result;

    /* CONTROL cog only. */
    app_motorCalibration_inputs_S inputs;
    bool settling;      /* the leg's pulses are out; waiting for the carriage to rest */
    int32_t legStart;   /* encoder at the start of the current leg */
    lib_timer_S legTimer;
    lib_timer_S settleTimer;
} app_motorCalibration_data_S;
/**********************************************************************
 * Private Variable Definitions
 **********************************************************************/
static app_motorCalibration_data_S app_motorCalibration_data;
/**********************************************************************
 * Private Function Prototypes
 **********************************************************************/
static void app_motorCalibration_private_processInputs(void);
static bool app_motorCalibration_private_stateIsActive(app_motorCalibration_state_E state);
static void app_motorCalibration_private_startLeg(int32_t signedPulses, uint32_t frequency);
static app_motorCalibration_state_E app_motorCalibration_private_checkAbort(uint32_t maxCounts);
/**********************************************************************
 * Private Function Definitions
 **********************************************************************/
static bool app_motorCalibration_private_stateIsActive(app_motorCalibration_state_E state)
{
    return (state == APP_MOTORCALIBRATION_STATE_STARTING) || (state == APP_MOTORCALIBRATION_STATE_FORWARD) ||
           (state == APP_MOTORCALIBRATION_STATE_REVERSE);
}

static void app_motorCalibration_private_processInputs(void)
{
    app_motorCalibration_inputs_S *const in = &app_motorCalibration_data.inputs;
    in->motionEnabled = app_control_motionEnabled();
    in->faulted = (app_control_getFault() != APP_CONTROL_FAULT_NONE);
    /* The switches themselves, not app_control's restriction: that reports one
     * reason at a time, and a door or tension restriction would hide an end
     * stop behind it. */
    in->atEndstop = HAL_GPIO_getActive(HAL_GPIO_ENDSTOP_UPPER) || HAL_GPIO_getActive(HAL_GPIO_ENDSTOP_LOWER);
    in->busy = (app_motion_isIdle() == false) || app_testManagement_isRunning();
    in->position = dev_servo_getPosition(APP_MOTORCALIBRATION_CH);
    in->legDone = dev_servo_openLoopDone(APP_MOTORCALIBRATION_CH, &in->legEmitted);
}

static void app_motorCalibration_private_startLeg(int32_t signedPulses, uint32_t frequency)
{
    app_motorCalibration_data.legStart = app_motorCalibration_data.inputs.position;
    app_motorCalibration_data.settling = false;
    /* Twice the nominal duration plus a margin. The request caps pulses at
     * APP_MOTORCALIBRATION_MAX_PULSES, so pulses x 1000 fits in 32 bits. */
    const uint32_t pulses = (uint32_t)((signedPulses < 0) ? -signedPulses : signedPulses);
    const uint32_t nominalMs = (pulses * 1000U) / frequency;
    lib_timer_init(&app_motorCalibration_data.legTimer, (2U * nominalMs) + APP_MOTORCALIBRATION_TIMEOUT_MARGIN_MS);
    lib_timer_start(&app_motorCalibration_data.legTimer);
    (void)dev_servo_startOpenLoop(APP_MOTORCALIBRATION_CH, signedPulses, frequency);
}

/* The reason to abandon the running leg, or the IDLE sentinel to carry on. */
static app_motorCalibration_state_E app_motorCalibration_private_checkAbort(uint32_t maxCounts)
{
    const app_motorCalibration_inputs_S *const in = &app_motorCalibration_data.inputs;
    const int32_t moved = in->position - app_motorCalibration_data.legStart;
    const uint32_t movedAbs = (uint32_t)((moved < 0) ? -moved : moved);
    app_motorCalibration_state_E abort = APP_MOTORCALIBRATION_STATE_IDLE;
    if (in->motionEnabled == false)
    {
        abort = APP_MOTORCALIBRATION_STATE_ABORTED_MOTION_DISABLED;
    }
    else if (in->faulted)
    {
        abort = APP_MOTORCALIBRATION_STATE_ABORTED_FAULT;
    }
    else if (in->atEndstop)
    {
        abort = APP_MOTORCALIBRATION_STATE_ABORTED_ENDSTOP;
    }
    else if (movedAbs > maxCounts)
    {
        abort = APP_MOTORCALIBRATION_STATE_ABORTED_OVERTRAVEL;
    }
    else if (lib_timer_expired(&app_motorCalibration_data.legTimer))
    {
        abort = APP_MOTORCALIBRATION_STATE_ABORTED_TIMEOUT;
    }
    else
    {
        /* carry on */
    }
    return abort;
}
/**********************************************************************
 * Public Function Definitions
 **********************************************************************/
void app_motorCalibration_init(int lock)
{
    (void)memset(&app_motorCalibration_data, 0, sizeof(app_motorCalibration_data));
    app_motorCalibration_data.lock = lock;
    app_motorCalibration_data.result.state = APP_MOTORCALIBRATION_STATE_IDLE;
    lib_timer_init(&app_motorCalibration_data.legTimer, 0U);
    lib_timer_init(&app_motorCalibration_data.settleTimer, APP_MOTORCALIBRATION_SETTLE_MS);
}

/* Runs on the CONTROL cog AFTER app_motion_run. That order is what makes the
 * busy check sound: a jog staged before the request was accepted has been
 * queued and popped by app_motion this same tick, so app_motion is no longer
 * idle and the run is refused. Anything staged after it is refused at the
 * door by app_motorCalibration_isActive(). */
void app_motorCalibration_run(void)
{
    APP_MOTORCALIBRATION_LOCK_REQ_BLOCK();
    const app_motorCalibration_state_E state = app_motorCalibration_data.result.state;
    /* Scalars, not a struct copy: FlexC rejects a cast of a member of a
     * struct-typed local ("bad cast"). */
    const int32_t reqPulses = (int32_t)app_motorCalibration_data.request.pulses;
    const uint32_t reqFrequency = app_motorCalibration_data.request.frequency;
    const uint32_t reqMaxCounts = app_motorCalibration_data.request.maxCounts;
    APP_MOTORCALIBRATION_LOCK_REL();

    if (app_motorCalibration_private_stateIsActive(state) == false)
    {
        return;
    }

    app_motorCalibration_private_processInputs();
    const app_motorCalibration_inputs_S *const in = &app_motorCalibration_data.inputs;

    app_motorCalibration_state_E next = state;
    bool legFinished = false;
    int32_t legPulses = 0;
    int32_t legCounts = 0;

    if (state == APP_MOTORCALIBRATION_STATE_STARTING)
    {
        if ((in->motionEnabled == false) || in->faulted)
        {
            next = APP_MOTORCALIBRATION_STATE_REFUSED_MOTION_DISABLED;
        }
        else if (in->busy)
        {
            next = APP_MOTORCALIBRATION_STATE_REFUSED_BUSY;
        }
        else if (in->atEndstop)
        {
            next = APP_MOTORCALIBRATION_STATE_REFUSED_AT_ENDSTOP;
        }
        else
        {
            app_motorCalibration_private_startLeg(reqPulses, reqFrequency);
            next = APP_MOTORCALIBRATION_STATE_FORWARD;
        }
    }
    else
    {
        const app_motorCalibration_state_E abort = app_motorCalibration_private_checkAbort(reqMaxCounts);
        if (abort != APP_MOTORCALIBRATION_STATE_IDLE)
        {
            DEBUG_WARNING("MOTOR CAL: abandoned (%d) at %d counts\n", (int)abort,
                          (int)(in->position - app_motorCalibration_data.legStart));
            next = abort;
        }
        else if (app_motorCalibration_data.settling == false)
        {
            if (in->legDone)
            {
                app_motorCalibration_data.settling = true;
                lib_timer_start(&app_motorCalibration_data.settleTimer);
            }
        }
        else if (lib_timer_expired(&app_motorCalibration_data.settleTimer))
        {
            legFinished = true;
            legPulses = (int32_t)in->legEmitted;
            legCounts = in->position - app_motorCalibration_data.legStart;
            if (state == APP_MOTORCALIBRATION_STATE_FORWARD)
            {
                app_motorCalibration_private_startLeg(-reqPulses, reqFrequency);
                next = APP_MOTORCALIBRATION_STATE_REVERSE;
            }
            else
            {
                legPulses = -legPulses;
                next = APP_MOTORCALIBRATION_STATE_DONE;
            }
        }
        else
        {
            /* settling */
        }
    }

    if ((app_motorCalibration_private_stateIsActive(next) == false) &&
        (next != APP_MOTORCALIBRATION_STATE_REFUSED_MOTION_DISABLED) &&
        (next != APP_MOTORCALIBRATION_STATE_REFUSED_BUSY) &&
        (next != APP_MOTORCALIBRATION_STATE_REFUSED_AT_ENDSTOP))
    {
        /* Back to a closed-loop hold where the carriage now is. dev_servo kept
         * its setpoint on the encoder throughout, so this does not jump. A
         * disabled machine is already stopped by app_motion; stopping again
         * changes nothing. */
        dev_servo_stop(APP_MOTORCALIBRATION_CH);
    }

    APP_MOTORCALIBRATION_LOCK_REQ_BLOCK();
    if (legFinished)
    {
        if (state == APP_MOTORCALIBRATION_STATE_FORWARD)
        {
            app_motorCalibration_data.result.pulsesForward = legPulses;
            app_motorCalibration_data.result.countsForward = legCounts;
        }
        else
        {
            app_motorCalibration_data.result.pulsesReverse = legPulses;
            app_motorCalibration_data.result.countsReverse = legCounts;
        }
    }
    app_motorCalibration_data.result.state = next;
    APP_MOTORCALIBRATION_LOCK_REL();
}

bool app_motorCalibration_request(const app_motorCalibration_request_S *request)
{
    if ((request == NULL) || (request->pulses == 0U) || (request->pulses > APP_MOTORCALIBRATION_MAX_PULSES) ||
        (request->frequency == 0U) || (request->frequency > APP_MOTORCALIBRATION_MAX_FREQUENCY) ||
        (request->maxCounts == 0U))
    {
        return false;
    }
    bool accepted = false;
    APP_MOTORCALIBRATION_LOCK_REQ_BLOCK();
    if (app_motorCalibration_private_stateIsActive(app_motorCalibration_data.result.state) == false)
    {
        app_motorCalibration_data.request = *request;
        (void)memset(&app_motorCalibration_data.result, 0, sizeof(app_motorCalibration_data.result));
        app_motorCalibration_data.result.state = APP_MOTORCALIBRATION_STATE_STARTING;
        accepted = true;
    }
    APP_MOTORCALIBRATION_LOCK_REL();
    return accepted;
}

bool app_motorCalibration_isActive(void)
{
    APP_MOTORCALIBRATION_LOCK_REQ_BLOCK();
    const bool active = app_motorCalibration_private_stateIsActive(app_motorCalibration_data.result.state);
    APP_MOTORCALIBRATION_LOCK_REL();
    return active;
}

void app_motorCalibration_getResult(app_motorCalibration_result_S *result)
{
    if (result == NULL)
    {
        return;
    }
    APP_MOTORCALIBRATION_LOCK_REQ_BLOCK();
    *result = app_motorCalibration_data.result;
    APP_MOTORCALIBRATION_LOCK_REL();
}
/**********************************************************************
 * End of File
 **********************************************************************/
