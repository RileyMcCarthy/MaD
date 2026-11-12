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
#include "app_notification.h"

#include "dev_servo.h"
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

/* Homing asked for with the upper limit switch already active: how far the
 * carriage is moved off the switch to release it, as a multiple of the
 * profile's homingOffset (the distance that clears the switch after a normal
 * homing), and the least it is moved when the profile sets no offset. A
 * switch still active after that travel is one that is not going to release
 * -- stuck, or its loop open -- and homing fails without redefining the
 * position. */
#define APP_MOTION_HOMING_RELEASE_OFFSETS 2
#define APP_MOTION_HOMING_RELEASE_MIN_MM 2

#define APP_MOTION_LOCK_REQ() HAL_lock_try(app_motion_data.lock)
#define APP_MOTION_LOCK_REQ_BLOCK()        \
    while (APP_MOTION_LOCK_REQ() == false) \
    {                                      \
    }
#define APP_MOTION_LOCK_REL() HAL_lock_release(app_motion_data.lock)

/* Actuator abstraction: app_motion speaks these, dev_servo answers. The servo
 * closes its loop on the encoder, so every position, target and feedrate here
 * is in encoder counts and getPosition is the encoder truth. */
#define ACTUATOR_CH DEV_SERVO_CHANNEL_MAIN
#define actuator_enable(en) dev_servo_enable(ACTUATOR_CH, (en))
#define actuator_move(target, feedrate) dev_servo_moveTo(ACTUATOR_CH, (target), (feedrate))
#define actuator_moveOpenLoop(target, feedrate) dev_servo_moveToOpenLoop(ACTUATOR_CH, (target), (feedrate))
#define actuator_setVelocity(v) dev_servo_setVelocity(ACTUATOR_CH, (v))
#define actuator_stop() dev_servo_stop(ACTUATOR_CH)
#define actuator_setPosition(p) dev_servo_setPosition(ACTUATOR_CH, (p))
#define actuator_getPosition() dev_servo_getPosition(ACTUATOR_CH)
#define actuator_getTarget() dev_servo_getTarget(ACTUATOR_CH)
#define actuator_atTarget() dev_servo_atTarget(ACTUATOR_CH)
#define actuator_stageNext(target, feedrate) dev_servo_stageNext(ACTUATOR_CH, (target), (feedrate))
#define actuator_capStaged(feedrate) dev_servo_capStaged(ACTUATOR_CH, (feedrate))
#define actuator_getHandovers() dev_servo_getHandovers(ACTUATOR_CH)
#define actuator_getSetpoint() dev_servo_getSetpoint(ACTUATOR_CH)
#define actuator_startWaveform(wf) dev_servo_startWaveform(ACTUATOR_CH, (wf))

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
    uint32_t handovers;  /* staged moves the servo has switched to (dev_servo_getHandovers) */
    int32_t gaugeSetpointSteps;   /* where the move ENDS                */
    int32_t gaugeCommandedSteps;  /* where the trajectory is RIGHT NOW  */     /* actuator_getTarget() — commanded target */
    /* The travel limits (the soft-limit switches). Position is the distance
     * between the jaws, so it DECREASES toward the upper switch, at the top of
     * the column where the jaws meet -- the end homing seeks -- and INCREASES
     * toward the lower one. */
    bool endstopUpperActive;        /* HAL_GPIO_getActive(ENDSTOP_UPPER)      */
    bool endstopLowerActive;        /* HAL_GPIO_getActive(ENDSTOP_LOWER)      */
} app_motion_dataInputs_t;

typedef struct
{
    int32_t setpoint;  // nm — where the move ENDS
    int32_t commanded; // nm — where the trajectory is RIGHT NOW
    int32_t position;  // nm
} app_motion_outputs_t;

