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
        2,                           /* waveformStartTolerance — ~0.25 um, so the first
                                      *   cycle starts inside the 1 um contract */
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
    /* OSCILLATE mode */
    int32_t waveCentre;    /* counts */
    int32_t waveAmplitude; /* counts */
    uint32_t waveFreqMicroHz;
    uint32_t waveCycles;      /* whole cycles to run, then stop */
    dev_servo_wave_E waveShape;
    float waveCruiseVel;      /* counts/s, TRIANGLE only — solved at accept */
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
    /* Oscillator phase as a WRAPPING accumulator: 2^32 counts to the cycle, so
     * the wrap IS the modulo and a completed cycle is just the carry. No
     * elapsed-microsecond counter means no 32-bit duration ceiling -- the old
     * APP-side version capped at 3600 s and silently truncated longer runs --
     * and no float phase to lose precision over a long fatigue test. */
    uint32_t wavePhase;
    uint32_t phaseRemainder; /* sub-LSB carry; see dev_servo_private_phaseStep */
    uint32_t waveCyclesDone;
    uint8_t waveSegment; /* dev_servo_waveSegment_E */
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

/* One cycle of phase, as a wrapping 32-bit accumulator. */
#define DEV_SERVO_PHASE_ONE_CYCLE 4294967296.0f

/* A waveform is three segments, and only the middle one is a waveform.
 *
 * The reason is that a sinusoid's velocity is `wA*cos`, so at its CENTRE the
 * velocity is maximal: a machine standing at rest at the centre cannot begin
 * one without an infinite acceleration. The only phases at which a sinusoid
 * can be joined or left at rest are its PEAKS. So the driver approaches the
 * peak as an ordinary profiled move, runs whole cycles peak-to-peak, and
 * returns to the centre as another ordinary move. Every instant of all three
 * is within the acceleration budget, which is what makes the delivered
 * trajectory equal to the requested one instead of a lagged copy of it. */
typedef enum
{
    DEV_SERVO_WAVE_APPROACH = 0, /* profiled move from wherever we are to the peak */
    DEV_SERVO_WAVE_RUN,          /* the cycles themselves, evaluated from phase     */
    DEV_SERVO_WAVE_RETURN        /* profiled move back to the centre                */
} dev_servo_waveSegment_E;
#define DEV_SERVO_TWO_PI 6.283185307179586f

/* Peak rate and peak acceleration a shape demands at amplitude A and frequency f. */
static void dev_servo_private_waveDemand(float amplitude, float freqHz, dev_servo_wave_E shape,
                                         float maxAccel, float *peakVel, float *peakAccel)
{
    if (shape == DEV_SERVO_WAVE_TRIANGLE)
    {
        /* A triangle's corners are a velocity STEP, so a literal one demands
         * infinite acceleration and no machine can track it. The feasible
         * realisation of "constant strain rate" is a TRAPEZOIDAL velocity
         * profile per half cycle: ramp at maxAccel, cruise, ramp down. Solving
         *     2A = v*(T/2) - v^2/a
         * for the smaller root gives the cruise rate that still covers 2A in
         * half a period. The rounding at each peak is v^2/2a wide -- that is
         * the difference between the requested profile and a deliverable one,
         * and it is why this is checked rather than silently approximated. */
        const float halfPeriod = (freqHz > 0.0f) ? (0.5f / freqHz) : 0.0f;
        const float b = maxAccel * halfPeriod;
        const float disc = (b * b) - (8.0f * amplitude * maxAccel);
        if ((disc < 0.0f) || (halfPeriod <= 0.0f))
        {
            *peakVel = 0.0f;
            *peakAccel = maxAccel * 2.0f; /* infeasible: report over-budget */
            return;
        }
        *peakVel = 0.5f * (b - sqrtf(disc));
        *peakAccel = maxAccel;
    }
    else
    {
        const float omega = DEV_SERVO_TWO_PI * freqHz;
        *peakVel = omega * amplitude;
        *peakAccel = omega * omega * amplitude;
    }
}

