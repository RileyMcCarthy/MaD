//
// Created by Riley McCarthy on 25/04/24.
//
/**********************************************************************
 * Includes
 **********************************************************************/
#include "IO_fullDuplexSerial.h"
#include "lib_utility.h"
#include <stdlib.h>
#include <string.h>
#include "propeller2.h"
#include "IO_Debug.h"
/**********************************************************************
 * Constants
 **********************************************************************/

/*********************************************************************
 * Macros
 **********************************************************************/
#define IO_FULLDUPLEXSERIAL_LOCK_REQ() _locktry(IO_fullDuplexSerial_data.lock)
#define IO_FULLDUPLEXSERIAL_LOCK_REQ_BLOCK()        \
    while (IO_FULLDUPLEXSERIAL_LOCK_REQ() == false) \
    {                                     \
    }
#define IO_FULLDUPLEXSERIAL_LOCK_REL() _lockrel(IO_fullDuplexSerial_data.lock)
/**********************************************************************
 * Typedefs
 **********************************************************************/
typedef struct
{
    uint32_t rxBufferIndex;
    uint32_t txBufferIndex;
} IO_fullDuplexSerial_channelData_S;

typedef struct
{
    IO_fullDuplexSerial_channelData_S channel[IO_FULLDUPLEXSERIAL_CHANNEL_COUNT];
    int32_t lock;
} IO_fullDuplexSerial_data_S;
/**********************************************************************
 * External Variables
 **********************************************************************/
extern IO_fullDuplexSerial_channelConfig_S IO_fullDuplexSerial_channelConfig[IO_FULLDUPLEXSERIAL_CHANNEL_COUNT];
/**********************************************************************
 * Private Variable Definitions
 **********************************************************************/
static IO_fullDuplexSerial_data_S IO_fullDuplexSerial_data;
/**********************************************************************
 * Private Function Prototypes
 **********************************************************************/

/**********************************************************************
 * Private Function Definitions
 **********************************************************************/

/**********************************************************************
 * Public Function Definitions
 **********************************************************************/

void IO_fullDuplexSerial_init(int32_t lock)
{
    IO_fullDuplexSerial_data.lock = lock;
    for (IO_fullDuplexSerial_channel_E channel = 0; channel < IO_FULLDUPLEXSERIAL_CHANNEL_COUNT; channel++)
    {
        HAL_serial_start(IO_fullDuplexSerial_channelConfig[channel].hardwareSerialChannel);
    }
}

void IO_fullDuplexSerial_run(void)
{
    for (IO_fullDuplexSerial_channel_E channel = 0; channel < IO_FULLDUPLEXSERIAL_CHANNEL_COUNT; channel++)
    {
        IO_FULLDUPLEXSERIAL_LOCK_REQ_BLOCK();
        if (IO_fullDuplexSerial_data.channel[channel].txBufferIndex > 0)
        {
            HAL_serial_transmitData(IO_fullDuplexSerial_channelConfig[channel].hardwareSerialChannel, IO_fullDuplexSerial_channelConfig[channel].txBuffer, IO_fullDuplexSerial_data.channel[channel].txBufferIndex);
            IO_fullDuplexSerial_data.channel[channel].txBufferIndex = 0;
        }
        if (IO_fullDuplexSerial_data.channel[channel].rxBufferIndex < IO_fullDuplexSerial_channelConfig[channel].rxBufferSize)
        {
            if (HAL_serial_recieveByte(IO_fullDuplexSerial_channelConfig[channel].hardwareSerialChannel, &IO_fullDuplexSerial_channelConfig[channel].rxBuffer[IO_fullDuplexSerial_data.channel[channel].rxBufferIndex]))
            {
                IO_fullDuplexSerial_data.channel[channel].rxBufferIndex++;
            }
        }
        else
        {
            // TODO: Handle overflow
        }
        IO_FULLDUPLEXSERIAL_LOCK_REL();
    }
}

bool IO_fullDuplexSerial_send(IO_fullDuplexSerial_channel_E channel, const uint8_t *data, uint32_t length)
{
    bool result = false;
    if (channel < IO_FULLDUPLEXSERIAL_CHANNEL_COUNT)
    {
        IO_FULLDUPLEXSERIAL_LOCK_REQ_BLOCK();
        if ((IO_fullDuplexSerial_data.channel[channel].txBufferIndex + length) < IO_fullDuplexSerial_channelConfig[channel].txBufferSize)
        {
            memcpy(&IO_fullDuplexSerial_channelConfig[channel].txBuffer[IO_fullDuplexSerial_data.channel[channel].txBufferIndex], data, length);
            IO_fullDuplexSerial_data.channel[channel].txBufferIndex += length;
            result = true;
        }
        else
        {
            // TODO: Handle overflow
            DEBUG_ERROR("Overflow on channel %d\n", channel);
        }
        IO_FULLDUPLEXSERIAL_LOCK_REL();
    }
    return result;
}

bool IO_fullDuplexSerial_receive(IO_fullDuplexSerial_channel_E channel, uint8_t *data, uint32_t maxLength)
{
    bool result = false;
    if (channel < IO_FULLDUPLEXSERIAL_CHANNEL_COUNT)
    {
        IO_FULLDUPLEXSERIAL_LOCK_REQ_BLOCK();
        if (IO_fullDuplexSerial_data.channel[channel].rxBufferIndex > 0)
        {
            // copy data from rx buffer then shift buffer to the left
            const uint32_t length = LIB_UTILITY_MIN(maxLength, IO_fullDuplexSerial_data.channel[channel].rxBufferIndex);
            memcpy(data, &IO_fullDuplexSerial_channelConfig[channel].rxBuffer[0], length);
            memmove(&IO_fullDuplexSerial_channelConfig[channel].rxBuffer[0], &IO_fullDuplexSerial_channelConfig[channel].rxBuffer[length], IO_fullDuplexSerial_data.channel[channel].rxBufferIndex - length);
            IO_fullDuplexSerial_data.channel[channel].rxBufferIndex -= length;
            //DEBUG_INFO("IO_fullDuplexSerial_receive: %d\n", length);
            result = true;
        }
        IO_FULLDUPLEXSERIAL_LOCK_REL();
    }
    return result;
}

uint32_t IO_fullDuplexSerial_available(IO_fullDuplexSerial_channel_E channel)
{
    return IO_fullDuplexSerial_data.channel[channel].rxBufferIndex;
}

/**********************************************************************
 * End of File
 **********************************************************************/
