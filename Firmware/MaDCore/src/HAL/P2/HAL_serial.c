//
// Created by Riley McCarthy on 25/04/24.
//
/**********************************************************************
 * Includes
 **********************************************************************/
#include "HAL_serial.h"

#include "smartpins.h"
#include "propeller2.h"
#include <stdlib.h>
#include <unistd.h>
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

/**********************************************************************
 * External Variables
 **********************************************************************/

/**********************************************************************
 * Private Variable Definitions
 **********************************************************************/
static HAL_serial_channelConfig_S HAL_serial_channelConfig[HAL_SERIAL_CHANNEL_COUNT] = {
    {HW_PIN_FORCE_GAUGE_RX, HW_PIN_FORCE_GAUGE_TX, 115200, HAL_SERIAL_TYPE_HARDWARE, false}, // FORCE_GAUGE
#if ENABLE_DEBUG_SERIAL
    // leave the MAIN_RX and MAIN_TX open for debug serial
    {HW_PIN_RPI_RX, HW_PIN_RPI_TX, 230400, HAL_SERIAL_TYPE_HARDWARE, false}, // MAIN
#else
    {HW_PIN_MAIN_RX, HW_PIN_MAIN_TX, 230400, HAL_SERIAL_TYPE_BUILTIN, false}, // MAIN
#endif
};
/**********************************************************************
 * Private Function Prototypes
 **********************************************************************/

/**********************************************************************
 * Private Function Definitions
 **********************************************************************/

void HAL_serial_private_TXFlush(HAL_serial_channel_E channel)
{
    // flush the transmit buffer
    switch (HAL_serial_channelConfig[channel].type)
    {
        case HAL_SERIAL_TYPE_HARDWARE:
            while (_pinr(HAL_serial_channelConfig[channel].tx) == 0)
                ;
            break;
        case HAL_SERIAL_TYPE_BUILTIN:
        default:
            break;
    }
}

static inline bool HAL_serial_private_readByte(HAL_serial_channel_E channel, uint8_t *const byte)
{
    int32_t tmp = -1;
    switch (HAL_serial_channelConfig[channel].type)
    {
        case HAL_SERIAL_TYPE_HARDWARE:
            if (_pinr(HAL_serial_channelConfig[channel].rx) != 0)
            {
                *byte = (_rdpin(HAL_serial_channelConfig[channel].rx) >> 24);
                return true;
            }
            else
            {
                return false;
            }
        case HAL_SERIAL_TYPE_BUILTIN:
            tmp = _rxpoll();
            if (tmp != -1)
            {
                *byte = tmp;
                return true;
            }
            else
            {
                return false;
            }
        default:
            return 0U;
    }
}

static inline void HAL_serial_private_writeByte(HAL_serial_channel_E channel, uint8_t byte)
{
    if (HAL_serial_channelConfig[channel].LSB)
    {
        // P2 sends MSB first, if LSB is true, we need to swap the bits
        byte = (__builtin_bitreverse32(byte) >> 24) & 0xFF;
    }
    switch (HAL_serial_channelConfig[channel].type)
    {
        case HAL_SERIAL_TYPE_HARDWARE:
            _wypin(HAL_serial_channelConfig[channel].tx, byte);
            break;
        case HAL_SERIAL_TYPE_BUILTIN:
            _txraw(byte);
            break;
        default:
            break;
    }
}

/**********************************************************************
 * Public Function Definitions
 **********************************************************************/

void HAL_serial_start(HAL_serial_channel_E channel)
{
    if (channel < HAL_SERIAL_CHANNEL_COUNT)
    {
        switch (HAL_serial_channelConfig[channel].type)
        {
            case HAL_SERIAL_TYPE_HARDWARE:
            {
                // calculate delay between bits
                const int32_t bitPeriod = (_clockfreq() / HAL_serial_channelConfig[channel].baud);

                // calculate smartpin mode for 8 bits per character
                const int32_t bitMode = 7 + (bitPeriod << 16);

                // set up the transmit pin
                _pinstart(HAL_serial_channelConfig[channel].tx, P_OE | P_ASYNC_TX, bitMode, 0);

                // set up the receive pin
                _pinstart(HAL_serial_channelConfig[channel].rx, P_ASYNC_RX, bitMode, 0);
            }
            break;
        case HAL_SERIAL_TYPE_BUILTIN:
            _setbaud(HAL_serial_channelConfig[channel].baud);
        default:
            break;
        }
    }
}

void HAL_serial_stop(HAL_serial_channel_E channel)
{
    if (channel < HAL_SERIAL_CHANNEL_COUNT)
    {
        // turn off the smartpin
        switch(HAL_serial_channelConfig[channel].type)
        {
            case HAL_SERIAL_TYPE_HARDWARE:
                _pinclear(HAL_serial_channelConfig[channel].rx);
                _pinclear(HAL_serial_channelConfig[channel].tx);
                break;
            case HAL_SERIAL_TYPE_BUILTIN:
                // do not disable the serial port
                break;
        }
    }
}

void HAL_serial_transmitData(HAL_serial_channel_E channel, const uint8_t *const data, const uint32_t len)
{
    if (channel < HAL_SERIAL_CHANNEL_COUNT)
    {
        for (uint32_t i = 0; i < len; i++)
        {
            HAL_serial_private_writeByte(channel, data[i]);
            // wait for the byte to be sent
            HAL_serial_private_TXFlush(channel);
        }
    }
}

bool HAL_serial_recieveDataTimeout(HAL_serial_channel_E channel, uint8_t *const data, uint32_t len, uint32_t timeout_us)
{
    if ((channel < HAL_SERIAL_CHANNEL_COUNT) && (data != NULL))
    {
        // wait for the byte to be received
        const int32_t startTime = _getus();
        for (uint32_t i = 0; i < len; i++)
        {
            uint8_t byte = 0U;
            while (HAL_serial_recieveByte(channel, &byte) == false)
            {
                if ((_getus() - startTime) > timeout_us)
                {
                    return false;
                }
            }
            data[i] = byte;
        }
        return true;
    }
    return false;
}

bool HAL_serial_recieveByte(HAL_serial_channel_E channel, uint8_t *const byte)
{
    bool result = false;
    if (channel < HAL_SERIAL_CHANNEL_COUNT)
    {
        result = HAL_serial_private_readByte(channel, byte);
    }
    return result;
}

/**********************************************************************
 * End of File
 **********************************************************************/
