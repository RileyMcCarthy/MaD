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
//          (not a slew-to-max), and slip under load is corrected. This replaces
//          the open-loop "emit N steps and assume we arrived" model of
//          dev_stepper. Run dev_servo_run() at a fixed rate from a dedicated cog.
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

typedef enum
{
    DEV_SERVO_WAVE_SINE = 0,
    DEV_SERVO_WAVE_TRIANGLE = 1,
} dev_servo_wave_E;

/* Per-channel wiring + tuning. All control quantities are in ENCODER COUNTS
 * (counts, counts/s, counts/s^2) so the encoder is the one unit of truth; the
 * APP layer converts mm <-> counts. Gains are fixed-point fractions:
 *   cmd = setpointVel + (kpNum/kpDen)*err + (kiNum/kiDen)*∫err  (counts/s). */
typedef struct
{
    HAL_pulseOut_channel_E pulseChannel;
    HAL_GPIO_channel_E gpioDirection;
    HAL_encoder_channel_E encoderChannel;

    uint32_t loopPeriodUs;     /* nominal control-tick period (must match the cog rate) */
    int32_t maxVelocity;       /* counts/s — hard safety clamp on commanded velocity */
    int32_t maxAccel;          /* counts/s^2 — trajectory accel/decel limit */
    int32_t positionDeadband;  /* counts — within this of target => settled, park */
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

    /* Stall guard: if |commandedVel| exceeds stallVelocity but the encoder moves
     * less than stallMinMove counts for stallTicks consecutive ticks, flag a stall. */
    int32_t stallVelocity;     /* counts/s */
    int32_t stallMinMove;      /* counts per tick */
    uint32_t stallTicks;
} dev_servo_channelConfig_S;

/**********************************************************************
 * Public Function Definitions
 **********************************************************************/
/* @param maxVelocityCounts, maxAccelCounts  Machine-profile limits, in encoder
 *   counts/s and counts/s^2, that OVERRIDE the compile-time defaults for every
 *   channel. Pass <=0 for either to keep the built-in (gentle) fallback. The
 *   caller owns the mm->counts conversion (limit_mmps * encoderStepsPerMM),
 *   keeping this module unit-agnostic (see the ENCODER COUNTS note above). */
void dev_servo_init(int lock, int32_t maxVelocityCounts, int32_t maxAccelCounts);
void dev_servo_run(void); /* one control tick; call at a fixed rate from a cog */

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
bool dev_servo_startWaveform(dev_servo_channel_E ch,
                             int32_t centreCounts,
                             int32_t amplitudeCounts,
                             uint32_t freqMicroHz,
                             uint32_t cycles,
                             dev_servo_wave_E shape);

/* Whether that request fits the envelope, without starting it. */
bool dev_servo_waveformFeasible(dev_servo_channel_E ch,
                                int32_t amplitudeCounts,
                                uint32_t freqMicroHz,
                                dev_servo_wave_E shape);

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
 * true from then on (mirrors dev_stepper_isReady). APP gates the machine on this,
 * so it must reflect "the MOTOR cog is servicing the actuator" only — a mechanical
 * fault is reported by dev_servo_isStalled, not here. */
bool dev_servo_isReady(dev_servo_channel_E ch);
/**********************************************************************
 * End of File
 **********************************************************************/
#endif /* DEV_SERVO_H */
