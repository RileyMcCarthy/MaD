//
// Created by Riley McCarthy on 24/06/26.
//
/**********************************************************************
 * Includes
 **********************************************************************/
#include <math.h>
#include "dev_servo.h"
#include "HAL_lock.h"
#include "HAL_time.h"
#include "IO_Debug.h"
#include "emulation_helpers.h"
/**********************************************************************
 * Constants
 **********************************************************************/
/* Compile-time DEFAULTS in encoder counts (servo = 8192 counts/mm). Wiring
 * (pulse/dir/encoder channels) and control tuning (gains, stall guard, loop
 * period) are fixed here; maxVelocity/maxAccel are OVERRIDDEN per channel at
 * init from the machine profile (dev_servo_init) and fall back to these gentle
 * values only if the profile is unprovisioned. Tune the gains against the SIL
 * plant model — see dev_servo.h.
 * Positional initializer (no .field = designators): FlexC rejects C99 designated
 * initializers ("Bad constant expression"). Field order MUST match
 * dev_servo_channelConfig_S in dev_servo.h. */
static const dev_servo_channelConfig_S dev_servo_channelConfigDefault[DEV_SERVO_CHANNEL_COUNT] = {
    {
        HAL_PULSE_OUT_CHANNEL_SERVO, /* pulseChannel */
        HAL_GPIO_SERVO_DIR,          /* gpioDirection */
        HAL_ENCODER_CHANNEL_SERVO,   /* encoderChannel */
        1000U,                       /* loopPeriodUs     — 1 kHz control tick (match the cog rate) */
        24576,                       /* maxVelocity      — gentle fallback (3 mm/s); machine profile normally overrides (20 mm/s => 163840) */
        245760,                      /* maxAccel         — gentle fallback (30 mm/s^2); machine profile normally overrides (50 mm/s^2 => 409600) */
        16,                          /* positionDeadband — ~2 um */
        8,                           /* kpNum            — cmd += 8*err; ~just under maxAccel/maxVel~=10 edge */
        1,                           /* kpDen */
        0,                           /* kiNum            — integral OFF (validated Ki~20 nulls load error,
                                      *                    but overshoots without proper anti-windup) */
        1,                           /* kiDen */
        81920,                       /* integralLimit    — 10 mm/s of integral authority (anti-windup) */
        4096,                        /* stallVelocity    — 0.5 mm/s */
        1,                           /* stallMinMove */
        200U,                        /* stallTicks       — 200 ms commanding-without-motion => stall */
    },
};

/* Active per-channel config: seeded from the defaults above at init, then
 * maxVelocity/maxAccel are overlaid from the machine profile. All runtime reads
 * go through this (mutable) array, not the const defaults. */
static dev_servo_channelConfig_S dev_servo_channelConfig[DEV_SERVO_CHANNEL_COUNT];

/*********************************************************************
 * Macros
 **********************************************************************/
#define DEV_SERVO_LOCK_REQ_BLOCK()                     \
    while (HAL_lock_try(dev_servo_data.lock) == false) \
    {                                                  \
        EMULATION_YIELD_LOCK();                        \
    }
#define DEV_SERVO_LOCK_REL() (void)HAL_lock_release(dev_servo_data.lock)

/**********************************************************************
 * Typedefs
 **********************************************************************/
typedef struct
{
    bool enabled;
    dev_servo_mode_E mode;
    int32_t target;    /* counts (POSITION mode) */
    int32_t feedrate;  /* counts/s cruise speed (POSITION mode), 1..maxVelocity */
    int32_t targetVel; /* counts/s (VELOCITY mode) */
    /* Bumped by every command that changes what "at target" means. dev_servo_run
     * snapshots it with the request and refuses to publish an atTarget verdict
     * computed against a target that was superseded mid-tick — see the publish
     * guard in dev_servo_run and the note on dev_servo_atTarget. */
    uint32_t seq;
} dev_servo_request_S;

typedef struct
{
    int32_t position;
    int32_t velocity;
    int32_t followingError;
    bool atTarget;
    bool stalled;
    bool ready; /* the control loop has ticked (see dev_servo_isReady) */
} dev_servo_output_S;

