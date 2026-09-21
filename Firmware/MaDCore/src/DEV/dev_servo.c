//
// Created by Riley McCarthy on 24/06/26.
//
/**********************************************************************
 * Includes
 **********************************************************************/
#include <math.h>
#include "lib_utility.h"
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
        8,                           /* positionDeadband — 0.977 um; a commanded
                                      *   position is reached inside the 1 um contract */
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
    dev_servo_waveform_S wave;
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

    /* Trajectory generator state (the shaped setpoint the feedback loop tracks).
     *
     * Position is stored as integer counts plus a nanocount remainder so a
     * long cruise cannot lose a fraction of a count to float. `setpointPos`
     * is the published view of that pair (error, telemetry); the profiler
     * advances the integer state, never `setpointPos += v*dt`. FlexC cannot
     * hold a named 64-bit local, so the 32x32->64 divide goes through
     * lib_utility_muldivmod64_unsigned. */
    int32_t setpointCounts;
    uint32_t setpointNano; /* 0 .. 999999999; 1e9 nanocounts = 1 count */
    float setpointPos;     /* counts — published view of counts + nano */
    float setpointVel;     /* counts/s — also the velocity feedforward term */

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
    /* Cycle geometry as fractions of one period, worked out once when the
     * waveform starts so the 1 kHz tick does no divisions and no sqrt. */
    float waveFracHigh;  /* hold at +A                                   */
    float waveFracDown;  /* traverse +A -> -A                            */
    float waveFracLow;   /* hold at -A                                   */
    float waveFracUp;    /* traverse -A -> +A                            */
    float waveRampDown;  /* TRIANGLE only: ramp share of the down traverse */
    float waveRampUp;    /* TRIANGLE only: ramp share of the up traverse   */
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

#define DEV_SERVO_NANOCOUNTS 1000000000U

/* Publish the float view from the integer position. */
static void dev_servo_private_publishSetpoint(dev_servo_channelData_S *d)
{
    d->setpointPos = (float)d->setpointCounts + ((float)d->setpointNano * 1.0e-9f);
}

/* Snap the trajectory to an integer count (park, resync, handover). */
static void dev_servo_private_snapSetpoint(dev_servo_channelData_S *d, int32_t counts)
{
    d->setpointCounts = counts;
    d->setpointNano = 0U;
    d->setpointPos = (float)counts;
}

/* Load an evaluated (float) position into the integer accumulator.
 * Used when the waveform writes a position instead of integrating one. */
static void dev_servo_private_loadSetpoint(dev_servo_channelData_S *d, float pos)
{
    int32_t counts = (int32_t)pos; /* toward zero */
    float frac = pos - (float)counts;
    if (frac < 0.0f)
    {
        counts -= 1;
        frac += 1.0f;
    }
    uint32_t nano = (uint32_t)((frac * 1.0e9f) + 0.5f);
    if (nano >= DEV_SERVO_NANOCOUNTS)
    {
        nano -= DEV_SERVO_NANOCOUNTS;
        counts += 1;
    }
    d->setpointCounts = counts;
    d->setpointNano = nano;
    dev_servo_private_publishSetpoint(d);
}

/* Advance the setpoint by feedVel * elapsedUs / 1e6 counts, exactly.
 *
 * milli-counts/s * microseconds / 1e9 = counts. The remainder is nanocounts
 * and is carried into the next tick, so a 200 mm cruise at 10 mm/s does not
 * accumulate float error. */