typedef struct
{
    app_motion_dataInputs_t inputs;
    lib_staticQueue_S queue;

    bool absoluteMode;
    /* Look-ahead (app_motion_private_stageNext): the straight move that follows
     * the running one, already handed to the servo so it can carry the
     * running move's speed straight into it. */
    bool staged;
    app_motion_move_t stagedMove;
    int32_t stagedEntries;  /* queue entries it takes up, mode changes included */
    bool stagedAbsolute;    /* the positioning mode once those entries have run */
    uint32_t handoversSeen; /* inputs.handovers when it was staged */
    int32_t stagedFeedrate; /* counts/s it was staged at, after any RESTRICTED cap */
    lib_timer_S dwellTimer;
    lib_timer_S endstopTimer;
    int32_t stepsPerMM; /* actuator units per mm: encoder counts (servo) or drive steps (stepper) */
    /* False when the machine profile could not be read or cannot describe the
     * machine. Every distance and feedrate this module emits is scaled by
     * stepsPerMM, so an unusable profile means motion is refused, not guessed. */
    bool profileValid;
    /* Speed cap applied while app_control reports the machine RESTRICTED,
     * in actuator units per second. Zero means no cap. */
    int32_t restrictedFeedrate;
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
    /* Latched when a G123 is refused (infeasible, unknown shape, or no servo
     * actuator) and cleared only by app_motion_takeWaveformRefused(). Without
     * it a refused waveform drains like a finished one and the test that asked
     * for it ends as "Test Complete!", with the refusal only in the debug log. */
    bool waveformRefused;

    /* Set by a move handler that dropped its move this tick (a travel limit, a
     * failed homing); the state machine then stops the drive, empties the
     * queue and returns to WAITING before the tick ends. */
    bool abortNow;
    /* Why, latched until app_motion_takeAbort() reads it. */
    app_motion_abort_E abort;
    /* One notification per activation of each travel limit: a jog button held
     * against a limit is refused every time, and told once. Cleared when the
     * switch releases. */
    bool upperLimitNotified;
    bool lowerLimitNotified;

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
static bool app_motion_private_linearMove(const app_motion_move_t *move, bool absolute, int32_t from,
                                         int32_t *steps, int32_t *feedrate);
static void app_motion_private_stageNext(void);
static void app_motion_private_takeHandover(void);
static void app_motion_private_capStaged(void);
static bool app_motion_private_waveform_run(void);
static void app_motion_private_abort(app_motion_abort_E reason);
static bool app_motion_private_limitBlocks(int32_t travel);
static void app_motion_private_limitStop(bool upper);
static bool app_motion_private_stopAtLimit(bool closedLoop);

/**********************************************************************
 * Private Functions
 **********************************************************************/

/* Drop the running move and everything queued behind it. The handler that
 * calls this only records it: the state machine does the stopping, once, after
 * the handler returns (app_motion_private_getDesiredState). */
static void app_motion_private_abort(app_motion_abort_E reason)
{
    app_motion_data.abortNow = true;
    APP_MOTION_LOCK_REQ_BLOCK();
    if (app_motion_data.abort == APP_MOTION_ABORT_NONE)
    {
        app_motion_data.abort = reason;
    }
    APP_MOTION_LOCK_REL();
}

/* Whether travel of `travel` counts -- only its sign matters -- heads into a
 * travel limit that is active. The upper switch guards decreasing position and
 * the lower one increasing position, so a move AWAY from an active limit is
 * never blocked: that is the way off it. */
static bool app_motion_private_limitBlocks(int32_t travel)
{
    return ((travel < 0) && app_motion_data.inputs.endstopUpperActive) ||
           ((travel > 0) && app_motion_data.inputs.endstopLowerActive);
}

/* A move heading into an active travel limit: it does not start, or it stops
 * here, and the queue behind it goes with it -- a program that has lost a move
 * is not the program that was asked for. */
static void app_motion_private_limitStop(bool upper)
{
    if (upper)
    {
        if (app_motion_data.upperLimitNotified == false)
        {
            app_motion_data.upperLimitNotified = true;
            app_notification_send(APP_NOTIFICATION_TYPE_WARNING, "%s",
                                  "Upper travel limit reached: motion stopped. Only moves away from it are accepted.");
        }
    }
    else if (app_motion_data.lowerLimitNotified == false)
    {
        app_motion_data.lowerLimitNotified = true;
        app_notification_send(APP_NOTIFICATION_TYPE_WARNING, "%s",
                              "Lower travel limit reached: motion stopped. Only moves away from it are accepted.");
    }
    else
    {
        /* already told */
    }
    DEBUG_WARNING("MOTION: %s travel limit active; move dropped\n", upper ? "upper" : "lower");
    app_motion_private_abort(APP_MOTION_ABORT_TRAVEL_LIMIT);
}

/* The running position move against the travel limits, each tick: a limit
 * that becomes active while the move still has to travel toward it stops the
 * move. True when it did.
 *
 * "Still has to travel toward it" is asked of the trajectory (target against
 * where the trajectory is now) and, in closed loop, of the carriage as well
 * (target against the encoder), and both have to agree. The carriage alone
 * would stop a move off a limit that has arrived and rests a count beyond its
 * target, with the switch still pressed. The trajectory alone would stop a
 * move of a count or two off a limit, whose trajectory starts from where the
 * last move parked the setpoint, which can be on the far side of the new
 * target from the encoder. Open loop has no encoder truth, so its trajectory
 * decides. */
static bool app_motion_private_stopAtLimit(bool closedLoop)
{
    const int32_t trajectory =
        app_motion_data.inputs.gaugeSetpointSteps - app_motion_data.inputs.gaugeCommandedSteps;
    const int32_t carriage = closedLoop
                                 ? (app_motion_data.inputs.gaugeSetpointSteps - app_motion_data.inputs.positionSteps)
                                 : trajectory;
    bool stopped = false;
    if ((trajectory < 0) && (carriage < 0) && app_motion_data.inputs.endstopUpperActive)
    {
        app_motion_private_limitStop(true);
        stopped = true;
    }
    else if ((trajectory > 0) && (carriage > 0) && app_motion_data.inputs.endstopLowerActive)
    {
        app_motion_private_limitStop(false);
        stopped = true;
    }
    else
    {
        /* not heading into an active limit */
    }
    return stopped;
}

static void app_motion_private_processInputs(void)
{
    app_motion_data.inputs.motionEnabled = app_control_motionEnabled();
    app_motion_data.inputs.limitSpeed = app_control_speedLimited();
    app_motion_data.inputs.positionSteps = actuator_getPosition();
    app_motion_data.inputs.atTarget = actuator_atTarget();
    app_motion_data.inputs.handovers = actuator_getHandovers();
    /* TWO different quantities, and conflating them is why a recorded G1 used
     * to carry a flat line through the middle of its own ramp.
     *
     *  - the TARGET is where the move ENDS. It is what a UI shows as "going
     *    to", and what a host uses to tell that a command has registered and
     *    that the axis has arrived.
     *  - the COMMANDED position is where the trajectory says the machine should
     *    be RIGHT NOW. It is what a recorded sample must carry, because it is
     *    what the specimen was actually being asked for at that instant.
     *
     * For a G1 ramp the first is constant and the second sweeps; for a waveform
     * the first is the centre it will finish at and the second traces the wave. */
    app_motion_data.inputs.gaugeSetpointSteps = actuator_getTarget();
    app_motion_data.inputs.gaugeCommandedSteps = actuator_getSetpoint();
    app_motion_data.inputs.endstopUpperActive = HAL_GPIO_getActive(HAL_GPIO_ENDSTOP_UPPER);
    app_motion_data.inputs.endstopLowerActive = HAL_GPIO_getActive(HAL_GPIO_ENDSTOP_LOWER);
    if (app_motion_data.inputs.endstopUpperActive == false)
    {
        app_motion_data.upperLimitNotified = false;
    }
    if (app_motion_data.inputs.endstopLowerActive == false)
    {
        app_motion_data.lowerLimitNotified = false;
    }
}

static void app_motion_private_processOutputs(void)
{
    int32_t setpoint = 0;
    int32_t commanded = 0;
    if (app_motion_data.stepsPerMM != 0)
    {
        setpoint = (int32_t)(((int64_t)app_motion_data.inputs.gaugeSetpointSteps * (int64_t)LIB_UTILITY_NM_PER_MM) / app_motion_data.stepsPerMM);
        commanded = (int32_t)(((int64_t)app_motion_data.inputs.gaugeCommandedSteps * (int64_t)LIB_UTILITY_NM_PER_MM) / app_motion_data.stepsPerMM);
    }
    APP_MOTION_LOCK_REQ_BLOCK();
    app_motion_data.output.setpoint = setpoint;
    app_motion_data.output.commanded = commanded;
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
        app_motion_data.staged = false;
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
        if (app_motion_data.abortNow)
        {
            /* The handler dropped its move (app_motion_private_abort): stop
             * the drive where it is and take nothing more from the queue. The
             * drive stays enabled and holds, so the next move -- the one that
             * backs off a limit -- can run. */
            app_motion_data.abortNow = false;
            actuator_stop();
            lib_staticQueue_empty(&app_motion_data.queue);
            app_motion_data.staged = false;
            app_motion_data.waveformRunning = false;
            app_motion_data.homeState = APP_MOTION_HOME_START;
            desiredState = APP_MOTION_WAITING;
        }
    }
    return desiredState;
}