typedef struct
{
    dev_servo_request_S req;
    dev_servo_output_S out;

    /* Trajectory generator state (the shaped setpoint the feedback loop tracks). */
    float setpointPos; /* counts */
    float setpointVel; /* counts/s — also the velocity feedforward term */

    float integral;     /* ∫err dt (counts·s) */
    float commandedVel; /* counts/s actually applied (for stall + telemetry) */
    int32_t lastPos;
    uint32_t lastTickUs; /* HAL_time_getUs() at the previous tick (for measured dt) */
    uint32_t stallCounter;
    bool velActive; /* a velocity pulse train is currently running */
    bool lastCw;    /* direction of the running train (latched at start) */
} dev_servo_channelData_S;

typedef struct
{
    dev_servo_channelData_S channel[DEV_SERVO_CHANNEL_COUNT];
    int32_t lock;
} dev_servo_data_S;
/**********************************************************************
 * Private Variable Definitions
 **********************************************************************/
static dev_servo_data_S dev_servo_data;
/**********************************************************************
 * Private Function Definitions
 **********************************************************************/
static inline int32_t dev_servo_private_iabs(int32_t x) { return (x < 0) ? -x : x; }

/* Push the commanded velocity (counts/s, signed) to the step pin: set the
 * direction GPIO and the pulse frequency, starting the train if needed. A zero
 * command stops the train. (SERVO_DIR active=false => CW => increasing counts,
 * matching dev_stepper's convention.) */
static void dev_servo_private_applyVelocity(dev_servo_channel_E ch, float vel)
{
    const dev_servo_channelConfig_S *const cfg = &dev_servo_channelConfig[ch];
    dev_servo_channelData_S *const d = &dev_servo_data.channel[ch];

    if (vel == 0.0f)
    {
        if (d->velActive)
        {
            HAL_pulseOut_stop(cfg->pulseChannel);
            d->velActive = false;
        }
        return;
    }

    const bool cw = (vel >= 0.0f);
    /* The pulse engine latches direction at start, so a direction flip while
     * running requires a restart — otherwise pulses keep counting the old way. */
    if (d->velActive && (cw != d->lastCw))
    {
        HAL_pulseOut_stop(cfg->pulseChannel);
        d->velActive = false;
    }
    HAL_GPIO_setActive(cfg->gpioDirection, !cw);
    d->lastCw = cw;
    const uint32_t freq = (uint32_t)fabsf(vel);
    if (!d->velActive)
    {
        HAL_pulseOut_startVelocity(cfg->pulseChannel, freq);
        d->velActive = true;
    }
    else
    {
        HAL_pulseOut_setFrequency(cfg->pulseChannel, freq);
    }
}

/* Reset all dynamic state to "holding at the current encoder position". */
static void dev_servo_private_resync(dev_servo_channel_E ch, int32_t pos)
{
    dev_servo_channelData_S *const d = &dev_servo_data.channel[ch];
    d->setpointPos = (float)pos;
    d->setpointVel = 0.0f;
    d->integral = 0.0f;
    d->commandedVel = 0.0f;
    d->stallCounter = 0U;
    d->lastPos = pos;
}

/**********************************************************************
 * Public Function Definitions
 **********************************************************************/
void dev_servo_init(int lock, int32_t maxVelocityCounts, int32_t maxAccelCounts)
{
    dev_servo_data.lock = lock;
    for (dev_servo_channel_E ch = (dev_servo_channel_E)0; ch < DEV_SERVO_CHANNEL_COUNT; ch++)
    {
        /* Seed the active config from the compile-time defaults, then overlay the
         * machine-profile limits (already in encoder counts). A non-positive limit
         * means the profile is unprovisioned => keep the gentle default. */
        dev_servo_channelConfig[ch] = dev_servo_channelConfigDefault[ch];
        if (maxVelocityCounts > 0) { dev_servo_channelConfig[ch].maxVelocity = maxVelocityCounts; }
        if (maxAccelCounts > 0) { dev_servo_channelConfig[ch].maxAccel = maxAccelCounts; }

        dev_servo_channelData_S *const d = &dev_servo_data.channel[ch];
        const int32_t pos = HAL_encoder_value(dev_servo_channelConfig[ch].encoderChannel);
        d->req.enabled = false;
        d->req.mode = DEV_SERVO_MODE_IDLE;
        d->req.target = pos;
        d->req.feedrate = dev_servo_channelConfig[ch].maxVelocity;
        d->req.targetVel = 0;
        d->out.position = pos;
        d->out.velocity = 0;
        d->out.followingError = 0;
        d->out.atTarget = true;
        d->out.stalled = false;
        d->out.ready = false; /* not ready until the cog has run a control tick */
        d->velActive = false;
        d->lastCw = true;
        dev_servo_private_resync(ch, pos);
    }
}

