#ifndef DEV_SERVO_H
#define DEV_SERVO_H
//
// Created by Riley McCarthy on 24/06/26.
// @brief Closed-loop position/velocity control of the stepper using the encoder
//        as the single source of truth for position.
// @details Two stages run each tick: a TRAJECTORY GENERATOR shapes a smooth
//          (setpointPos, setpointVel) profile toward the target honouring the
//          commanded feedrate + accel limits (trapezoidal); a FEEDBACK loop then
//          drives the step pin in VELOCITY mode (a commanded pulse frequency) at
//          cmd = setpointVel (feedforward) + Kp*err + Ki*∫err, with err measured
//          against the ENCODER. So the encoder — not a count of emitted pulses —
//          defines where the carriage is, the commanded feedrate is realised
//          (not a slew-to-max), and slip under load is corrected. Run
//          dev_servo_run() at a fixed rate from a dedicated cog.
//
/**********************************************************************
 * Includes
 **********************************************************************/
#include <stdint.h>
#include <stdbool.h>
#include "HAL_pulseOut.h"
#include "HAL_GPIO.h"
#include "HAL_encoder.h"
/**********************************************************************
 * Constants
 **********************************************************************/

/*********************************************************************
 * Macros
 **********************************************************************/

/**********************************************************************
 * Typedefs
 **********************************************************************/
typedef enum
{
    DEV_SERVO_CHANNEL_MAIN,
    DEV_SERVO_CHANNEL_COUNT,
} dev_servo_channel_E;

typedef enum
{
    DEV_SERVO_MODE_IDLE,      /* disabled — no pulses */
    DEV_SERVO_MODE_POSITION,  /* closed-loop to a position target (encoder counts) */
    DEV_SERVO_MODE_VELOCITY,  /* hold a commanded rate — jog and homing ONLY */
    DEV_SERVO_MODE_OSCILLATE, /* track a periodic trajectory about a centre */
} dev_servo_mode_E;

/* The mode names which GENERATOR fills the setpoint, not a different control
 * law: stage 2 is always `cmdVel = setpointVel + Kp*err`, i.e. position held by
 * modulating velocity. That distinction is the whole reason this enum exists.
 *
 * VELOCITY integrates a rate into its own position reference, so it has NO
 * absolute position intent and drifts from any the caller had. That is correct
 * for a jog or a homing seek, where there is no intended position, and wrong
 * for anything analytic — a waveform driven through it loses the ramp-in
 * deficit permanently (Vpeak^2/2a), which is why OSCILLATE exists rather than
 * the APP layer bolting a second position loop on top. */

/* The TRAVERSE profile -- how the carriage gets from one peak to the other --
 * and nothing else. Dwell and skew are separate, orthogonal parameters that
 * apply to every shape, which is what stops this enum having to grow a variant
 * for every combination ("triangle with a hold", "skewed sine", ...).
 *
 * A traverse is a normalised curve s(u), u and s both in [0,1], with ZERO SLOPE
 * AT BOTH ENDS. That end condition is not decoration: it is what lets a cycle
 * be joined, left, or interrupted by a dwell at either peak without a velocity
 * step the machine cannot deliver. */
typedef enum
{
    DEV_SERVO_WAVE_SINE = 0,     /* s(u) = (1 - cos(pi*u))/2 -- smooth, zero jerk at the ends */
    DEV_SERVO_WAVE_TRIANGLE = 1, /* constant rate with ramps: a trapezoidal rate profile */
    /* 2..255 reserved. The wire carries a whole byte so adding one never
     * shifts a bit offset. */
} dev_servo_wave_E;

/* Convert a wire shape byte into a traverse profile this driver implements.
 *
 * Returns false for any byte outside the set above, leaving *shape untouched.
 * The conversion lives here, next to the enum, so the driver stays the single
 * place that decides which profiles exist: a caller that maps an unrecognised
 * byte onto a default of its own turns "this firmware cannot run your test"
 * into a plausible record of a test that was never performed. */
