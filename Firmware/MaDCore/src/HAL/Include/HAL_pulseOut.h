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
/**********************************************************************
 * Public Function Definitions
 **********************************************************************/

void HAL_pulseOut_start(HAL_pulseOut_channel_E channel, uint32_t pulses, uint32_t frequency);
bool HAL_pulseOut_run(HAL_pulseOut_channel_E channel, uint32_t *pulses);
void HAL_pulseOut_stop(HAL_pulseOut_channel_E channel);
/**********************************************************************
 * End of File
 **********************************************************************/
#endif /* HAL_PULSE_OUT_H */
