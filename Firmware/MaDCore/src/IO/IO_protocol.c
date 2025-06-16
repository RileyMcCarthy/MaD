//
// Created by Riley McCarthy on 25/04/24.
//
/**********************************************************************
 * Includes
 **********************************************************************/
#include "IO_protocol.h"
#include "IO_Debug.h"
#include "IO_fullDuplexSerial.h"
#include "lib_utility.h"
#include <propeller2.h>
#include <string.h>
/**********************************************************************
 * Constants
 **********************************************************************/

/*********************************************************************
 * Macros
 **********************************************************************/
#define IO_PROTOCOL_RECIEVE_TIMEOUT_MS 100U
/**********************************************************************
 * Typedefs
 **********************************************************************/

typedef enum
{
    IO_PROTOCOL_RECIEVE_STATE_SYNC,
    IO_PROTOCOL_RECIEVE_STATE_TYPE,
    IO_PROTOCOL_RECIEVE_STATE_COMMAND,
    IO_PROTOCOL_RECIEVE_STATE_LENGTH,
    IO_PROTOCOL_RECIEVE_STATE_DATA,
    IO_PROTOCOL_RECIEVE_STATE_CRC,
    IO_PROTOCOL_RECIEVE_STATE_COUNT,
} IO_protocol_recieveState_E;

typedef struct
{
    uint32_t startms;
    IO_protocol_incommingType_E type;
    uint8_t command;
    uint16_t dataLength;
    uint16_t dataIndex;
    uint8_t crc;
    IO_protocol_recieveState_E state;
} IO_protocol_recieve_S;

typedef struct
{
    IO_protocol_recieve_S recieve;
} IO_protocol_data_S;
/**********************************************************************
 * External Variables
 **********************************************************************/

/**********************************************************************
 * Private Variable Definitions
 **********************************************************************/
IO_protocol_data_S IO_protocol_data;
/**********************************************************************
 * Private Function Prototypes
 **********************************************************************/

/**********************************************************************
 * Private Function Definitions
 **********************************************************************/

static bool IO_protocol_private_timeout(void)
{
    return ((_getms() - IO_PROTOCOL_RECIEVE_TIMEOUT_MS) > IO_protocol_data.recieve.startms);
}

static bool IO_protocol_private_recieveByte(uint8_t *byte)
{
    return IO_fullDuplexSerial_receive(IO_FULLDUPLEXSERIAL_CHANNEL_MAIN, byte, 1U);;
}

bool IO_protocol_private_recieveSync()
{
    uint8_t sync = 0U;
    bool ret = false;
    if (IO_protocol_private_recieveByte(&sync))
    {
        ret = (sync == 0x55);
    }
    return ret;
}

/**********************************************************************
 * Public Function Definitions
 **********************************************************************/

void IO_protocol_init()
{
}