bool dev_servo_waveShapeFromWire(uint8_t wire, dev_servo_wave_E *shape);

/* One oscillation, described completely.
 *
 * A struct rather than eight positional arguments because the call site is
 * where these get transposed, and `startWaveform(ch, 0, 10000, 1000000, 2, 0,
 * 0, 500, SINE)` is unreadable in exactly the way that hides a swapped dwell.
 *
 * THE CYCLE, in phase order from 0:
 *
 *     [ hold at +A ] [ traverse down ] [ hold at -A ] [ traverse up ]
 *        dwellHighUs                      dwellLowUs
 *
 * Phase 0 is the START of the upper hold, which is a velocity zero whether or
 * not that hold has any duration -- so the approach can always join there.
 *
 * `freqMicroHz` is the frequency of the WHOLE cycle including both holds, so
 * one cycle always takes 1/f whatever the dwells are; the holds take time from
 * the traverses, not from the period. */
typedef struct
{
    int32_t centreCounts;    /* the mean the wave swings about                       */
    int32_t amplitudeCounts; /* peak excursion from the centre (not peak-to-peak)     */
    uint32_t freqMicroHz;    /* whole-cycle frequency, microhertz                     */
    uint32_t cycles;         /* whole cycles to run                                   */
    uint32_t dwellHighUs;    /* hold at +A, microseconds (0 = none)                   */
    uint32_t dwellLowUs;     /* hold at -A, microseconds (0 = none)                   */
    uint16_t skewPerMille;   /* of the traversing time, the share spent going DOWN;
                              * 500 is symmetric, 800 is slow-load/fast-unload        */
    dev_servo_wave_E shape;  /* traverse profile                                      */
} dev_servo_waveform_S;

/* The symmetric, dwell-free case -- a plain sinusoid or triangle. */
#define DEV_SERVO_SKEW_SYMMETRIC 500U

/* Per-channel wiring + tuning. All control quantities are in ENCODER COUNTS
 * (counts, counts/s, counts/s^2) so the encoder is the one unit of truth; the
 * APP layer converts mm <-> counts. Gains are fixed-point fractions:
 *   cmd = setpointVel + (kpNum/kpDen)*err + (kiNum/kiDen)*∫err  (counts/s). */
