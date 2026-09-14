//
// Created by Riley McCarthy on 25/04/24.
//
/**********************************************************************
 * Includes
 **********************************************************************/
#include <string.h>
#include <stdlib.h>
/* Not used directly any more, but dropping it changes the header chain into a
 * FlexC internal error inside libc's ioctl.c. Keep it. */
#include <math.h>
#include "HAL_lock.h"

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
#define actuator_getSetpoint() dev_servo_getSetpoint(ACTUATOR_CH)
#define actuator_startWaveform(centre, amp, freqUhz, cycles, shape)                                \
    dev_servo_startWaveform(ACTUATOR_CH, (centre), (amp), (freqUhz), (cycles), (shape))
#define ACTUATOR_HAS_WAVEFORM 1
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
/* dev_stepper is open-loop and has no trajectory generator, so it has no
 * waveform. G123 is refused on that build rather than approximated. */
#define actuator_getSetpoint() actuator_getTarget()
#define ACTUATOR_HAS_WAVEFORM 0
#endif

/* Waveform (G123): the DRIVER generates the trajectory.
 *
 * This layer used to generate it here and stream an analytic velocity to the
 * actuator each tick, with an outer position loop bolted on top to claw back
 * what the accel limiter ate on the way in. All of that existed because a
 * sinusoid started from its own centre demands v(0) = 2*pi*f*A instantly, which
 * no accel-limited machine can deliver.
 *
 * dev_servo now runs the waveform as approach-to-peak, whole cycles peak to
 * peak, return to centre -- every instant of which is inside the acceleration
 * budget, so there is no lag to correct and nothing for an anchor to do. What
 * is left here is unit conversion and a completion check. */

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

    /* Waveform (G123): whether the driver accepted the one we asked for. The
     * trajectory, its phase, its cycle count and its completion all live in the
     * driver now, so there is nothing else for this layer to remember. */
    bool waveformRunning;

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
    /* A target is where a move ENDS; during a waveform that is the centre it
     * will finish at, which is not what the specimen is being asked for at this
     * instant. Report the driver's own profile position instead, so a recorded
     * sample carries the trajectory rather than its destination. (Only for a
     * waveform: making this unconditional would change the recorded setpoint of
     * every G0/G1 too, which is a separate question about what a sample means.) */
    if (app_motion_data.currentMove.g == G123_WAVEFORM)
    {
        app_motion_data.inputs.gaugeSetpointSteps = actuator_getSetpoint();
    }
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
#if ACTUATOR_HAS_WAVEFORM
        /* The move record carries a waveform in a general move's field slots:
         *   x = amplitude (um), p = cycles,
         *   f = (shape << 24) | frequency-in-milli-Hz (low 24 bits).
         * The wave swings about wherever the carriage is right now, which is
         * also the point it is returned to at the end. */
        const int32_t amplitudeUm = app_motion_data.currentMove.x;
        const uint32_t fField = (uint32_t)app_motion_data.currentMove.f;
        const uint32_t freqMilliHz = fField & 0x00FFFFFFU;
        const uint32_t shapeBits = (fField >> 24) & 0xFFU;
        const uint32_t cycles = app_motion_data.currentMove.p;
        const int32_t centreSteps = app_motion_data.inputs.positionSteps;
        const int32_t amplitudeSteps =
            (int32_t)(((int64_t)amplitudeUm * app_motion_data.stepsPerMM) / 1000LL);
        /* The driver's phase accumulator is exact in microhertz; the wire still
         * speaks millihertz, so this widening is lossless. */
        const uint32_t freqMicroHz = freqMilliHz * 1000U;
        dev_servo_wave_E shape = DEV_SERVO_WAVE_SINE;
        if (shapeBits == 1U)
        {
            shape = DEV_SERVO_WAVE_TRIANGLE;
        }

        app_motion_data.waveformRunning =
            actuator_startWaveform(centreSteps, amplitudeSteps, freqMicroHz, cycles, shape);
        if (app_motion_data.waveformRunning)
        {
            /* The CENTRE is the number that explains a waveform that runs into
             * an endstop: the wave swings +/-amplitude about wherever the
             * carriage happened to be when this move started. */
            DEBUG_INFO("G123 waveform: centre=%d steps amp=%d steps freq=%u mHz cycles=%u shape=%u\n",
                       centreSteps, amplitudeSteps, freqMilliHz, cycles, shapeBits);
        }
        else
        {
            /* Refused, not approximated. The driver rejects a waveform whose
             * peak velocity or acceleration the machine cannot deliver, because
             * running a smaller one instead gives a specimen that never saw the
             * loading the report claims it did. */
            DEBUG_ERROR("G123 waveform REFUSED: amp=%d steps freq=%u mHz exceeds the machine\n",
                        amplitudeSteps, freqMilliHz);
        }
#else
        app_motion_data.waveformRunning = false;
        DEBUG_ERROR("%s", "G123 waveform needs the servo actuator; refusing\n");
#endif
        break;
    }
    default:
        break;
    }
}

/* A waveform is complete when the DRIVER says so.
 *
 * There is nothing to step here. dev_servo owns the phase, counts the cycles,
 * and runs the closing move back to the centre, so this layer neither knows nor
 * needs to know how far through the run it is -- and a waveform that was
 * refused must end the move rather than wait forever for a run that never
 * started. */
static bool app_motion_private_waveform_run(void)
{
    if (app_motion_data.waveformRunning == false)
    {
        return true;
    }
    return app_motion_data.inputs.atTarget;
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