void dev_servo_run(void)
{
    for (dev_servo_channel_E ch = (dev_servo_channel_E)0; ch < DEV_SERVO_CHANNEL_COUNT; ch++)
    {
        const dev_servo_channelConfig_S *const cfg = &dev_servo_channelConfig[ch];
        dev_servo_channelData_S *const d = &dev_servo_data.channel[ch];

        /* Snapshot the request under lock (commands come from another cog). */
        DEV_SERVO_LOCK_REQ_BLOCK();
        const bool enabled = d->req.enabled;
        const dev_servo_mode_E mode = d->req.mode;
        const int32_t target = d->req.target;
        const int32_t feedrate = d->req.feedrate;
        const int32_t targetVel = d->req.targetVel;
        const uint32_t seq = d->req.seq;
        DEV_SERVO_LOCK_REL();

        const int32_t pos = HAL_encoder_value(cfg->encoderChannel); /* the one source of truth */

        /* Measured tick period: a fixed nominal dt is wrong whenever the tick
         * actually drifts (SIL poll-sleep, real-world jitter), which corrupts the
         * feedforward velocity. Measure it and guard the first tick / outliers. */
        const uint32_t nowUs = HAL_time_getUs();
        uint32_t elapsedUs = nowUs - d->lastTickUs; /* wrap-safe (uint32) */
        d->lastTickUs = nowUs;
        if ((elapsedUs == 0U) || (elapsedUs > 100000U))
        {
            elapsedUs = cfg->loopPeriodUs;
        }
        const float dt = (float)elapsedUs / 1000000.0f;

        if (!enabled)
        {
            dev_servo_private_applyVelocity(ch, 0.0f);
            dev_servo_private_resync(ch, pos);
            DEV_SERVO_LOCK_REQ_BLOCK();
            d->out.position = pos;
            d->out.velocity = 0;
            d->out.followingError = 0;
            /* Disabled => nothing outstanding, but only if no command landed
             * mid-tick (that command's target has not been evaluated yet). */
            d->out.atTarget = (d->req.seq == seq);
            d->out.stalled = false;
            d->out.ready = true; /* disabled but alive — the loop is still ticking */
            DEV_SERVO_LOCK_REL();
            continue;
        }

        const float maxVel = (float)cfg->maxVelocity;

        /* ---- Stage 1: trajectory generator -> (setpointVel, setpointPos) ---- */
        float desiredSpVel = 0.0f;
        bool atTarget = false;
        if (mode == DEV_SERVO_MODE_POSITION)
        {
            const float dist = (float)target - d->setpointPos; /* remaining (setpoint frame) */
            const float adist = fabsf(dist);
            const float cruise = (float)feedrate; /* moveTo clamps to 1..maxVelocity */
            /* Fastest speed from which we can still brake to rest at the target. */
            const float vStop = sqrtf(2.0f * (float)cfg->maxAccel * adist);
            float speed = (cruise < vStop) ? cruise : vStop;
            /* ...and never faster than "cover what is left in one tick". The
             * braking law alone is singular at the target: for a sub-count
             * remainder it still demands hundreds of counts/s, so the setpoint
             * steps clean over the target, flips sign, and hunts forever — the
             * profile never winds down, so the move never reports arrival even
             * with the encoder sitting inside the deadband. Capping by the
             * one-tick reach lands the setpoint exactly on the target instead. */
            const float vReach = adist / dt;
            if (vReach < speed) { speed = vReach; }
            desiredSpVel = (dist >= 0.0f) ? speed : -speed;

            if ((dev_servo_private_iabs(target - pos) <= cfg->positionDeadband) &&
                (fabsf(d->setpointVel) < 1.0f))
            {
                atTarget = true; /* encoder is on target and the profile has wound down */
            }
        }
        else if (mode == DEV_SERVO_MODE_VELOCITY)
        {
            desiredSpVel = (float)targetVel;
            if (desiredSpVel > maxVel) { desiredSpVel = maxVel; }
            if (desiredSpVel < -maxVel) { desiredSpVel = -maxVel; }
        }

        /* Accel-limit the setpoint velocity toward the desired (trapezoid ramp). */
        const float maxDv = (float)cfg->maxAccel * dt;
        float dv = desiredSpVel - d->setpointVel;
        if (dv > maxDv) { dv = maxDv; }
        if (dv < -maxDv) { dv = -maxDv; }
        d->setpointVel += dv;
        d->setpointPos += d->setpointVel * dt;

        /* ---- Stage 2: feedback = feedforward + Kp*err + Ki*∫err ---- */
        const float error = d->setpointPos - (float)pos;
        const float kp = (float)cfg->kpNum / (float)cfg->kpDen;

        float iTerm = 0.0f;
        if (cfg->kiNum != 0)
        {
            const float ki = (float)cfg->kiNum / (float)cfg->kiDen;
            d->integral += error * dt;
            const float maxIntegral = (float)cfg->integralLimit / ki; /* anti-windup clamp */
            if (d->integral > maxIntegral) { d->integral = maxIntegral; }
            if (d->integral < -maxIntegral) { d->integral = -maxIntegral; }
            iTerm = ki * d->integral;
        }

        float cmdVel = d->setpointVel + (kp * error) + iTerm;
        if (cmdVel > maxVel) { cmdVel = maxVel; }
        if (cmdVel < -maxVel) { cmdVel = -maxVel; }

        if (atTarget)
        {
            /* Park: stop pulsing, hold on the stepper's detent torque, snap the
             * setpoint to the target, and bleed the integral so a later move
             * starts clean. A disturbance that pushes past the deadband drops
             * atTarget on the next tick and the loop re-engages. */
            cmdVel = 0.0f;
            d->setpointVel = 0.0f;
            d->setpointPos = (float)target;
            d->integral = 0.0f;
        }

        /* ---- Apply, then advance the pulse engine (drives the SIL encoder). ---- */
        d->commandedVel = cmdVel;
        dev_servo_private_applyVelocity(ch, cmdVel);
        if (d->velActive)
        {
            uint32_t emitted = 0U;
            (void)HAL_pulseOut_run(cfg->pulseChannel, &emitted);
        }

        /* ---- Stall guard: commanding motion but the encoder isn't following. ---- */
        bool stalled = false;
        const int32_t moved = dev_servo_private_iabs(pos - d->lastPos);
        if ((fabsf(d->commandedVel) > (float)cfg->stallVelocity) && (moved < cfg->stallMinMove))
        {
            d->stallCounter++;
            if (d->stallCounter >= cfg->stallTicks)
            {
                stalled = true;
            }
        }
        else
        {
            d->stallCounter = 0U;
        }
        d->lastPos = pos;

        DEV_SERVO_LOCK_REQ_BLOCK();
        d->out.position = pos;
        d->out.velocity = (int32_t)d->commandedVel;
        d->out.followingError = (int32_t)error;
        /* Only publish a verdict for the target this tick actually evaluated. A
         * command that landed after the snapshot above changed the goalposts, so
         * report "not there yet" and let the next tick judge the new target. */
        d->out.atTarget = atTarget && (d->req.seq == seq);
        d->out.stalled = stalled;
        d->out.ready = true;
        DEV_SERVO_LOCK_REL();
    }
}