/* G28: find the upper limit switch and define the position there.
 *
 * The reference is the switch's EDGE -- the point where it goes active as the
 * carriage arrives -- so the seek has to start with the switch released. A
 * switch that is already active says only that the carriage is somewhere
 * inside its actuation zone, or that its loop is open (a normally-closed
 * switch reads active with a wire off, wherever the carriage is), and taking
 * the position from that puts the zero wherever the carriage happens to stand.
 * So homing first moves off an active switch, starts the seek once it
 * releases, and fails -- leaving the position alone -- if it does not release
 * or is never found.
 *
 * The seek is the one move allowed toward the upper limit while it goes
 * active: finding it is the point. The two moves away from it obey the lower
 * limit like any other. */
static bool app_motion_private_homing_run(void)
{
    bool complete = false;
    const int32_t homingFeedrate = app_motion_data.homingVelocity * app_motion_data.stepsPerMM;
    const int32_t seekSteps = app_motion_data.stepsPerMM * app_motion_data.maxPosition;
    switch (app_motion_data.homeState)
    {
    case APP_MOTION_HOME_START:
        if (app_motion_data.inputs.endstopUpperActive)
        {
            int32_t releaseMM = APP_MOTION_HOMING_RELEASE_OFFSETS * app_motion_data.homingOffset;
            if (releaseMM < APP_MOTION_HOMING_RELEASE_MIN_MM)
            {
                releaseMM = APP_MOTION_HOMING_RELEASE_MIN_MM;
            }
            DEBUG_INFO("Homing: upper limit already active, releasing over %d mm\n", releaseMM);
            actuator_move(app_motion_data.inputs.positionSteps + (app_motion_data.stepsPerMM * releaseMM),
                          homingFeedrate);
            app_motion_data.homeState = APP_MOTION_HOME_RELEASE;
        }
        else
        {
            DEBUG_INFO("%s", "Homing Moving\n");
            actuator_move(app_motion_data.inputs.positionSteps - seekSteps, homingFeedrate);
            app_motion_data.homeState = APP_MOTION_HOME_MOVING;
        }
        break;
    case APP_MOTION_HOME_RELEASE:
        if (app_motion_data.inputs.endstopLowerActive)
        {
            app_motion_private_limitStop(false);
        }
        else if (app_motion_data.inputs.endstopUpperActive == false)
        {
            DEBUG_INFO("%s", "Homing: upper limit released, seeking\n");
            actuator_move(app_motion_data.inputs.positionSteps - seekSteps, homingFeedrate);
            app_motion_data.homeState = APP_MOTION_HOME_MOVING;
        }
        else if (app_motion_data.inputs.atTarget)
        {
            DEBUG_ERROR("%s", "Homing failed: the upper limit did not release\n");
            app_notification_send(APP_NOTIFICATION_TYPE_ERROR, "%s",
                                  "Homing failed: the upper limit switch stayed active. Check the switch and its wiring.");
            app_motion_private_abort(APP_MOTION_ABORT_HOMING_FAILED);
        }
        else
        {
            /* still moving off the switch */
        }
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
            /* The whole travel was covered without the switch going active.
             * The position is left as it was: there is nothing to define it
             * from. */
            DEBUG_ERROR("%s", "Homing failed: the upper limit was not found\n");
            app_notification_send(APP_NOTIFICATION_TYPE_ERROR, "%s",
                                  "Homing failed: the upper limit switch was not found.");
            app_motion_private_abort(APP_MOTION_ABORT_HOMING_FAILED);
        }
        else
        {
            /* still seeking */
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
                LIB_UTILITY_MM_TO_NM(app_motion_data.jawOffset));
            actuator_setPosition(jawOffsetSteps);
            actuator_move(jawOffsetSteps + homingOffsetSteps, homingFeedrate);
            app_motion_data.homeState = APP_MOTION_HOME_BACKOFF;
        }
        break;
    case APP_MOTION_HOME_BACKOFF:
        if (app_motion_data.inputs.endstopLowerActive)
        {
            app_motion_private_limitStop(false);
        }
        else if (app_motion_data.inputs.atTarget)
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
    case G124_OPEN_LOOP_MOVE:
        if (app_motion_data.currentMove.f == 0U)
        {
            DEBUG_WARNING("G0/G1/G124 Command has zero feedrate: %d\n", app_motion_data.currentMove.f);
        }
        else
        {
            const bool openLoop = (app_motion_data.currentMove.g == G124_OPEN_LOOP_MOVE);
            /* Relative to where the machine IS -- except open loop, which has
             * no encoder truth: its moves chain from where the last one was
             * COMMANDED, so a G124 out and a G124 back send equal pulse counts
             * however far the encoder disagreed. */
            const int32_t from = openLoop ? app_motion_data.inputs.gaugeCommandedSteps
                                          : app_motion_data.inputs.positionSteps;
            int32_t steps = 0;
            int32_t feedrate = 0;
            (void)app_motion_private_linearMove(&app_motion_data.currentMove, app_motion_data.absoluteMode, from,
                                                &steps, &feedrate);
            DEBUG_INFO("G0 command moving to steps %d at %d steps/s\n", steps, feedrate);
            DEBUG_INFO("moving from position (mm) %d to setpoint (mm) %d\n", app_motion_data.inputs.positionSteps / app_motion_data.stepsPerMM, steps / app_motion_data.stepsPerMM);
            if (app_motion_private_limitBlocks(steps - from))
            {
                /* Deeper into a limit that is already active: not sent to the
                 * drive at all. A move the other way is the way off it. */
                app_motion_private_limitStop(steps < from);
            }
            else if (openLoop)
            {
                actuator_moveOpenLoop(steps, feedrate);
            }
            else
            {
                actuator_move(steps, feedrate);
            }
        }
        break;
    case G2_CW_ARC_MOVE:
    case G3_CCW_ARC_MOVE:
    case G4_DWELL:
        DEBUG_INFO("G4 command pausing for %u ms", app_motion_data.currentMove.p);
        lib_timer_init(&app_motion_data.dwellTimer, app_motion_data.currentMove.p);
        lib_timer_start(&app_motion_data.dwellTimer);
        app_motion_data.staged = false;
        break;
    case G28_HOME:
        DEBUG_INFO("%s", "Homing\n");
        app_motion_data.homeState = APP_MOTION_HOME_START;
        app_motion_data.staged = false;
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
        /* A cosine from rest where the carriage is: that point is a peak of the
         * wave and where it ends. A positive amplitude rises from it first, so
         * the centre is above it; a negative one falls first. */
        const app_motion_waveform_t *const req = &app_motion_data.currentMove.wave;
        dev_servo_waveform_S wf;
        memset(&wf, 0, sizeof(wf));
        /* 0.1 um units on the wire -> encoder counts. int64 intermediate: at
         * 3000 mm and 8192 steps/mm this is 2.4e11 before the divide. */
        const int32_t amplitude =
            (int32_t)(((int64_t)req->amplitudeTenthUm * app_motion_data.stepsPerMM) / 10000LL);
        wf.centreCounts = app_motion_data.inputs.positionSteps + amplitude;
        wf.amplitudeCounts = (amplitude < 0) ? -amplitude : amplitude;
        wf.startHigh = (amplitude < 0);
        wf.freqMicroHz = req->freqMicroHz;
        wf.cycles = req->cycles;
        wf.dwellHighUs = req->dwellHighMs * 1000U;
        wf.dwellLowUs = req->dwellLowMs * 1000U;
        wf.skewPerMille = req->skewPerMille;
        wf.endFreqMicroHz = req->endFreqMicroHz;

        /* An unrecognised traverse profile is REFUSED, not defaulted. The wire
         * carries a whole byte and only 0 and 1 are defined, so a newer host
         * asking this firmware for a profile it has never heard of must fail
         * loudly: mapping the unknown byte onto a sine would run a specimen
         * through a loading nobody asked for and file the result under the
         * shape that was requested. The driver owns the set of profiles that
         * exist, so it owns the conversion too. */
        if (app_motion_data.inputs.endstopUpperActive || app_motion_data.inputs.endstopLowerActive)
        {
            /* A wave travels both ways from where it starts and comes back to
             * it every cycle, so one that starts on a travel limit returns to
             * that limit for as long as it runs. It is not started. */
            app_motion_data.waveformRunning = false;
            app_motion_private_limitStop(app_motion_data.inputs.endstopUpperActive);
        }
        else if (!dev_servo_waveShapeFromWire(req->shape, &wf.shape))
        {
            app_motion_data.waveformRunning = false;
            app_motion_data.waveformRefused = true;
            DEBUG_ERROR("G123 REFUSED: unknown shape=%u\n", (unsigned)req->shape);
        }
        else
        {
            app_motion_data.waveformRunning = actuator_startWaveform(&wf);
            if (app_motion_data.waveformRunning)
            {
                /* The CENTRE is the number that explains a waveform that runs
                 * into an endstop: the wave swings +/-amplitude about wherever
                 * the carriage happened to be when this move started. */
                DEBUG_INFO("G123: centre=%d amp=%d steps freq=%u uHz cycles=%u shape=%u "
                           "dwell=%u/%u ms skew=%u\n",
                           wf.centreCounts, wf.amplitudeCounts, wf.freqMicroHz, wf.cycles,
                           (unsigned)req->shape, req->dwellHighMs, req->dwellLowMs,
                           (unsigned)req->skewPerMille);
            }
            else
            {
                /* Refused, not approximated. The driver rejects a waveform
                 * whose peak velocity or acceleration the machine cannot
                 * deliver, or whose holds leave no time to move, because
                 * running a smaller one instead gives a specimen that never saw
                 * the loading the report claims it did. */
                app_motion_data.waveformRefused = true;
                DEBUG_ERROR("G123 REFUSED: amp=%d steps freq=%u uHz dwell=%u/%u ms skew=%u\n",
                            wf.amplitudeCounts, wf.freqMicroHz, req->dwellHighMs,
                            req->dwellLowMs, (unsigned)req->skewPerMille);
            }
        }
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
    if (app_motion_data.inputs.endstopUpperActive || app_motion_data.inputs.endstopLowerActive)
    {
        /* A limit can only have gone active because the wave carried the
         * carriage onto it, and the next cycle would carry it there again. */
        app_motion_private_limitStop(app_motion_data.inputs.endstopUpperActive);
        return false;
    }
    return app_motion_data.inputs.atTarget;
}