/* Evaluate the oscillator at the current phase, then advance it by one tick. */
/* Where the waveform is at a given phase. PURE -- no state, no side effects --
 * so the caller can ask for the position at the start and at the end of a tick
 * and difference the two. That is the whole point of evaluating a waveform
 * rather than integrating one. */
static float dev_servo_private_waveAt(const dev_servo_channelData_S *d, float maxAccel, float phase)
{
    const float amplitude = (float)d->req.waveAmplitude;
    const float centre = (float)d->req.waveCentre;
    const float freqHz = (float)d->req.waveFreqMicroHz / 1000000.0f;

    if (d->req.waveShape == DEV_SERVO_WAVE_TRIANGLE)
    {
        /* Trapezoidal velocity, integrated to position analytically within the
         * half cycle so position and velocity stay exactly consistent. */
        const float halfPeriod = (freqHz > 0.0f) ? (0.5f / freqHz) : 0.0f;
        const float v = d->req.waveCruiseVel;
        const float tRamp = (v > 0.0f) ? (v / maxAccel) : 0.0f;
        /* The trapezoid is naturally parameterised from the NEGATIVE peak
         * (tHalf = 0 is the bottom, at rest). Phase 0 must be the POSITIVE
         * peak to match the sine, and that is half a cycle later. Both peaks
         * are velocity zeros, so either would be joinable; picking the same
         * one as the sine keeps `waveShape` a pure change of path and not a
         * change of where the run starts. */
        float rampPhase = phase + 0.5f;
        if (rampPhase >= 1.0f) { rampPhase -= 1.0f; }
        const bool rising = (rampPhase < 0.5f);
        const float tHalf = (rising ? rampPhase : (rampPhase - 0.5f)) * 2.0f * halfPeriod;
        const float dir = rising ? 1.0f : -1.0f;

        float travelled;
        if (tHalf < tRamp)
        {
            travelled = 0.5f * (v / tRamp) * tHalf * tHalf;
        }
        else if (tHalf < (halfPeriod - tRamp))
        {
            travelled = (0.5f * v * tRamp) + (v * (tHalf - tRamp));
        }
        else
        {
            const float tDown = tHalf - (halfPeriod - tRamp);
            travelled = (0.5f * v * tRamp) + (v * (halfPeriod - (2.0f * tRamp))) +
                        ((v * tDown) - (0.5f * (v / tRamp) * tDown * tDown));
        }
        return centre + (dir * (travelled - amplitude));
    }

    /* cos, not sin: phase 0 is the POSITIVE PEAK, where the velocity passes
     * through zero. A sine would put phase 0 at the centre moving at `wA`,
     * which no machine standing at rest can join. */
    return centre + (amplitude * cosf(DEV_SERVO_TWO_PI * phase));
}

/* How far the phase advances in `elapsedUs`, EXACTLY.
 *
 * The obvious `(uint32_t)(freqHz * dt * 2^32)` throws away the fraction of a
 * phase unit every single tick, always in the same direction. At 1 Hz on a 1 ms
 * tick it loses 0.296 units per tick, which is 1.9 um of position error after
 * an hour and 45.7 um after a day (amplitude 10000 counts) -- a fatigue run is
 * exactly the case where that matters, and exactly the case nobody tests.
 *
 * There is no need to approximate at all. The increment is
 *
 *     freqMicroHz * elapsedUs * 2^32 / 1e12
 *
 * and 1e12 = 2^12 * 5^12, so the 2^12 cancels and the ratio is EXACTLY
 * 2^20 / 5^12 -- two integers. Dividing by 5^12 and carrying the remainder
 * into the next tick makes the accumulated phase exact for all time, whatever
 * the tick jitter. Measured over 24 h of jittered ticks: 0.047 phase units,
 * which is the bounded sub-LSB carry rather than drift.
 *
 * Every intermediate is proved below to fit in 64 bits, and no 64-bit ternary
 * appears here -- FlexC miscompiles `dest64 = cond ? A : B`, dropping the high
 * word. Only 64-bit multiply and divide, which it compiles correctly. */