void dev_servo_enable(dev_servo_channel_E ch, bool enable)
{
    if (ch >= DEV_SERVO_CHANNEL_COUNT) { return; }
    DEV_SERVO_LOCK_REQ_BLOCK();
    dev_servo_data.channel[ch].req.enabled = enable;
    DEV_SERVO_LOCK_REL();
}

void dev_servo_moveTo(dev_servo_channel_E ch, int32_t targetCounts, int32_t feedrateCountsPerSec)
{
    if (ch >= DEV_SERVO_CHANNEL_COUNT) { return; }
    const int32_t maxVel = dev_servo_channelConfig[ch].maxVelocity;
    if ((feedrateCountsPerSec <= 0) || (feedrateCountsPerSec > maxVel))
    {
        feedrateCountsPerSec = maxVel; /* 0/invalid => full speed */
    }
    DEV_SERVO_LOCK_REQ_BLOCK();
    dev_servo_data.channel[ch].req.mode = DEV_SERVO_MODE_POSITION;
    dev_servo_data.channel[ch].req.target = targetCounts;
    dev_servo_data.channel[ch].req.feedrate = feedrateCountsPerSec;
    /* A fresh target invalidates the previous verdict: the caller must not see
     * the "parked at the last target" true and conclude this move is already
     * done (that would retire every move the instant it is issued). */
    dev_servo_data.channel[ch].req.seq++;
    dev_servo_data.channel[ch].out.atTarget = false;
    DEV_SERVO_LOCK_REL();
}