/* Target (counts) and feedrate (counts/s) of a straight move, in `absolute`
 * or relative positioning; relative moves are measured from `from`. False for
 * a move with no feedrate, which must not be sent to the drive. */
static bool app_motion_private_linearMove(const app_motion_move_t *move, bool absolute, int32_t from,
                                         int32_t *steps, int32_t *feedrate)
{
    /* move.x on SD is machine µm (host converts sample G-code at upload). */
    *steps = (int32_t)(((int64_t)move->x * app_motion_data.stepsPerMM) / 1000LL);
    *feedrate = (int32_t)(((int64_t)move->f * app_motion_data.stepsPerMM) / 1000LL);
    /* RESTRICTED is entered on an endstop, an open door, or a sample or frame
     * over its tension limit -- conditions where the machine may still be
     * moved, deliberately and slowly, to get out of them. Clamped rather than
     * refused, because refusing motion in RESTRICTED is what would strand a
     * specimen under load with no way to back off. */
    if (app_motion_data.inputs.limitSpeed && (app_motion_data.restrictedFeedrate > 0) &&
        (*feedrate > app_motion_data.restrictedFeedrate))
    {
        DEBUG_INFO("RESTRICTED: feedrate %d -> %d steps/s\n", *feedrate, app_motion_data.restrictedFeedrate);
        *feedrate = app_motion_data.restrictedFeedrate;
    }
    if (absolute == false)
    {
        *steps += from;
    }
    return move->f != 0U;
}