IO_protocol_incommingType_E IO_protocol_recieveRequest(IO_protocol_readType_E *readType, IO_protocol_writeType_E *writeType, void *data, uint32_t *size, const uint16_t maxSize)
{
    IO_protocol_incommingType_E incommingType = IO_PROTOCOL_INCOMMING_TYPE_NONE;
    switch (IO_protocol_data.recieve.state)
    {
    case IO_PROTOCOL_RECIEVE_STATE_SYNC:
        if (IO_protocol_private_recieveSync())
        {
            IO_protocol_data.recieve.state = IO_PROTOCOL_RECIEVE_STATE_TYPE;
            IO_protocol_data.recieve.startms = _getms();
        }
        break;
    case IO_PROTOCOL_RECIEVE_STATE_TYPE:
        if (IO_protocol_private_recieveByte((uint8_t *)&IO_protocol_data.recieve.type))
        {
            IO_protocol_data.recieve.state = IO_PROTOCOL_RECIEVE_STATE_COMMAND;
        }
        else if (IO_protocol_private_timeout())
        {
            IO_protocol_data.recieve.state = IO_PROTOCOL_RECIEVE_STATE_SYNC;
        }
        break;
    case IO_PROTOCOL_RECIEVE_STATE_COMMAND:
        if (IO_protocol_private_recieveByte(&IO_protocol_data.recieve.command))
        {
            if (IO_protocol_data.recieve.type == IO_PROTOCOL_INCOMMING_TYPE_READ)
            {
                incommingType = IO_PROTOCOL_INCOMMING_TYPE_READ;
                *readType = IO_protocol_data.recieve.command;
                IO_protocol_data.recieve.state = IO_PROTOCOL_RECIEVE_STATE_SYNC;
            }
            else if (IO_protocol_data.recieve.type == IO_PROTOCOL_INCOMMING_TYPE_WRITE)
            {
                IO_protocol_data.recieve.state = IO_PROTOCOL_RECIEVE_STATE_LENGTH;
            }
        }
        else if (IO_protocol_private_timeout())
        {
            IO_protocol_data.recieve.state = IO_PROTOCOL_RECIEVE_STATE_SYNC;
        }
        break;
    case IO_PROTOCOL_RECIEVE_STATE_LENGTH:
        if (IO_fullDuplexSerial_available(IO_FULLDUPLEXSERIAL_CHANNEL_MAIN) > 2U)
        {
            uint8_t bytes[2];
            bool recieveSuccess = IO_protocol_private_recieveByte(&bytes[0]);
            recieveSuccess &= IO_protocol_private_recieveByte(&bytes[1]);
            if (recieveSuccess)
            {
                const uint16_t dataLength = bytes[0] | (bytes[1] << 8);
                IO_protocol_data.recieve.dataLength = LIB_UTILITY_LIMIT(dataLength, 0U, maxSize);
                IO_protocol_data.recieve.state = IO_PROTOCOL_RECIEVE_STATE_DATA;
                IO_protocol_data.recieve.dataIndex = 0U;
                DEBUG_INFO("Recieved data length: %d\n", IO_protocol_data.recieve.dataLength);
            }
            else
            {
                // this really shouldnt happen
                DEBUG_ERROR("%s","Failed to recieve data length\n");
                IO_protocol_data.recieve.state = IO_PROTOCOL_RECIEVE_STATE_SYNC;
            }
        }
        else if (IO_protocol_private_timeout())
        {
            IO_protocol_data.recieve.state = IO_PROTOCOL_RECIEVE_STATE_SYNC;
        }
        break;
    case IO_PROTOCOL_RECIEVE_STATE_DATA:
        while (IO_fullDuplexSerial_available(IO_FULLDUPLEXSERIAL_CHANNEL_MAIN) > 0)
        {
            const uint16_t index = LIB_UTILITY_LIMIT(IO_protocol_data.recieve.dataIndex, 0U, maxSize);
            if (IO_protocol_private_recieveByte(&data[index]))
            {
                IO_protocol_data.recieve.dataIndex++;
                if (IO_protocol_data.recieve.dataIndex >= IO_protocol_data.recieve.dataLength)
                {
                    IO_protocol_data.recieve.state = IO_PROTOCOL_RECIEVE_STATE_CRC;
                    break;
                }
            }
        }
        if (IO_protocol_private_timeout())
        {
            IO_protocol_data.recieve.state = IO_PROTOCOL_RECIEVE_STATE_SYNC;
        }
        break;
    case IO_PROTOCOL_RECIEVE_STATE_CRC:
        if (IO_protocol_private_recieveByte(&IO_protocol_data.recieve.crc))
        {
            const uint8_t crc = lib_utility_CRC8(data, IO_protocol_data.recieve.dataLength);
            if (crc == IO_protocol_data.recieve.crc)
            {
                incommingType = IO_PROTOCOL_INCOMMING_TYPE_WRITE;
                *writeType = IO_protocol_data.recieve.command;
                *size = LIB_UTILITY_LIMIT(IO_protocol_data.recieve.dataLength, 0U, maxSize);
            }
            IO_protocol_data.recieve.state = IO_PROTOCOL_RECIEVE_STATE_SYNC;
        }
        else if (IO_protocol_private_timeout())
        {
            IO_protocol_data.recieve.state = IO_PROTOCOL_RECIEVE_STATE_SYNC;
        }
        break;
    case IO_PROTOCOL_RECIEVE_STATE_COUNT:
    default:
        IO_protocol_data.recieve.state = IO_PROTOCOL_RECIEVE_STATE_SYNC;
        break;
    }
    return incommingType;
}

bool IO_protocol_respondNACK(IO_protocol_writeType_E originalRequest)
{
    const uint8_t data[3] = {0x55, IO_PROTOCOL_OUTGOING_TYPE_NACK, originalRequest};
    return IO_fullDuplexSerial_send(IO_FULLDUPLEXSERIAL_CHANNEL_MAIN, data, 3U);
}

bool IO_protocol_respondACK(IO_protocol_writeType_E originalRequest)
{
    const uint8_t data[3] = {0x55, IO_PROTOCOL_OUTGOING_TYPE_ACK, originalRequest};
    return IO_fullDuplexSerial_send(IO_FULLDUPLEXSERIAL_CHANNEL_MAIN, data, 3U);
}

bool IO_protocol_respondData(IO_protocol_readType_E originalRequest, uint8_t *data, uint16_t size)
{
    bool ret = true;

    const uint8_t header[5] = {0x55, IO_PROTOCOL_OUTGOING_TYPE_DATA, originalRequest, size, size >> 8};
    const uint8_t crc = lib_utility_CRC8((uint8_t *)data, size);
    ret &= IO_fullDuplexSerial_send(IO_FULLDUPLEXSERIAL_CHANNEL_MAIN, header, 5U);
    ret &= IO_fullDuplexSerial_send(IO_FULLDUPLEXSERIAL_CHANNEL_MAIN, data, size);
    ret &= IO_fullDuplexSerial_send(IO_FULLDUPLEXSERIAL_CHANNEL_MAIN, &crc, 1U);
    return ret;
}

bool IO_protocol_sendNotification(uint8_t *data, uint16_t size)
{
    bool ret = true;
    const uint8_t header[5] = {0x55, IO_PROTOCOL_OUTGOING_TYPE_NOTIFICATION, 0, size, size >> 8};
    const uint8_t crc = lib_utility_CRC8((uint8_t *)data, size);
    ret &= IO_fullDuplexSerial_send(IO_FULLDUPLEXSERIAL_CHANNEL_MAIN, header, 5U);
    ret &= IO_fullDuplexSerial_send(IO_FULLDUPLEXSERIAL_CHANNEL_MAIN, data, size);
    ret &= IO_fullDuplexSerial_send(IO_FULLDUPLEXSERIAL_CHANNEL_MAIN, &crc, 1U);
    return ret;
}

/**********************************************************************
 * End of File
 **********************************************************************/