typedef struct
{
    HAL_pulseOut_channel_E pulseChannel;
    HAL_GPIO_channel_E gpioDirection;
    /* The drive's enable input (energized = enabled). Driven by the control
     * loop alone, from dev_servo_enable's state: inactive from init until the
     * actuator is enabled, and again on every path that disables it. */
    HAL_GPIO_channel_E gpioEnable;
    HAL_encoder_channel_E encoderChannel;

    uint32_t loopPeriodUs;     /* nominal control-tick period (must match the cog rate) */
    int32_t maxVelocity;       /* counts/s — hard safety clamp on commanded velocity */
    int32_t maxAccel;          /* counts/s^2 — trajectory accel/decel limit */
    int32_t positionDeadband;  /* counts — within this of target => settled, park.
                                * 8 counts = 0.977 um on the shipped 8192 counts/mm
                                * machine, so a commanded position is reached
                                * inside 1 um. */
    /* How close the approach move must get before the CYCLES may begin.
     *
     * Deliberately tighter than positionDeadband, because the two answer
     * different questions. The deadband stops a parked axis hunting over an
     * encoder count or two while it holds station — a tolerance on staying
     * put. This is a tolerance on STARTING, and whatever it leaves behind is a
     * position error against the requested waveform from its very first
     * sample, which no amount of good tracking afterwards can retract. Handing
     * over at the parking deadband put the first tick of the cycles 16 counts
     * (2 um) off a trajectory the loop then tracked to 0.1 um. */
    int32_t waveformStartTolerance; /* counts */
    int32_t kpNum;             /* proportional gain numerator   (cmd += kpNum*err/kpDen) */
    int32_t kpDen;             /* proportional gain denominator */
    int32_t kiNum;             /* integral gain numerator (1/s^2): cmd += kiNum*∫err/kiDen */
    int32_t kiDen;             /* integral gain denominator (kiNum=0 disables the term) */
    int32_t integralLimit;     /* counts/s — anti-windup clamp on the integral contribution */

    /* Stall guard: two stages, both on the following error alone.
     *
     * The following error is the setpoint minus the encoder, so it measures
     * the one thing a stall is: the carriage not being where the loop is
     * driving it. A jam (dead or buzzing), a carriage that crawls, slips or
     * cannot keep up, and a reversed encoder or drive direction all make it
     * grow; a carriage that follows, however it lags, keeps it bounded.
     *
     * HARD CEILING: |error| above stallCeiling stalls on that tick. It is the
     * runaway case -- a reversed direction, where the loop's own correction
     * drives the carriage further off, or a jam at speed -- so it does not
     * wait. It sits well above the largest error a healthy drive shows, so
     * the coast through a full-speed stop or a reversal, and the lag through
     * an acceleration ramp, never reach it.
     *
     * SOFT BAND: |error| above stallBand for stallBandTicks consecutive ticks
     * stalls too. It is the slow case -- a carriage that moves the right way
     * but stays too far behind, or a jam at a speed too low to reach the
     * ceiling soon. The persistence is what lets the band sit lower than the
     * ceiling: a healthy error passes through it briefly, on a ramp or a
     * stop, and drops back before the time is up.
     *
     * The ceiling (2 mm) and the band (1 mm) are lengths: dev_servo_init
     * converts them to counts with the profile's encoderStepsPerMM, so a
     * 2400 counts/mm encoder trips past 4800 and 2400 counts. Only an
     * unprovisioned profile (encoderStepsPerMM <= 0) keeps the default
     * counts, which are those lengths at 8192 counts/mm.
     *
     * The values are derived from the SIL twin's drive (a 20 ms first-order
     * lag, the shipped 50 mm/s and 600 mm/s^2 profile; see the defaults in
     * dev_servo.c). The real drive's lag has not been measured, so they are
     * placeholders on hardware until it is.
     *
     * A verdict LATCHES: it holds until the drive is disabled (the operator's
     * acknowledgement, in app_control) or its position is redefined
     * (dev_servo_setPosition, which zeroes the error with it). So a runaway
     * that trips the ceiling for one tick is still reported to a reader that
     * only looks every few ticks. */
    int32_t stallCeiling;    /* counts (2 mm via encoderStepsPerMM): |following error| above => stall at once */
    int32_t stallBand;       /* counts (1 mm via encoderStepsPerMM): |following error| above ...              */
    uint32_t stallBandTicks; /* ... for this many consecutive ticks => stall    */
} dev_servo_channelConfig_S;

/**********************************************************************
 * Public Function Definitions
 **********************************************************************/
/* @param maxVelocityCounts, maxAccelCounts  Machine-profile limits, in encoder
 *   counts/s and counts/s^2, that OVERRIDE the compile-time defaults for every
 *   channel. Pass <=0 for either to keep the built-in (gentle) fallback. The
 *   caller owns the mm->counts conversion (limit_mmps * encoderStepsPerMM),
 *   keeping this module unit-agnostic (see the ENCODER COUNTS note above). *
 * @param encoderStepsPerMM, servoStepsPerMM  Machine-profile scales. Their
 *   ratio is how many encoder counts one step pulse moves the carriage: the
 *   drive is pulsed at the commanded counts/s divided by it. Pass <=0 for
 *   either to assume one count per pulse. encoderStepsPerMM also converts the
 *   stall guard's 2 mm ceiling and 1 mm band to counts; <=0 keeps their
 *   8192 counts/mm defaults. */
void dev_servo_init(int lock, int32_t maxVelocityCounts, int32_t maxAccelCounts,
                    int32_t encoderStepsPerMM, int32_t servoStepsPerMM);