/* Look-ahead: when the next move to run (past any G90/G91, which take no time)
 * is another straight move, hand it to the servo now. The servo then switches
 * to it the moment the running move's trajectory arrives, carrying its speed
 * through when both go the same way, instead of stopping at every junction of
 * a program. A relative move continues from where the running one was SENT,
 * which is exactly where its trajectory ends. The queue is CONTROL-cog-only,
 * as in app_motion_isIdle, so it is read here without the lock. */
static void app_motion_private_stageNext(void)
{
    bool absolute = app_motion_data.absoluteMode;
    app_motion_move_t next;
    for (int32_t i = 0; lib_staticQueue_peek(&app_motion_data.queue, i, &next); i++)
    {
        if ((next.g == G90_ABSOLUTE) || (next.g == G91_INCREMENTAL))
        {
            absolute = (next.g == G90_ABSOLUTE);
            continue;
        }
        int32_t steps = 0;
        int32_t feedrate = 0;
        /* A move that would head into an active travel limit is not handed to
         * the servo ahead of time: it waits its turn in the queue and is
         * refused there, with the running move already settled. */
        if (((next.g == G0_RAPID_MOVE) || (next.g == G1_LINEAR_MOVE)) &&
            app_motion_private_linearMove(&next, absolute, app_motion_data.inputs.gaugeSetpointSteps, &steps,
                                          &feedrate) &&
            (app_motion_private_limitBlocks(steps - app_motion_data.inputs.gaugeSetpointSteps) == false))
        {
            actuator_stageNext(steps, feedrate);
            app_motion_data.staged = true;
            app_motion_data.stagedMove = next;
            app_motion_data.stagedEntries = i + 1;
            app_motion_data.stagedAbsolute = absolute;
            app_motion_data.handoversSeen = app_motion_data.inputs.handovers;
            app_motion_data.stagedFeedrate = feedrate;
        }
        break;
    }
}