#define DEV_SERVO_PHASE_NUM 1048576ULL  /* 2^20 */
#define DEV_SERVO_PHASE_DEN 244140625ULL /* 5^12 */

static uint32_t dev_servo_private_phaseStep(dev_servo_channelData_S *d, uint32_t elapsedUs)
{
    /* freqMicroHz <= 1e9 (1 kHz) and elapsedUs <= 100000 (the tick guard's
     * cap), so n <= 1e14 -- 184000x inside uint64. */
    const uint64_t n = (uint64_t)d->req.waveFreqMicroHz * (uint64_t)elapsedUs;
    const uint64_t q = n / DEV_SERVO_PHASE_DEN;  /* <= 409600            */
    const uint64_t r = n % DEV_SERVO_PHASE_DEN;  /* <  5^12              */
    /* r * 2^20 < 2.56e14, plus a carry below 5^12: no overflow. */
    const uint64_t frac = (r * DEV_SERVO_PHASE_NUM) + (uint64_t)d->phaseRemainder;
    const uint64_t step = (q * DEV_SERVO_PHASE_NUM) + (frac / DEV_SERVO_PHASE_DEN);
    d->phaseRemainder = (uint32_t)(frac % DEV_SERVO_PHASE_DEN);
    /* A step of 2^32 or more is more than one whole cycle per tick: the
     * waveform is aliased and was never sampled. Feasibility rejects those
     * long before here, so clamp rather than wrap silently. */
    if (step >= 0x100000000ULL)
    {
        return 0xFFFFFFFFU;
    }
    return (uint32_t)step;
}