void dev_servo_run(void); /* one control tick; call at a fixed rate from a cog */

/* Request the drive enabled or disabled. The next control tick applies it:
 * it drives the enable output (gpioEnable) to match, and while disabled emits
 * no pulses. Disabled is the state from dev_servo_init. */
void dev_servo_enable(dev_servo_channel_E ch, bool enable);
void dev_servo_moveTo(dev_servo_channel_E ch, int32_t targetCounts, int32_t feedrateCountsPerSec); /* closed-loop position at feedrate */
void dev_servo_setVelocity(dev_servo_channel_E ch, int32_t velCountsPerSec);

/* Oscillate about `centreCounts` for `cycles` whole cycles, then stop.
 *
 * The driver owns the phase and advances it on its OWN control tick, so the
 * trajectory is sampled with the same dt that closes the loop. Handing it a
 * setpoint per tick from another cog instead would cross an unsynchronised
 * 1 kHz boundary (app_motion runs on CONTROL, this runs on MOTOR) and write
 * that beat straight into the position reference.
 *
 * Returns false and does nothing if the request is not achievable within the
 * configured maxVelocity/maxAccel — see dev_servo_waveformFeasible. A caller
 * that ignores that gets a profile it did not ask for, which on a fatigue test
 * is a result that does not match the request. */
bool dev_servo_startWaveform(dev_servo_channel_E ch, const dev_servo_waveform_S *waveform);

/* Whether that request fits the envelope, without starting it.
 *
 * Checks EACH traverse separately, because skew and dwell make them different
 * lengths: a cycle can be perfectly achievable in one direction and impossible
 * in the other, and approving it on an average would run a profile the
 * specimen never saw. */
bool dev_servo_waveformFeasible(dev_servo_channel_E ch, const dev_servo_waveform_S *waveform);

/* Whole cycles completed so far; the move is done when this reaches `cycles`. */
uint32_t dev_servo_waveformCyclesDone(dev_servo_channel_E ch); /* closed-loop velocity hold */
void dev_servo_stop(dev_servo_channel_E ch);
void dev_servo_setPosition(dev_servo_channel_E ch, int32_t counts);        /* homing: define encoder reference */

int32_t dev_servo_getPosition(dev_servo_channel_E ch); /* encoder — single source of truth */
int32_t dev_servo_getVelocity(dev_servo_channel_E ch); /* current commanded velocity (counts/s) */
int32_t dev_servo_getFollowingError(dev_servo_channel_E ch); /* setpoint - encoder (counts) */
int32_t dev_servo_getTarget(dev_servo_channel_E ch);         /* current position target (counts) */
/* The trajectory's own commanded position this tick, in counts.
 *
 * Distinct from the target: a target is where a move ENDS, whereas this is
 * where the profile says the machine should be right NOW. For a waveform those
 * are wholly different -- the target is the centre it will finish at, while
 * this traces the wave. It is the number a recorded sample should carry as its
 * setpoint, because it is what the specimen was actually being asked for. */
int32_t dev_servo_getSetpoint(dev_servo_channel_E ch);
/* True only once the control loop has evaluated the CURRENT target and found the
 * encoder settled on it. Any new command (moveTo/setVelocity/stop/setPosition)
 * clears it, so a caller that issues a move and polls this can never see the
 * previous move's "arrived" and retire the new move without moving. */
bool dev_servo_atTarget(dev_servo_channel_E ch);
bool dev_servo_isStalled(dev_servo_channel_E ch);
/* Liveness of the control loop: false until dev_servo_run() has completed a tick,
 * true from then on. APP gates the machine on this,
 * so it must reflect "the MOTOR cog is servicing the actuator" only — a mechanical
 * fault is reported by dev_servo_isStalled, not here. */
bool dev_servo_isReady(dev_servo_channel_E ch);
/**********************************************************************
 * End of File
 **********************************************************************/
#endif /* DEV_SERVO_H */
