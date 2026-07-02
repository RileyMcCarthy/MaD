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

#if APP_MOTION_USE_SERVO
#include "dev_servo.h"
#else
#include "dev_stepper.h"
#endif
#include "dev_nvram.h"

#include "HAL_GPIO.h"
#include "HAL_time.h"

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

/* Actuator abstraction: app_motion speaks these; the build (APP_MOTION_USE_SERVO)
 * picks the driver. dev_servo closes the loop on the encoder, so getPosition is
 * the encoder truth and move() honours a feedrate; dev_stepper is open-loop, so
 * getPosition is the commanded step count. Both speak the same counts (servo and
 * encoder are 8192 steps/mm) and the same target/feedrate semantics. */
#if APP_MOTION_USE_SERVO
#define ACTUATOR_CH DEV_SERVO_CHANNEL_MAIN
#define actuator_enable(en) dev_servo_enable(ACTUATOR_CH, (en))
#define actuator_move(target, feedrate) dev_servo_moveTo(ACTUATOR_CH, (target), (feedrate))
#define actuator_setVelocity(v) dev_servo_setVelocity(ACTUATOR_CH, (v))
#define actuator_stop() dev_servo_stop(ACTUATOR_CH)
#define actuator_setPosition(p) dev_servo_setPosition(ACTUATOR_CH, (p))
#define actuator_getPosition() dev_servo_getPosition(ACTUATOR_CH)
#define actuator_getTarget() dev_servo_getTarget(ACTUATOR_CH)
#define actuator_atTarget() dev_servo_atTarget(ACTUATOR_CH)
#else
#define ACTUATOR_CH DEV_STEPPER_CHANNEL_MAIN
#define actuator_enable(en) dev_stepper_enable(ACTUATOR_CH, (en))
#define actuator_move(target, feedrate) (void)dev_stepper_move(ACTUATOR_CH, (target), (feedrate))
#define actuator_setVelocity(v) dev_stepper_setVelocity(ACTUATOR_CH, (v))
#define actuator_stop() dev_stepper_stop(ACTUATOR_CH)
#define actuator_setPosition(p) dev_stepper_setPosition(ACTUATOR_CH, (p))
#define actuator_getPosition() dev_stepper_getSteps(ACTUATOR_CH)
#define actuator_getTarget() dev_stepper_getTarget(ACTUATOR_CH)
#define actuator_atTarget() dev_stepper_atTarget(ACTUATOR_CH)
#endif

/* Waveform (G123): the firmware generates the f(t) trajectory itself (no host G1
 * expansion). It streams the analytic instantaneous velocity each motion tick to
 * the stepper's continuous-velocity (NCO) output, so the pulse rate follows the
 * waveform smoothly rather than as discrete stop/start segments. */
#define APP_MOTION_TWO_PI 6.283185307179586f
/* The waveform is "settled" (and the move complete) once it is within this many
 * steps of the centre. Exact-equality completion could hang if the servo's
 * reported position never lands exactly on centre (quantisation / settling). */
#define APP_MOTION_WAVEFORM_SETTLE_STEPS 2
/* Defensive clamp on the commanded step rate (steps/s). The host validates peak
 * velocity, but extreme/unvalidated params (high freq × high amplitude × a fine
 * steps/mm) could otherwise overflow the int32/uint32 rate. 30 Msteps/s sits
 * well above any real stepper rate yet far below the 2^31 overflow point. */
#define APP_MOTION_WAVEFORM_MAX_STEPS_PER_S 30000000.0f

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
    int32_t gaugeSetpointSteps;     /* actuator_getTarget() — commanded target */
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

    /* Waveform (G123) playback state. */
    int32_t waveformCentreSteps;     /* position the wave oscillates about      */
    int32_t waveformAmplitudeSteps;  /* peak excursion in steps                 */
    uint32_t waveformFreqMilliHz;    /* frequency in milli-Hz                   */
    uint64_t waveformDurationUs;     /* cycles / frequency, in microseconds     */
    uint64_t waveformElapsedUs;      /* wrap-safe elapsed time since start      */
    uint32_t waveformLastUs;         /* last HAL_time_getUs() reading           */

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
static bool app_motion_private_waveform_run(void);

