#ifndef HAL_SERIAL_H
#define HAL_SERIAL_H
//
// Created by Riley McCarthy on 19/10/24.
// @brief Non threadsafe implementation of serial control, direct hardware access without buffering
//
/**********************************************************************
 * Includes
 **********************************************************************/
#include <stdint.h>
#include <stdbool.h>

#include "HW_pins.h"
/**********************************************************************
 * Constants
 **********************************************************************/

/*********************************************************************
 * Macros
 **********************************************************************/
#ifndef ENABLE_DEBUG_SERIAL
#define ENABLE_DEBUG_SERIAL 0
#endif
/**********************************************************************
 * Typedefs
 **********************************************************************/

typedef enum
{
    HAL_SERIAL_CHANNEL_FORCE_GAUGE,
    HAL_SERIAL_CHANNEL_MAIN,
    HAL_SERIAL_CHANNEL_COUNT,
} HAL_serial_channel_E;

// we can either abstract using channels or have memory live in a passed struct
// I think using channels is cleaner but we should be mindful of where memory is allocated (should be hub)
// in conclusion, its fine to use channels across cogs, just make sure 1 channel = 1 cog
/**********************************************************************
 * Public Function Definitions
 **********************************************************************/

void HAL_serial_start(HAL_serial_channel_E channel);
void HAL_serial_stop(HAL_serial_channel_E channel);
bool HAL_serial_recieveDataTimeout(HAL_serial_channel_E channel, uint8_t *const data, uint32_t len, uint32_t timeout_us);
void HAL_serial_transmitData(HAL_serial_channel_E channel, const uint8_t *const data, const uint32_t len);
bool HAL_serial_recieveByte(HAL_serial_channel_E channel, uint8_t *const data);
/**********************************************************************
 * End of File
 **********************************************************************/
#endif /* HAL_SERIAL_H */
