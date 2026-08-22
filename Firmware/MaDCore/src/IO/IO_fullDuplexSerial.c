//
// Created by Riley McCarthy on 25/04/24.
//
/**********************************************************************
 * Includes
 **********************************************************************/
#include "IO_fullDuplexSerial.h"
#include "lib_staticQueue.h"
#include <stdlib.h>
#include <stdbool.h>
#include "IO_Debug.h"
/**********************************************************************
 * Constants
 **********************************************************************/

/* Chunk size for the HAL burst receive. Must hold the largest inbound protocol
 * frame (machine_configuration_write = 70 bytes) so a full frame is captured in
 * one tight drain before any byte is enqueued. */
#define IO_FULLDUPLEXSERIAL_RX_CHUNK (128U)

/*********************************************************************
 * Macros
 **********************************************************************/

/**********************************************************************
 * Typedefs
 **********************************************************************/
typedef struct
{
    /* Lock-free SPSC rings: the SERIAL cog is the sole producer of rxQueue and
     * sole consumer of txQueue; the COMMUNICATION cog is the sole consumer of
     * rxQueue and sole producer of txQueue. No lock is needed (see
     * lib_staticQueue concurrency contract). */
    lib_staticQueue_S rxQueue;
    lib_staticQueue_S txQueue;
} IO_fullDuplexSerial_channelData_S;

typedef struct
{
    IO_fullDuplexSerial_channelData_S channel[IO_FULLDUPLEXSERIAL_CHANNEL_COUNT];
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
    (void)lock; /* SPSC rings are lock-free; no lock required */
    for (IO_fullDuplexSerial_channel_E channel = 0; channel < IO_FULLDUPLEXSERIAL_CHANNEL_COUNT; channel++)
    {
        lib_staticQueue_init(&IO_fullDuplexSerial_data.channel[channel].rxQueue,
                             IO_fullDuplexSerial_channelConfig[channel].rxBuffer,
                             (int)IO_fullDuplexSerial_channelConfig[channel].rxBufferSize, 1);
        lib_staticQueue_init(&IO_fullDuplexSerial_data.channel[channel].txQueue,
                             IO_fullDuplexSerial_channelConfig[channel].txBuffer,
                             (int)IO_fullDuplexSerial_channelConfig[channel].txBufferSize, 1);
        HAL_serial_start(IO_fullDuplexSerial_channelConfig[channel].hardwareSerialChannel);
    }
}

void IO_fullDuplexSerial_run(void)
{
    for (IO_fullDuplexSerial_channel_E channel = 0; channel < IO_FULLDUPLEXSERIAL_CHANNEL_COUNT; channel++)
    {
        const HAL_serial_channel_E hw = IO_fullDuplexSerial_channelConfig[channel].hardwareSerialChannel;
        lib_staticQueue_S *const rxQueue = &IO_fullDuplexSerial_data.channel[channel].rxQueue;
        lib_staticQueue_S *const txQueue = &IO_fullDuplexSerial_data.channel[channel].txQueue;
        static uint8_t rxChunk[IO_FULLDUPLEXSERIAL_RX_CHUNK];

        /* Receive: burst-drain everything currently on the wire into the rx ring.
         * HAL_serial_recieveBytes spins across inter-byte gaps internally (its
         * idle budget covers one ~5 us byte time at 2 Mbaud), so a single call
         * captures a whole frame gaplessly; the do/while handles frames larger
         * than one chunk. Enqueue happens off that hot path. */
        uint32_t got;
        do
        {
            got = HAL_serial_recieveBytes(hw, rxChunk, IO_FULLDUPLEXSERIAL_RX_CHUNK);
            for (uint32_t i = 0U; i < got; i++)
            {
                (void)lib_staticQueue_push(rxQueue, &rxChunk[i]);
            }
        } while (got == IO_FULLDUPLEXSERIAL_RX_CHUNK);

        /* Transmit: drain any queued bytes to the UART. */
        uint8_t txByte;
        while (lib_staticQueue_pop(txQueue, &txByte))
        {
            HAL_serial_transmitData(hw, &txByte, 1U);
        }
    }
}

bool IO_fullDuplexSerial_send(IO_fullDuplexSerial_channel_E channel, const uint8_t *data, uint32_t length)
{
    bool result = false;
    if ((channel < IO_FULLDUPLEXSERIAL_CHANNEL_COUNT) && (data != NULL))
    {
        lib_staticQueue_S *const txQueue = &IO_fullDuplexSerial_data.channel[channel].txQueue;
        result = true;
        for (uint32_t i = 0U; i < length; i++)
        {
            if (!lib_staticQueue_push(txQueue, (void *)&data[i]))
            {
                DEBUG_ERROR("Overflow on channel %d\n", channel);
                result = false;
                break;
            }
        }
    }
    return result;
}

bool IO_fullDuplexSerial_receive(IO_fullDuplexSerial_channel_E channel, uint8_t *data, uint32_t maxLength)
{
    bool result = false;
    if ((channel < IO_FULLDUPLEXSERIAL_CHANNEL_COUNT) && (data != NULL))
    {
        lib_staticQueue_S *const rxQueue = &IO_fullDuplexSerial_data.channel[channel].rxQueue;
        for (uint32_t i = 0U; i < maxLength; i++)
        {
            if (!lib_staticQueue_pop(rxQueue, &data[i]))
            {
                break;
            }
            result = true;
        }
    }
    return result;
}

uint32_t IO_fullDuplexSerial_available(IO_fullDuplexSerial_channel_E channel)
{
    uint32_t available = 0U;
    if (channel < IO_FULLDUPLEXSERIAL_CHANNEL_COUNT)
    {
        available = (uint32_t)lib_staticQueue_count(&IO_fullDuplexSerial_data.channel[channel].rxQueue);
    }
    return available;
}

/**********************************************************************
 * End of File
 **********************************************************************/