static void dev_servo_private_oscillate(dev_servo_channelData_S *d, float dt, uint32_t elapsedUs,
                                        float maxAccel, float *pos, float *vel)
{
    const float phase = (float)d->wavePhase / DEV_SERVO_PHASE_ONE_CYCLE; /* [0,1) */

    /* Advance first, so the tick's END phase is known and the velocity below
     * can be the interval's true average. The wrap IS the cycle boundary --
     * no modulo, no elapsed counter. */
    const uint32_t step = dev_servo_private_phaseStep(d, elapsedUs);
    const uint32_t next = d->wavePhase + step;
    const float nextPhase = (float)next / DEV_SERVO_PHASE_ONE_CYCLE;

    *pos = dev_servo_private_waveAt(d, maxAccel, phase);

    /* Command the AVERAGE velocity across the tick, not the instantaneous
     * velocity at its start.
     *
     * They differ by `a*dt/2`, and that difference is not noise: it is a bias
     * of one sign for the whole half cycle, so the position loop has to stand
     * off by `a*dt/(2*kp)` to generate it -- a standing tracking error of
     * ~25 counts (3 um) on this machine, present even against a perfect plant.
     * Differencing the evaluated waveform removes it exactly, for any shape,
     * and leaves the proportional term with nothing to do but reject real
     * disturbances. The wave is periodic in phase, so this stays exact across
     * the wrap. */
    *vel = (dev_servo_private_waveAt(d, maxAccel, nextPhase) - *pos) / dt;

    if (next < d->wavePhase)
    {
        d->waveCyclesDone++;
    }
    d->wavePhase = next;
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
        /* Where the profiler aims, and whether it runs at all. A waveform's
         * outer segments are ordinary position moves, so they reuse the
         * profiler rather than duplicating it; only its RUN segment writes the
         * setpoint directly, and that is the one case the limiter must not
         * touch (an evaluated setpoint is already within budget by
         * construction, and re-limiting it would reintroduce the lag). */
        bool evaluated = false;
        int32_t profileTarget = target;
        float profileCruise = (float)feedrate;

        if (mode == DEV_SERVO_MODE_OSCILLATE)
        {
            const int32_t peak = d->req.waveCentre + d->req.waveAmplitude;
            profileCruise = maxVel;
            profileTarget =
                (d->waveSegment == (uint8_t)DEV_SERVO_WAVE_APPROACH) ? peak : d->req.waveCentre;

            if (d->waveSegment == (uint8_t)DEV_SERVO_WAVE_RUN)
            {
                /* The setpoint is EVALUATED, never integrated: position comes
                 * from the phase, so there is no accumulator to drift and the
                 * ramp-in deficit that velocity mode leaves behind cannot
                 * arise. */
                dev_servo_private_oscillate(d, dt, elapsedUs, (float)cfg->maxAccel,
                                            &d->setpointPos, &d->setpointVel);
                evaluated = true;
                if (d->waveCyclesDone >= d->req.waveCycles)
                {
                    /* Whole cycles done, so the carriage is back at the peak
                     * with its velocity through zero. Stop evaluating HERE:
                     * letting the phase run on past the last cycle leaves a
                     * phantom setpoint walking away from a machine that has
                     * parked, and the following error it opens up is both
                     * published and a fault input. */
                    d->waveSegment = (uint8_t)DEV_SERVO_WAVE_RETURN;
                    d->setpointPos = (float)peak;
                    d->setpointVel = 0.0f;
                    profileTarget = d->req.waveCentre;
                    evaluated = false;
                }
            }
        }

        if (mode == DEV_SERVO_MODE_VELOCITY)
        {
            desiredSpVel = (float)targetVel;
            if (desiredSpVel > maxVel) { desiredSpVel = maxVel; }
            if (desiredSpVel < -maxVel) { desiredSpVel = -maxVel; }
        }
        else if (!evaluated)
        {
            const float dist = (float)profileTarget - d->setpointPos; /* remaining (setpoint frame) */
            const float adist = fabsf(dist);
            const float cruise = profileCruise; /* moveTo clamps to 1..maxVelocity */
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

            /* Arriving to START a waveform is held to a tighter tolerance than
             * arriving to PARK; see waveformStartTolerance. Until it is met the
             * park below stays disengaged, so the proportional term keeps
             * creeping the axis in rather than freezing it one deadband out. */
            const int32_t arriveWithin =
                ((mode == DEV_SERVO_MODE_OSCILLATE) &&
                 (d->waveSegment == (uint8_t)DEV_SERVO_WAVE_APPROACH))
                    ? cfg->waveformStartTolerance
                    : cfg->positionDeadband;
            if ((dev_servo_private_iabs(profileTarget - pos) <= arriveWithin) &&
                (fabsf(d->setpointVel) < 1.0f))
            {
                atTarget = true; /* encoder is on target and the profile has wound down */
            }
        }

        if (!evaluated)
        {
            /* Accel-limit the setpoint velocity toward the desired (trapezoid ramp). */
            const float maxDv = (float)cfg->maxAccel * dt;
            float dv = desiredSpVel - d->setpointVel;
            if (dv > maxDv) { dv = maxDv; }
            if (dv < -maxDv) { dv = -maxDv; }
            d->setpointVel += dv;
            d->setpointPos += d->setpointVel * dt;
        }

        if ((mode == DEV_SERVO_MODE_OSCILLATE) &&
            (d->waveSegment == (uint8_t)DEV_SERVO_WAVE_APPROACH) && atTarget)
        {
            /* Standing at the peak at rest: join the sinusoid here, where its
             * own velocity is zero, so there is no step to absorb. The waveform
             * is not finished, so this arrival must NOT be reported as one. */
            d->waveSegment = (uint8_t)DEV_SERVO_WAVE_RUN;
            d->wavePhase = 0U;
            d->waveCyclesDone = 0U;
            atTarget = false;
        }

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
            d->setpointPos = (float)profileTarget;
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

bool dev_servo_waveformFeasible(dev_servo_channel_E ch, int32_t amplitudeCounts,
                                uint32_t freqMicroHz, dev_servo_wave_E shape)
{
    if (ch >= DEV_SERVO_CHANNEL_COUNT) { return false; }
    const dev_servo_channelConfig_S *cfg = &dev_servo_channelConfig[ch];
    if ((amplitudeCounts <= 0) || (freqMicroHz == 0U)) { return false; }

    const float amplitude = (float)amplitudeCounts;
    const float freqHz = (float)freqMicroHz / 1000000.0f;
    float peakVel = 0.0f;
    float peakAccel = 0.0f;
    dev_servo_private_waveDemand(amplitude, freqHz, shape, (float)cfg->maxAccel, &peakVel, &peakAccel);

    /* Rejected rather than approximated. Running an over-aggressive profile at
     * whatever the limiter allows produces data that does not match the request
     * -- on a fatigue test, a specimen that never saw the loading it is
     * reported to have seen. */
    return (peakVel > 0.0f) && (peakVel <= (float)cfg->maxVelocity) &&
           (peakAccel <= (float)cfg->maxAccel);
}

bool dev_servo_startWaveform(dev_servo_channel_E ch, int32_t centreCounts, int32_t amplitudeCounts,
                             uint32_t freqMicroHz, uint32_t cycles, dev_servo_wave_E shape)
{
    if (ch >= DEV_SERVO_CHANNEL_COUNT) { return false; }
    if (cycles == 0U) { return false; }
    if (!dev_servo_waveformFeasible(ch, amplitudeCounts, freqMicroHz, shape)) { return false; }

    const dev_servo_channelConfig_S *cfg = &dev_servo_channelConfig[ch];
    float peakVel = 0.0f;
    float peakAccel = 0.0f;
    dev_servo_private_waveDemand((float)amplitudeCounts, (float)freqMicroHz / 1000000.0f, shape,
                                 (float)cfg->maxAccel, &peakVel, &peakAccel);

    DEV_SERVO_LOCK_REQ_BLOCK();
    dev_servo_data.channel[ch].req.mode = DEV_SERVO_MODE_OSCILLATE;
    dev_servo_data.channel[ch].req.waveCentre = centreCounts;
    dev_servo_data.channel[ch].req.waveAmplitude = amplitudeCounts;
    dev_servo_data.channel[ch].req.waveFreqMicroHz = freqMicroHz;
    dev_servo_data.channel[ch].req.waveCycles = cycles;
    dev_servo_data.channel[ch].req.waveShape = shape;
    dev_servo_data.channel[ch].req.waveCruiseVel = peakVel;
    /* The driver owns the whole manoeuvre: move to the peak, cycle, come back
     * to the centre. So the caller does not have to pre-position the machine,
     * and `atTarget` means the WAVEFORM is done rather than some segment of
     * it -- one completion concept for the whole command. */
    dev_servo_data.channel[ch].req.target = centreCounts;
    dev_servo_data.channel[ch].waveSegment = (uint8_t)DEV_SERVO_WAVE_APPROACH;
    dev_servo_data.channel[ch].wavePhase = 0U;
    dev_servo_data.channel[ch].phaseRemainder = 0U;
    dev_servo_data.channel[ch].waveCyclesDone = 0U;
    dev_servo_data.channel[ch].req.seq++;
    dev_servo_data.channel[ch].out.atTarget = false;
    DEV_SERVO_LOCK_REL();
    return true;
}

uint32_t dev_servo_waveformCyclesDone(dev_servo_channel_E ch)
{
    if (ch >= DEV_SERVO_CHANNEL_COUNT) { return 0U; }
    DEV_SERVO_LOCK_REQ_BLOCK();
    const uint32_t done = dev_servo_data.channel[ch].waveCyclesDone;
    DEV_SERVO_LOCK_REL();
    return done;
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