static void dev_servo_private_advanceSetpoint(dev_servo_channelData_S *d, float feedVel,
                                             uint32_t elapsedUs)
{
    if ((elapsedUs == 0U) || (feedVel == 0.0f))
    {
        return;
    }
    const bool forward = (feedVel >= 0.0f);
    const float magF = (forward == true) ? feedVel : -feedVel;
    const uint32_t milli = (uint32_t)((magF * 1000.0f) + 0.5f);
    if (milli == 0U)
    {
        return;
    }
    uint32_t remPart = 0U;
    const uint32_t counts =
        lib_utility_muldivmod64_unsigned(milli, elapsedUs, DEV_SERVO_NANOCOUNTS, &remPart);
    if (forward == true)
    {
        uint32_t rem = d->setpointNano + remPart;
        uint32_t extra = 0U;
        if (rem >= DEV_SERVO_NANOCOUNTS)
        {
            rem -= DEV_SERVO_NANOCOUNTS;
            extra = 1U;
        }
        d->setpointNano = rem;
        d->setpointCounts += (int32_t)(counts + extra);
    }
    else
    {
        /* Remainder is a forward fraction of a count; reverse subtracts it,
         * borrowing a whole count when there isn't enough. Adding it on
         * reverse made the profiler hunt through the target. */
        uint32_t extra = 0U;
        if (d->setpointNano >= remPart)
        {
            d->setpointNano -= remPart;
        }
        else
        {
            d->setpointNano = (d->setpointNano + DEV_SERVO_NANOCOUNTS) - remPart;
            extra = 1U;
        }
        d->setpointCounts -= (int32_t)(counts + extra);
    }
    dev_servo_private_publishSetpoint(d);
}

/* Reset all dynamic state to "holding at the current encoder position". */
static void dev_servo_private_resync(dev_servo_channel_E ch, int32_t pos)
{
    dev_servo_channelData_S *const d = &dev_servo_data.channel[ch];
    dev_servo_private_snapSetpoint(d, pos);
    d->setpointVel = 0.0f;
    d->integral = 0.0f;
    d->commandedVel = 0.0f;
    d->stallCounter = 0U;
    d->lastPos = pos;
}

/**********************************************************************
 * Public Function Definitions
 **********************************************************************/
bool dev_servo_waveShapeFromWire(uint8_t wire, dev_servo_wave_E *shape)
{
    if (shape == NULL)
    {
        return false;
    }
    bool known = true;
    switch (wire)
    {
    case (uint8_t)DEV_SERVO_WAVE_SINE:
        *shape = DEV_SERVO_WAVE_SINE;
        break;
    case (uint8_t)DEV_SERVO_WAVE_TRIANGLE:
        *shape = DEV_SERVO_WAVE_TRIANGLE;
        break;
    default:
        known = false;
        break;
    }
    return known;
}

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
#define DEV_SERVO_PI 3.14159265358979f
#define DEV_SERVO_TWO_PI 6.283185307179586f

/* Peak rate and peak acceleration a shape demands at amplitude A and frequency f. */
/* Solve ONE traverse: can the machine cover 2A in `tau` seconds with this
 * profile, and if so what share of it is spent ramping?
 *
 * Each traverse is solved on its own because skew and dwell make the two
 * halves different lengths. A cycle can be perfectly achievable going down and
 * impossible coming back up, and approving it on an average would run a
 * profile the specimen never saw. */
static bool dev_servo_private_solveTraverse(dev_servo_wave_E shape, float amplitude, float tau,
                                            float maxVel, float maxAccel, float *ramp)
{
    *ramp = 0.0f;
    if ((tau <= 0.0f) || (amplitude <= 0.0f))
    {
        return false;
    }

    if (shape == DEV_SERVO_WAVE_TRIANGLE)
    {
        /* 2A = v*tau - v^2/a, with the ramp time v/a. Writing r for the ramp's
         * share of tau collapses the whole profile onto r alone:
         *     r = (1 - sqrt(1 - 8A/(a*tau^2))) / 2
         * and the traverse is feasible exactly when that root is real -- i.e.
         * when a*tau^2 >= 8A. r -> 0.5 is a pure triangular rate with no
         * cruise at all; smaller r is a longer cruise. */
        const float k = (8.0f * amplitude) / (maxAccel * tau * tau);
        if (k > 1.0f)
        {
            return false;
        }
        const float r = 0.5f * (1.0f - sqrtf(1.0f - k));
        if ((maxAccel * tau * r) > maxVel)
        {
            return false;
        }
        *ramp = r;
        return true;
    }

    /* Half-cosine over tau covering 2A: x = A*cos(pi*t/tau), so the peak rate
     * is pi*A/tau and the peak acceleration pi^2*A/tau^2. */
    const float peakVel = (DEV_SERVO_PI * amplitude) / tau;
    const float peakAccel = (DEV_SERVO_PI * DEV_SERVO_PI * amplitude) / (tau * tau);
    return (peakVel <= maxVel) && (peakAccel <= maxAccel);
}