/* The RESTRICTED cap is applied when a move is converted, and a staged move was
 * converted while the one before it started running. If the machine has turned
 * RESTRICTED since (an endstop, an open door, a sample or frame over its
 * tension limit), the staged copy the servo holds is lowered to the cap before
 * the servo switches to it, so the move that runs is the capped one. Only the
 * staged move: the running move's own speed is not changed here. */
static void app_motion_private_capStaged(void)
{
    if (app_motion_data.inputs.limitSpeed && (app_motion_data.restrictedFeedrate > 0) &&
        (app_motion_data.stagedFeedrate > app_motion_data.restrictedFeedrate))
    {
        /* False only if the servo switched to it after this tick's inputs were
         * read; the handover is then taken next tick, as for any other. */
        if (actuator_capStaged(app_motion_data.restrictedFeedrate))
        {
            DEBUG_INFO("RESTRICTED: staged feedrate %d -> %d steps/s\n", app_motion_data.stagedFeedrate,
                       app_motion_data.restrictedFeedrate);
        }
        app_motion_data.stagedFeedrate = app_motion_data.restrictedFeedrate;
    }
}

/* The servo has switched to the staged move: it is now the running one. */
static void app_motion_private_takeHandover(void)
{
    for (int32_t i = 0; i < app_motion_data.stagedEntries; i++)
    {
        (void)lib_staticQueue_pop(&app_motion_data.queue, NULL);
    }
    app_motion_data.absoluteMode = app_motion_data.stagedAbsolute;
    app_motion_data.currentMove = app_motion_data.stagedMove;
    app_motion_data.staged = false;
    DEBUG_INFO("Handed over to move: %d\n", app_motion_data.currentMove.g);
}

