//
// Created by Riley McCarthy on 25/04/24.
//
/**********************************************************************
 * Includes
 **********************************************************************/
#include "HAL_serial.h"

#include "smartpins.h"
#include "propeller2.h"
#include "SocketIO.h"
#include <stdlib.h>
#include "IO_Debug.h"
/**********************************************************************
 * Constants
 **********************************************************************/

/*********************************************************************
 * Macros
 **********************************************************************/

/**********************************************************************
 * Typedefs
 **********************************************************************/
typedef struct
{
    const HW_pin_E rx;
    const HW_pin_E tx;
    const int32_t baud;
} HAL_serial_channelConfig_S;

typedef struct
{
    int32_t rxSocketID;
    int32_t txSocketID;
} HAL_serial_channelData_S;

/**********************************************************************
 * External Variables
 **********************************************************************/

/**********************************************************************
 * Private Variable Definitions
 **********************************************************************/
static HAL_serial_channelConfig_S HAL_serial_channelConfig[HAL_SERIAL_CHANNEL_COUNT] = {
    {HW_PIN_FORCE_GAUGE_RX, HW_PIN_FORCE_GAUGE_TX, 115200}, // FORCE_GAUGE
#if ENABLE_DEBUG_SERIAL
    // leave the MAIN_RX and MAIN_TX open for debug serial
    {HW_PIN_RPI_RX, HW_PIN_RPI_TX, 230400}, // MAIN
#else
    {HW_PIN_MAIN_RX, HW_PIN_MAIN_TX, 230400}, // MAIN/DEBUG
#endif
};

static HAL_serial_channelData_S HAL_serial_channelData[HAL_SERIAL_CHANNEL_COUNT];
/**********************************************************************
 * Private Function Prototypes
 **********************************************************************/

/**********************************************************************
 * Private Function Definitions
 **********************************************************************/

/**********************************************************************
 * Public Function Definitions
 **********************************************************************/

void HAL_serial_start(HAL_serial_channel_E channel)
{
    if (channel < HAL_SERIAL_CHANNEL_COUNT)
    {
        HAL_serial_channelData[channel].rxSocketID = get_pin_socketid(HAL_serial_channelConfig[channel].rx);
        HAL_serial_channelData[channel].txSocketID = get_pin_socketid(HAL_serial_channelConfig[channel].tx);
    }
}

void HAL_serial_stop(HAL_serial_channel_E channel)
{
    // socket stays open, do nothing
}

void HAL_serial_transmitData(HAL_serial_channel_E channel, const uint8_t *const data, const uint32_t len)
{
    if (channel < HAL_SERIAL_CHANNEL_COUNT)
    {
        socketio_send_data(HAL_serial_channelData[channel].txSocketID, data, len);
    }
}

bool HAL_serial_recieveDataTimeout(HAL_serial_channel_E channel, uint8_t *const data, uint32_t len, uint32_t timeout_us)
{
    int32_t bytes_received = 0;
    if ((channel < HAL_SERIAL_CHANNEL_COUNT) && (data != NULL))
    {
        bytes_received = socketio_receiveTimeout(HAL_serial_channelData[channel].rxSocketID, data, len, timeout_us);
    }
    return bytes_received == len;
}

bool HAL_serial_recieveByte(HAL_serial_channel_E channel, uint8_t *const byte)
{
    bool result = false;
    if (channel < HAL_SERIAL_CHANNEL_COUNT)
    {
        uint8_t data = 0U;
        //DEBUG_INFO("HAL_serial_recieveByte: %d\n", HAL_serial_channelData[channel].rxSocketID);
        if (socketio_receive(HAL_serial_channelData[channel].rxSocketID, &data, 1) == 1)
        {
            //DEBUG_INFO("HAL_serial_recieveByte: %d\n", data);
            *byte = data;
            result = true;
        }
    }
    return result;
}

/**********************************************************************
 * End of File
 **********************************************************************/
