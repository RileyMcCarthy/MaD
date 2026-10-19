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

typedef enum
{
    HAL_SERIAL_TYPE_HARDWARE,
    HAL_SERIAL_TYPE_BUILTIN,
    HAL_SERIAL_TYPE_COUNT,
} HAL_serial_type_E;

typedef struct
{
    const HW_pin_E rx;
    const HW_pin_E tx;
    const int32_t baud;
    const HAL_serial_type_E type;
    bool LSB;
} HAL_serial_channelConfig_S;

// we can either abstract using channels or have memory live in a passed struct
// I think using channels is cleaner but we should be mindful of where memory is allocated (should be hub)
// in conclusion, its fine to use channels across cogs, just make sure 1 channel = 1 cog
/**********************************************************************
 * External Variables
 **********************************************************************/

/* Channel wiring/config table. Lives in HAL/Config (data-only, compiled for
 * every target) so the SIL emulator can read the same pin/baud truth the
 * hardware runs — part of the firmware<->emulator contract. */
extern const HAL_serial_channelConfig_S HAL_serial_channelConfig[HAL_SERIAL_CHANNEL_COUNT];

/**********************************************************************
 * Public Function Definitions
 **********************************************************************/

void HAL_serial_start(HAL_serial_channel_E channel);
void HAL_serial_stop(HAL_serial_channel_E channel);
bool HAL_serial_recieveDataTimeout(HAL_serial_channel_E channel, uint8_t *const data, uint32_t len, uint32_t timeout_us);
void HAL_serial_transmitData(HAL_serial_channel_E channel, const uint8_t *const data, const uint32_t len);
bool HAL_serial_recieveByte(HAL_serial_channel_E channel, uint8_t *const data);
/* Burst receive: drains the channel into `buf` (up to maxBytes), returning once
 * the line has been idle for a while or the buffer is full. For the 2 Mbaud
 * protocol channel the first call also hands its RX to an interrupt on the
 * CALLING cog, which catches every byte into a ring however long that cog is
 * busy elsewhere (the smartpin holds only the latest byte, ~5 us at 2 Mbaud);
 * from then on only that cog may read the channel. */
uint32_t HAL_serial_recieveBytes(HAL_serial_channel_E channel, uint8_t *const buf, uint32_t maxBytes);
/**********************************************************************
 * End of File
 **********************************************************************/
#endif /* HAL_SERIAL_H */
