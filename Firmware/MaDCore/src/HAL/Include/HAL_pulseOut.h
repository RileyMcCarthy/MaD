#ifndef HAL_PULSE_OUT_H
#define HAL_PULSE_OUT_H
//
// Created by Riley McCarthy on 25/04/24.
// @brief Non threadsafe implementation of hardware PWM out
//
/**********************************************************************
 * Includes
 **********************************************************************/
#include "HW_pins.h"
#include <stdbool.h>
#include <stdint.h>
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
    HAL_PULSE_OUT_CHANNEL_SERVO,
    HAL_PULSE_OUT_CHANNEL_COUNT,
} HAL_pulseOut_channel_E;

typedef struct
{
    const uint32_t maxHardwareClockCyclePerStep;
    const uint8_t pin;
} HAL_pulseOut_channelConfig_S;

/**********************************************************************
 * External Variables
 **********************************************************************/

/* Channel wiring/config table. Lives in HAL/Config (data-only, compiled for
 * every target) so the SIL emulator can read the same pin truth the hardware
 * runs — part of the firmware<->emulator contract. */
extern const HAL_pulseOut_channelConfig_S HAL_pulseOut_channelConfig[HAL_PULSE_OUT_CHANNEL_COUNT];

/**********************************************************************
 * Public Function Definitions
 **********************************************************************/

void HAL_pulseOut_start(HAL_pulseOut_channel_E channel, uint32_t pulses, uint32_t frequency);
bool HAL_pulseOut_run(HAL_pulseOut_channel_E channel, uint32_t *pulses);
void HAL_pulseOut_stop(HAL_pulseOut_channel_E channel);

/* Continuous (NCO) velocity output. `startVelocity` begins an unbounded pulse
 * train at `frequency` (steps/s) and resets the emitted counter (read via
 * HAL_pulseOut_run); call it again to re-baseline (e.g. after a direction
 * reversal). `setFrequency` retargets the rate on the fly without resetting the
 * emitted counter (glitch-free). In velocity mode HAL_pulseOut_run reports the
 * cumulative emitted count and never signals completion. */
void HAL_pulseOut_startVelocity(HAL_pulseOut_channel_E channel, uint32_t frequency);
void HAL_pulseOut_setFrequency(HAL_pulseOut_channel_E channel, uint32_t frequency);
/**********************************************************************
 * End of File
 **********************************************************************/
#endif /* HAL_PULSE_OUT_H */