/* Lay out one cycle and decide whether the machine can run it.
 *
 * Everything the tick needs is reduced to fractions of a period here, once, so
 * the 1 kHz loop does no division and no square root. */
static bool dev_servo_private_planWaveform(const dev_servo_channelConfig_S *cfg,
                                           const dev_servo_waveform_S *wf, float *fracHigh,
                                           float *fracDown, float *fracLow, float *fracUp,
                                           float *rampDown, float *rampUp)
{
    if ((wf == NULL) || (wf->amplitudeCounts <= 0) || (wf->freqMicroHz == 0U) ||
        (wf->cycles == 0U) || (wf->skewPerMille == 0U) || (wf->skewPerMille >= 1000U))
    {
        return false;
    }
    /* A traverse profile this driver does not implement is REFUSED, not
     * quietly run as a sine. A newer host asking for a shape an older
     * firmware has never heard of must fail loudly -- silently substituting
     * one is the failure mode that produces a plausible-looking result from a
     * test that was never performed. */
    if ((wf->shape != DEV_SERVO_WAVE_SINE) && (wf->shape != DEV_SERVO_WAVE_TRIANGLE))
    {
        return false;
    }

    const float periodS = 1000000.0f / (float)wf->freqMicroHz;
    const float highS = (float)wf->dwellHighUs / 1000000.0f;
    const float lowS = (float)wf->dwellLowUs / 1000000.0f;
    const float traverseS = periodS - highS - lowS;
    if (traverseS <= 0.0f)
    {
        return false; /* the holds asked for more than the whole period */
    }

    const float amplitude = (float)wf->amplitudeCounts;
    const float tauDown = traverseS * ((float)wf->skewPerMille / 1000.0f);
    const float tauUp = traverseS - tauDown;

    if (!dev_servo_private_solveTraverse(wf->shape, amplitude, tauDown, (float)cfg->maxVelocity,
                                         (float)cfg->maxAccel, rampDown))
    {
        return false;
    }
    if (!dev_servo_private_solveTraverse(wf->shape, amplitude, tauUp, (float)cfg->maxVelocity,
                                         (float)cfg->maxAccel, rampUp))
    {
        return false;
    }

    *fracHigh = highS / periodS;
    *fracDown = tauDown / periodS;
    *fracLow = lowS / periodS;
    *fracUp = tauUp / periodS;
    return true;
}

/* A normalised TRAVERSE: u in [0,1] -> share of the peak-to-peak distance
 * covered, with zero slope at both ends so it can be joined to a dwell (or to
 * rest) without a velocity step.
 *
 * `ramp` is the share of the traverse spent accelerating, and is the ONLY
 * parameter a trapezoid needs -- the cruise rate, the ramp time and the
 * distances all follow from it, which is why it is solved once at accept time
 * rather than per tick. */
static float dev_servo_private_traverse(dev_servo_wave_E shape, float ramp, float u)
{
    if (shape == DEV_SERVO_WAVE_TRIANGLE)
    {
        /* Trapezoidal rate. A literal triangle reverses velocity instantly at
         * the corners, which demands infinite acceleration; this is the
         * deliverable realisation of "constant strain rate", and the rounding
         * it puts on each corner is `ramp` wide. */
        const float flat = 1.0f - ramp;
        if (ramp <= 0.0f)
        {
            return u; /* degenerate: pure cruise */
        }
        if (u < ramp)
        {
            return (u * u) / (2.0f * ramp * flat);
        }
        if (u <= flat)
        {
            return (u - (0.5f * ramp)) / flat;
        }
        const float w = 1.0f - u;
        return 1.0f - ((w * w) / (2.0f * ramp * flat));
    }
    /* Half-cosine: smooth, and with no dwell and no skew the whole cycle is
     * exactly A*cos(2*pi*phase) -- the plain sinusoid falls out of the template
     * rather than being a separate case. */
    return 0.5f * (1.0f - cosf(DEV_SERVO_PI * u));
}