static bool app_motion_private_moveManager_run(void)
{
    bool moveComplete = false;
    switch (app_motion_data.currentMove.g)
    {
    case G0_RAPID_MOVE:
    case G1_LINEAR_MOVE:
        if (app_motion_private_stopAtLimit(true))
        {
            /* dropped: the state machine stops the drive */
        }
        else if (app_motion_data.staged)
        {
            if (app_motion_data.inputs.handovers != app_motion_data.handoversSeen)
            {
                app_motion_private_takeHandover();
                app_motion_private_stageNext();
            }
            else
            {
                app_motion_private_capStaged();
            }
        }
        else if (app_motion_data.inputs.atTarget)
        {
            /* The last straight move before anything else (a dwell, homing, a
             * waveform, the end of a program or a jog) waits to be settled. */
            moveComplete = true;
        }
        else
        {
            app_motion_private_stageNext();
        }
        break;
    case G124_OPEN_LOOP_MOVE:
        if (app_motion_private_stopAtLimit(false) == false)
        {
            moveComplete = app_motion_data.inputs.atTarget;
        }
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
    app_motion_data.staged = false;
    MachineProfile machineProfile;
    memset(&machineProfile, 0, sizeof(machineProfile));
    const bool profileRead =
        dev_nvram_getChannelData(DEV_NVRAM_CHANNEL_MACHINE_PROFILE, &machineProfile, sizeof(MachineProfile));
    /* stepsPerMM converts every distance and every feedrate this module emits,
     * so a zero makes each of them zero: `steps = um * 0 / 1000` targets encoder
     * count 0, and a feedrate of 0 is the invalid value dev_servo answers with
     * maxVelocity. That pair is a full-speed run to the bottom of the machine
     * from wherever the carriage is -- the worst thing this module can do --
     * and it takes only an unprovisioned or short profile.bin to reach. The
     * same value divides twice in the G0/G1 debug logging, so the debug build
     * traps on it first.
     *
     * A profile that cannot describe the machine is not repaired with a
     * default: a guessed steps/mm would run every test at the wrong scale and
     * report it as correct. Motion is refused until a real one is written.
     *
     * The servo's unit is the ENCODER count -- positions, targets and feedrates
     * are all closed on the encoder -- so the encoder's scale converts them.
     * The servo's own scale is still required: dev_servo pulses the drive by
     * the ratio of the two, and without it would be guessing how far a step
     * goes. */
    const int32_t actuatorStepsPerMM = machineProfile.encoderStepsPerMM;
    const bool scalesValid = (machineProfile.encoderStepsPerMM > 0) && (machineProfile.servoStepsPerMM > 0);
    app_motion_data.profileValid = profileRead && scalesValid;
    if (!app_motion_data.profileValid)
    {
        DEBUG_ERROR("MOTION: unusable machine profile (read=%d encoderStepsPerMM=%d servoStepsPerMM=%d); refusing motion\n",
                    (int)profileRead, (int)machineProfile.encoderStepsPerMM, (int)machineProfile.servoStepsPerMM);
        app_notification_send(APP_NOTIFICATION_TYPE_ERROR, "%s",
                              "Machine profile is missing or invalid; motion is refused until it is set");
    }
    app_motion_data.stepsPerMM = actuatorStepsPerMM;
    app_motion_data.maxPosition = machineProfile.maxPosition;
    app_motion_data.homingVelocity = machineProfile.homingVelocity;
    app_motion_data.homingOffset = machineProfile.homingOffset;
    app_motion_data.jawOffset = machineProfile.jawOffset;
    /* Precomputed in the drive's own units, because the clamp sits on the
     * per-move path. Zero (an older profile, or a profile that does not set it)
     * disables the clamp rather than pinning the machine to a standstill. */
    app_motion_data.restrictedFeedrate =
        (int32_t)(((int64_t)machineProfile.restrictedVelocity * actuatorStepsPerMM));
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
    if (!app_motion_data.profileValid)
    {
        /* Refused at the door rather than at the conversion: a move that never
         * enters the queue cannot be started, and the caller gets a false it
         * can report instead of a test that runs at an unknown scale. */
        return false;
    }
    return lib_staticQueue_push(&app_motion_data.queue, (void *)move);
}

void app_motion_abortAndClear(void)
{
    actuator_stop();
    app_motion_data.staged = false;
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

bool app_motion_takeWaveformRefused(void)
{
    APP_MOTION_LOCK_REQ_BLOCK();
    const bool refused = app_motion_data.waveformRefused;
    app_motion_data.waveformRefused = false;
    APP_MOTION_LOCK_REL();
    return refused;
}

app_motion_abort_E app_motion_takeAbort(void)
{
    APP_MOTION_LOCK_REQ_BLOCK();
    const app_motion_abort_E reason = app_motion_data.abort;
    app_motion_data.abort = APP_MOTION_ABORT_NONE;
    APP_MOTION_LOCK_REL();
    return reason;
}

int32_t app_motion_getCommandedPosition(void)
{
    APP_MOTION_LOCK_REQ_BLOCK();
    const int32_t commanded = app_motion_data.output.commanded;
    APP_MOTION_LOCK_REL();
    return commanded;
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