void dev_servo_setVelocity(dev_servo_channel_E ch, int32_t velCountsPerSec)
{
    if (ch >= DEV_SERVO_CHANNEL_COUNT) { return; }
    DEV_SERVO_LOCK_REQ_BLOCK();
    dev_servo_data.channel[ch].req.mode = DEV_SERVO_MODE_VELOCITY;
    dev_servo_data.channel[ch].req.targetVel = velCountsPerSec;
    /* Leaving the position-target regime: the old verdict no longer describes
     * anything the caller can act on. */
    dev_servo_data.channel[ch].req.seq++;
    dev_servo_data.channel[ch].out.atTarget = false;
    DEV_SERVO_LOCK_REL();
}

void dev_servo_stop(dev_servo_channel_E ch)
{
    if (ch >= DEV_SERVO_CHANNEL_COUNT) { return; }
    /* Smooth decel to rest: ramp the velocity setpoint to zero, then hold. */
    DEV_SERVO_LOCK_REQ_BLOCK();
    dev_servo_data.channel[ch].req.mode = DEV_SERVO_MODE_VELOCITY;
    dev_servo_data.channel[ch].req.targetVel = 0;
    dev_servo_data.channel[ch].req.seq++;
    dev_servo_data.channel[ch].out.atTarget = false;
    DEV_SERVO_LOCK_REL();
}

void dev_servo_setPosition(dev_servo_channel_E ch, int32_t counts)
{
    if (ch >= DEV_SERVO_CHANNEL_COUNT) { return; }
    HAL_encoder_set(dev_servo_channelConfig[ch].encoderChannel, counts);
    DEV_SERVO_LOCK_REQ_BLOCK();
    dev_servo_data.channel[ch].req.target = counts;
    dev_servo_private_resync(ch, counts);
    /* Re-defining the coordinate frame moves the target with it; re-judge. */
    dev_servo_data.channel[ch].req.seq++;
    dev_servo_data.channel[ch].out.atTarget = false;
    DEV_SERVO_LOCK_REL();
}

int32_t dev_servo_getPosition(dev_servo_channel_E ch)
{
    if (ch >= DEV_SERVO_CHANNEL_COUNT) { return 0; }
    DEV_SERVO_LOCK_REQ_BLOCK();
    const int32_t pos = dev_servo_data.channel[ch].out.position;
    DEV_SERVO_LOCK_REL();
    return pos;
}

int32_t dev_servo_getVelocity(dev_servo_channel_E ch)
{
    if (ch >= DEV_SERVO_CHANNEL_COUNT) { return 0; }
    DEV_SERVO_LOCK_REQ_BLOCK();
    const int32_t vel = dev_servo_data.channel[ch].out.velocity;
    DEV_SERVO_LOCK_REL();
    return vel;
}

int32_t dev_servo_getFollowingError(dev_servo_channel_E ch)
{
    if (ch >= DEV_SERVO_CHANNEL_COUNT) { return 0; }
    DEV_SERVO_LOCK_REQ_BLOCK();
    const int32_t err = dev_servo_data.channel[ch].out.followingError;
    DEV_SERVO_LOCK_REL();
    return err;
}

int32_t dev_servo_getTarget(dev_servo_channel_E ch)
{
    if (ch >= DEV_SERVO_CHANNEL_COUNT) { return 0; }
    DEV_SERVO_LOCK_REQ_BLOCK();
    const int32_t target = dev_servo_data.channel[ch].req.target;
    DEV_SERVO_LOCK_REL();
    return target;
}

bool dev_servo_atTarget(dev_servo_channel_E ch)
{
    if (ch >= DEV_SERVO_CHANNEL_COUNT) { return false; }
    DEV_SERVO_LOCK_REQ_BLOCK();
    const bool at = dev_servo_data.channel[ch].out.atTarget;
    DEV_SERVO_LOCK_REL();
    return at;
}

bool dev_servo_isStalled(dev_servo_channel_E ch)
{
    if (ch >= DEV_SERVO_CHANNEL_COUNT) { return false; }
    DEV_SERVO_LOCK_REQ_BLOCK();
    const bool st = dev_servo_data.channel[ch].out.stalled;
    DEV_SERVO_LOCK_REL();
    return st;
}

bool dev_servo_isReady(dev_servo_channel_E ch)
{
    if (ch >= DEV_SERVO_CHANNEL_COUNT) { return false; }
    DEV_SERVO_LOCK_REQ_BLOCK();
    const bool ready = dev_servo_data.channel[ch].out.ready;
    DEV_SERVO_LOCK_REL();
    return ready;
}
/**********************************************************************
 * End of File
 **********************************************************************/