/* The waveform's EXCURSION FROM ITS CENTRE at a given phase.
 *
 * Excursion, not absolute position, precisely so that the caller can difference
 * two phases on small numbers. The centre can be 24,576,000 counts out at the
 * far end of the machine, where a float's ulp is 2 counts; differencing two
 * absolute positions there would fold a rounding error into a per-tick
 * displacement of only ~63 counts.
 *
 * The cycle, in phase order from 0:
 *     [ hold at +A ] [ traverse down ] [ hold at -A ] [ traverse up ]
 */
static float dev_servo_private_waveExcursion(const dev_servo_channelData_S *d, float phase)
{
    const float amplitude = (float)d->req.wave.amplitudeCounts;
    const dev_servo_wave_E shape = d->req.wave.shape;

    float p = phase;
    if (p < d->waveFracHigh)
    {
        return amplitude; /* held at the top */
    }
    p -= d->waveFracHigh;

    if (p < d->waveFracDown)
    {
        const float u = p / d->waveFracDown;
        return amplitude - (2.0f * amplitude * dev_servo_private_traverse(shape, d->waveRampDown, u));
    }
    p -= d->waveFracDown;

    if (p < d->waveFracLow)
    {
        return -amplitude; /* held at the bottom */
    }
    p -= d->waveFracLow;

    if (d->waveFracUp <= 0.0f)
    {
        return -amplitude;
    }
    float u = p / d->waveFracUp;
    if (u > 1.0f)
    {
        u = 1.0f; /* the last partial tick of the cycle */
    }
    return -amplitude + (2.0f * amplitude * dev_servo_private_traverse(shape, d->waveRampUp, u));
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
#define DEV_SERVO_PHASE_NUM 1048576U  /* 2^20 */
#define DEV_SERVO_PHASE_DEN 244140625U /* 5^12 */

static uint32_t dev_servo_private_phaseStep(dev_servo_channelData_S *d, uint32_t elapsedUs)
{
    /* Split so that every intermediate OUTSIDE the 64-bit helper fits in 32
     * bits, which is not a style preference: FlexC cannot compile a NAMED
     * 64-bit local (see lib_utility_muldivmod64_unsigned), and this needs to
     * carry a remainder between statements. The helper reaches the P2's CORDIC
     * instead (QMUL then SETQ+QDIV), which is also faster than a software
     * 64-bit divide would have been.
     *
     *     n = freq * elapsed            = q * 5^12 + r
     *     n * 2^20 / 5^12               = q * 2^20 + (r * 2^20 + carry) / 5^12
     */
    uint32_t r = 0U;
    const uint32_t q = lib_utility_muldivmod64_unsigned(d->req.wave.freqMicroHz, elapsedUs,
                                                        DEV_SERVO_PHASE_DEN, &r);
    uint32_t rem = 0U;
    uint32_t qFrac = lib_utility_muldivmod64_unsigned(r, DEV_SERVO_PHASE_NUM,
                                                      DEV_SERVO_PHASE_DEN, &rem);

    /* Carry the fraction this tick could not represent into the next one. Both
     * terms are below 5^12, so the sum cannot overflow and at most one whole
     * unit is ever carried out. */
    uint32_t carried = rem + d->phaseRemainder;
    if (carried >= DEV_SERVO_PHASE_DEN)
    {
        carried -= DEV_SERVO_PHASE_DEN;
        qFrac++;
    }
    d->phaseRemainder = carried;

    /* q is WHOLE cycles per tick. More than one is a waveform that was never
     * sampled at all; feasibility rejects those long before here, so this is a
     * guard against absurd input rather than a working path. */
    if (q >= 4096U)
    {
        return 0xFFFFFFFFU;
    }
    const uint32_t whole = q * DEV_SERVO_PHASE_NUM;
    if (qFrac > (0xFFFFFFFFU - whole))
    {
        return 0xFFFFFFFFU;
    }
    return whole + qFrac;
}

static void dev_servo_private_oscillate(dev_servo_channelData_S *d, float dt, uint32_t elapsedUs,
                                        float *pos, float *vel)
{
    const float phase = (float)d->wavePhase / DEV_SERVO_PHASE_ONE_CYCLE; /* [0,1) */

    /* Advance first, so the tick's END phase is known and the velocity below
     * can be the interval's true average. The wrap IS the cycle boundary --
     * no modulo, no elapsed counter. */
    const uint32_t step = dev_servo_private_phaseStep(d, elapsedUs);
    const uint32_t next = d->wavePhase + step;
    const float nextPhase = (float)next / DEV_SERVO_PHASE_ONE_CYCLE;

    const float excursion = dev_servo_private_waveExcursion(d, phase);
    *pos = (float)d->req.wave.centreCounts + excursion;

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
    *vel = (dev_servo_private_waveExcursion(d, nextPhase) - excursion) / dt;

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
            const int32_t peak = d->req.wave.centreCounts + d->req.wave.amplitudeCounts;
            profileCruise = maxVel;
            profileTarget =
                (d->waveSegment == (uint8_t)DEV_SERVO_WAVE_APPROACH) ? peak : d->req.wave.centreCounts;

            if (d->waveSegment == (uint8_t)DEV_SERVO_WAVE_RUN)
            {
                /* The setpoint is EVALUATED, never integrated: position comes
                 * from the phase, so there is no accumulator to drift and the
                 * ramp-in deficit that velocity mode leaves behind cannot
                 * arise. */
                dev_servo_private_oscillate(d, dt, elapsedUs, &d->setpointPos, &d->setpointVel);
                dev_servo_private_loadSetpoint(d, d->setpointPos);
                evaluated = true;
                if (d->waveCyclesDone >= d->req.wave.cycles)
                {
                    /* Whole cycles done, so the carriage is back at the peak
                     * with its velocity through zero. Stop evaluating HERE:
                     * letting the phase run on past the last cycle leaves a
                     * phantom setpoint walking away from a machine that has
                     * parked, and the following error it opens up is both
                     * published and a fault input. */
                    d->waveSegment = (uint8_t)DEV_SERVO_WAVE_RETURN;
                    dev_servo_private_snapSetpoint(d, peak);
                    d->setpointVel = 0.0f;
                    profileTarget = d->req.wave.centreCounts;
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
            const float posNow =
                (float)d->setpointCounts + ((float)d->setpointNano * 1.0e-9f);
            const float dist = (float)profileTarget - posNow; /* remaining (setpoint frame) */
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

        /* What stage 2 feeds forward, and how far the setpoint moves this tick.
         * The advance is applied AFTER the error is taken, so the loop always
         * compares the machine against the setpoint at the START of the
         * interval -- the convention an evaluated trajectory gets for free. */
        float feedVel = d->setpointVel;
        if (evaluated == false)
        {
            /* Accel-limit the setpoint velocity toward the desired (trapezoid ramp). */
            const float maxDv = (float)cfg->maxAccel * dt;
            float dv = desiredSpVel - d->setpointVel;
            if (dv > maxDv) { dv = maxDv; }
            if (dv < -maxDv) { dv = -maxDv; }
            const float vStart = d->setpointVel;
            d->setpointVel += dv; /* velocity at the END of the interval */
            /* Command the interval AVERAGE, which is exactly the displacement
             * the setpoint makes this tick. Commanding the end velocity instead
             * drives the machine to the end-of-tick setpoint by the tick's
             * START, leaving it one tick of travel AHEAD of its own trajectory
             * -- 5 um at 5 mm/s, 24 um at 25 mm/s. */
            feedVel = 0.5f * (vStart + d->setpointVel);
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

        float cmdVel = feedVel + (kp * error) + iTerm;
        if (cmdVel > maxVel) { cmdVel = maxVel; }
        if (cmdVel < -maxVel) { cmdVel = -maxVel; }

        /* The error and the command are taken; the setpoint may now move on.
         * Before the park, so that parking stays the LAST word on it. */
        if (evaluated == false)
        {
            dev_servo_private_advanceSetpoint(d, feedVel, elapsedUs);
        }

        if (atTarget)
        {
            /* Park: stop pulsing, hold on the stepper's detent torque, snap the
             * setpoint to the target, and bleed the integral so a later move
             * starts clean. A disturbance that pushes past the deadband drops
             * atTarget on the next tick and the loop re-engages. */
            cmdVel = 0.0f;
            d->setpointVel = 0.0f;
            dev_servo_private_snapSetpoint(d, profileTarget);
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

bool dev_servo_waveformFeasible(dev_servo_channel_E ch, const dev_servo_waveform_S *waveform)
{
    if (ch >= DEV_SERVO_CHANNEL_COUNT)
    {
        return false;
    }
    float fracHigh = 0.0f;
    float fracDown = 0.0f;
    float fracLow = 0.0f;
    float fracUp = 0.0f;
    float rampDown = 0.0f;
    float rampUp = 0.0f;
    /* Rejected rather than approximated. Running whatever the limiter allows
     * instead produces data that does not match the request -- on a fatigue
     * test, a specimen that never saw the loading it is reported to have
     * seen. */
    return dev_servo_private_planWaveform(&dev_servo_channelConfig[ch], waveform, &fracHigh,
                                          &fracDown, &fracLow, &fracUp, &rampDown, &rampUp);
}

bool dev_servo_startWaveform(dev_servo_channel_E ch, const dev_servo_waveform_S *waveform)
{
    if (ch >= DEV_SERVO_CHANNEL_COUNT)
    {
        return false;
    }
    float fracHigh = 0.0f;
    float fracDown = 0.0f;
    float fracLow = 0.0f;
    float fracUp = 0.0f;
    float rampDown = 0.0f;
    float rampUp = 0.0f;
    if (!dev_servo_private_planWaveform(&dev_servo_channelConfig[ch], waveform, &fracHigh,
                                        &fracDown, &fracLow, &fracUp, &rampDown, &rampUp))
    {
        return false;
    }

    DEV_SERVO_LOCK_REQ_BLOCK();
    dev_servo_data.channel[ch].req.mode = DEV_SERVO_MODE_OSCILLATE;
    dev_servo_data.channel[ch].req.wave = *waveform;
    dev_servo_data.channel[ch].waveFracHigh = fracHigh;
    dev_servo_data.channel[ch].waveFracDown = fracDown;
    dev_servo_data.channel[ch].waveFracLow = fracLow;
    dev_servo_data.channel[ch].waveFracUp = fracUp;
    dev_servo_data.channel[ch].waveRampDown = rampDown;
    dev_servo_data.channel[ch].waveRampUp = rampUp;
    /* The driver owns the whole manoeuvre: move to the peak, cycle, come back
     * to the centre. So the caller does not have to pre-position the machine,
     * and `atTarget` means the WAVEFORM is done rather than some segment of
     * it -- one completion concept for the whole command. */
    dev_servo_data.channel[ch].req.target = waveform->centreCounts;
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

int32_t dev_servo_getSetpoint(dev_servo_channel_E ch)
{
    if (ch >= DEV_SERVO_CHANNEL_COUNT) { return 0; }
    DEV_SERVO_LOCK_REQ_BLOCK();
    const float sp = dev_servo_data.channel[ch].setpointPos;
    DEV_SERVO_LOCK_REL();
    return (int32_t)((sp < 0.0f) ? (sp - 0.5f) : (sp + 0.5f));
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
