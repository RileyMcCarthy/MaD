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
    DEV_SERVO_MODE_IDLE,     /* disabled — no pulses */
    DEV_SERVO_MODE_POSITION, /* closed-loop to a position target (encoder counts) */
    DEV_SERVO_MODE_VELOCITY, /* hold a commanded velocity (jog / waveform source) */
} dev_servo_mode_E;

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
void dev_servo_setVelocity(dev_servo_channel_E ch, int32_t velCountsPerSec); /* closed-loop velocity hold */
void dev_servo_stop(dev_servo_channel_E ch);
void dev_servo_setPosition(dev_servo_channel_E ch, int32_t counts);        /* homing: define encoder reference */

int32_t dev_servo_getPosition(dev_servo_channel_E ch); /* encoder — single source of truth */
int32_t dev_servo_getVelocity(dev_servo_channel_E ch); /* current commanded velocity (counts/s) */
int32_t dev_servo_getFollowingError(dev_servo_channel_E ch); /* setpoint - encoder (counts) */
int32_t dev_servo_getTarget(dev_servo_channel_E ch);         /* current position target (counts) */
bool dev_servo_atTarget(dev_servo_channel_E ch);
bool dev_servo_isStalled(dev_servo_channel_E ch);
/**********************************************************************
 * End of File
 **********************************************************************/
#endif /* DEV_SERVO_H */