/**********************************************************************
 * Private Functions
 **********************************************************************/

static void app_motion_private_processInputs(void)
{
    app_motion_data.inputs.motionEnabled = app_control_motionEnabled();
    app_motion_data.inputs.limitSpeed = app_control_speedLimited();
    app_motion_data.inputs.positionSteps = actuator_getPosition();
    app_motion_data.inputs.atTarget = actuator_atTarget();
    app_motion_data.inputs.gaugeSetpointSteps = actuator_getTarget();
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
        actuator_stop();
        actuator_enable(false);
        desiredState = APP_MOTION_DISABLED;
    }
    else
    {
        switch (app_motion_data.state)
        {
        case APP_MOTION_DISABLED:
            actuator_enable(true);
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
        actuator_move(app_motion_data.inputs.positionSteps - app_motion_data.stepsPerMM * app_motion_data.maxPosition, app_motion_data.homingVelocity * app_motion_data.stepsPerMM);
        app_motion_data.homeState = APP_MOTION_HOME_MOVING;
        break;
    case APP_MOTION_HOME_MOVING:
        if (app_motion_data.inputs.endstopUpperActive)
        {
            DEBUG_INFO("%s", "Homing Endstop\n");
            lib_timer_start(&app_motion_data.endstopTimer);
            actuator_stop();
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
            actuator_setPosition(jawOffsetSteps);
            actuator_move(jawOffsetSteps + homingOffsetSteps, (app_motion_data.homingVelocity * app_motion_data.stepsPerMM));
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
            actuator_move(steps, feedrate);
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
    case G123_WAVEFORM:
    {
        /* Reinterpret the move record for a firmware-native waveform:
         *   x = amplitude (µm), p = cycles,
         *   f = (shape << 24) | frequency-in-milli-Hz (low 24 bits).
         * The wave oscillates about the position the machine is at right now
         * (the program ramps to the mean with a preceding G1). */
        const int32_t amplitudeUm = app_motion_data.currentMove.x;
        const uint32_t fField = (uint32_t)app_motion_data.currentMove.f;
        const uint32_t freqMilliHz = fField & 0x00FFFFFFU;
        const uint32_t cycles = app_motion_data.currentMove.p;
        app_motion_data.waveformCentreSteps = app_motion_data.inputs.positionSteps;
        app_motion_data.waveformAmplitudeSteps =
            (int32_t)(((int64_t)amplitudeUm * app_motion_data.stepsPerMM) / 1000LL);
        app_motion_data.waveformFreqMilliHz = freqMilliHz;
        app_motion_data.waveformDurationUs =
            (freqMilliHz == 0U)
                ? 0U
                : (((uint64_t)cycles * 1000000000ULL) / (uint64_t)freqMilliHz);
        app_motion_data.waveformElapsedUs = 0U;
        app_motion_data.waveformLastUs = HAL_time_getUs();
        DEBUG_INFO("G123 waveform: amp=%d steps freq=%u mHz cycles=%u\n",
                   app_motion_data.waveformAmplitudeSteps, freqMilliHz, cycles);
        break;
    }
    default:
        break;
    }
}

/* Firmware-native waveform playback. Called every motion tick while a G123 is
 * the current move. Streams the analytic instantaneous velocity (2πf·A·cos) to
 * the stepper's continuous-velocity (NCO) output, sampling at the *real* elapsed
 * time so the cycle frequency holds regardless of tick jitter. The closed-loop
 * servo realises the commanded trajectory; firmware only emits the ideal rate. */
static bool app_motion_private_waveform_run(void)
{
    const uint32_t now = HAL_time_getUs();
    /* Wrap-safe accumulate: per-tick delta is tiny vs the uint32 µs wrap. */
    app_motion_data.waveformElapsedUs += (uint64_t)(now - app_motion_data.waveformLastUs);
    app_motion_data.waveformLastUs = now;

    if ((app_motion_data.waveformFreqMilliHz == 0U) ||
        (app_motion_data.waveformAmplitudeSteps == 0))
    {
        return true; /* degenerate params — nothing to play */
    }

    const float freqHz = (float)app_motion_data.waveformFreqMilliHz / 1000.0f;
    const float ampSteps = (float)app_motion_data.waveformAmplitudeSteps;

    if (app_motion_data.waveformElapsedUs >= app_motion_data.waveformDurationUs)
    {
        /* Whole cycles end at the centre; a settle move (exits velocity mode)
         * parks exactly on centre, completing on a small tolerance so a servo
         * that never lands exactly on centre can't wedge the move. */
        const float ampAbs = (ampSteps < 0.0f) ? -ampSteps : ampSteps;
        float peakVelF = APP_MOTION_TWO_PI * freqHz * ampAbs;
        if (peakVelF > APP_MOTION_WAVEFORM_MAX_STEPS_PER_S)
        {
            peakVelF = APP_MOTION_WAVEFORM_MAX_STEPS_PER_S; /* clamp (no overflow) */
        }
        uint32_t peakVel = (uint32_t)peakVelF;
        if (peakVel == 0U)
        {
            peakVel = 1U;
        }
        actuator_move(app_motion_data.waveformCentreSteps, peakVel);
        const int32_t settleErr =
            app_motion_data.inputs.positionSteps - app_motion_data.waveformCentreSteps;
        return ((settleErr <= APP_MOTION_WAVEFORM_SETTLE_STEPS) &&
                (settleErr >= -APP_MOTION_WAVEFORM_SETTLE_STEPS));
    }

    /* Stream the analytic instantaneous velocity of the trajectory:
     *   d/dt[ centre + A·sin(2πf t) ] = 2πf·A·cos(2πf t)   (steps/s, signed).
     * The stepper's NCO output follows the rate continuously (no per-segment
     * stop/start); position integrates to the sine. The sign of cos flips at the
     * position peaks, where the rate is ~0, so direction reversals are smooth.
     * The closed-loop servo realises the commanded trajectory. */
    const float t = (float)app_motion_data.waveformElapsedUs / 1.0e6f;
    const float phase = APP_MOTION_TWO_PI * freqHz * t;
    float velocity = APP_MOTION_TWO_PI * freqHz * ampSteps * cosf(phase);
    /* Clamp to the safe rate (prevents int32 overflow on extreme params). */
    if (velocity > APP_MOTION_WAVEFORM_MAX_STEPS_PER_S)
    {
        velocity = APP_MOTION_WAVEFORM_MAX_STEPS_PER_S;
    }
    else if (velocity < -APP_MOTION_WAVEFORM_MAX_STEPS_PER_S)
    {
        velocity = -APP_MOTION_WAVEFORM_MAX_STEPS_PER_S;
    }
    /* Round (not truncate) so sub-step rates near the turning points still move
     * in the correct direction instead of snapping to a momentary halt. */
    actuator_setVelocity((int32_t)roundf(velocity));
    return false;
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
    case G123_WAVEFORM:
        moveComplete = app_motion_private_waveform_run();
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
    /* The move queue needs no locking: it is touched ONLY by the CONTROL cog
     * (app_testManagement pushes — test feed + staged manual moves — and
     * app_motion pops/clears, all from the same run loop). Manual moves from
     * the COMMUNICATION cog go through app_testManagement's request slots, not
     * this queue. Single-cog access ⇒ within the queue's SPSC contract. */
    (void)lib_staticQueue_init(&app_motion_data.queue, app_motion_data.queueBuffer, MOTION_QUEUE_SIZE, sizeof(app_motion_move_t));
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
    actuator_stop();
    lib_staticQueue_empty(&app_motion_data.queue);
    if (app_motion_data.state == APP_MOTION_MOVING)
    {
        app_motion_data.state = APP_MOTION_WAITING;
    }
}

bool app_motion_isIdle(void)
{
    APP_MOTION_LOCK_REQ_BLOCK();
    const app_motion_state_E state = app_motion_data.state;
    APP_MOTION_LOCK_REL();
    /* Unlocked isempty is safe: the queue is CONTROL-cog-only and this is
     * called from app_testManagement's run loop on that same cog. */
    return (state == APP_MOTION_WAITING) &&
           lib_staticQueue_isempty(&app_motion_data.queue);
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
