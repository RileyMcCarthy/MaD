#ifndef IO_protocol_H
#define IO_protocol_H
//
// Created by Riley McCarthy on 25/04/24.
//
/**********************************************************************
 * Includes
 **********************************************************************/
#include <stdint.h>
#include <stdbool.h>
/**********************************************************************
 * Constants
 **********************************************************************/

typedef enum
{
    IO_PROTOCOL_READ_TYPE_SAMPLE = 0,
    IO_PROTOCOL_READ_TYPE_STATE = 1,
    IO_PROTOCOL_READ_TYPE_MACHINE_CONFIGURATION = 2,
    IO_PROTOCOL_READ_TYPE_FIRMWARE_VERSION = 3,
    IO_PROTOCOL_READ_TYPE_COUNT,
} IO_protocol_readType_E;

typedef enum
{
    IO_PROTOCOL_WRITE_TYPE_MACHINE_CONFIGURATION = 0,
    IO_PROTOCOL_WRITE_TYPE_MOTION_ENABLE = 1,
    IO_PROTOCOL_WRITE_TYPE_TEST_RUN = 2,
    IO_PROTOCOL_WRITE_TYPE_MANUAL_MOVE = 3,
    IO_PROTOCOL_WRITE_TYPE_TEST_MOVE = 4,
    IO_PROTOCOL_WRITE_TYPE_SAMPLE_PROFILE = 5,
    IO_PROTOCOL_WRITE_TYPE_GAUGE_LENGTH = 6,
    IO_PROTOCOL_WRITE_TYPE_GAUGE_FORCE = 7,
    IO_PROTOCOL_WRITE_TYPE_COUNT,
} IO_protocol_writeType_E;

typedef enum
{
    IO_PROTOCOL_OUTGOING_TYPE_NACK,
    IO_PROTOCOL_OUTGOING_TYPE_ACK,
    IO_PROTOCOL_OUTGOING_TYPE_DATA,
    IO_PROTOCOL_OUTGOING_TYPE_NOTIFICATION,
    IO_PROTOCOL_OUTGOING_TYPE_COUNT,
} IO_protocol_outgoingType_E;

typedef enum
{
    IO_PROTOCOL_INCOMMING_TYPE_READ,
    IO_PROTOCOL_INCOMMING_TYPE_WRITE,
    IO_PROTOCOL_INCOMMING_TYPE_NONE,
    IO_PROTOCOL_INCOMMING_TYPE_COUNT,
} IO_protocol_incommingType_E;

/*********************************************************************
 * Macros
 **********************************************************************/

/**********************************************************************
 * Typedefs
 **********************************************************************/

/**********************************************************************
 * Public Function Definitions
 **********************************************************************/

// This module is not THREADSAFE, it is assumed that the caller will handle the locking if required
void IO_protocol_init(void);
IO_protocol_incommingType_E IO_protocol_recieveRequest(IO_protocol_readType_E *readType, IO_protocol_writeType_E *writeType, void *data, uint32_t *size, const uint16_t maxSize);
bool IO_protocol_respondNACK(IO_protocol_writeType_E originalRequest);
bool IO_protocol_respondACK(IO_protocol_writeType_E originalRequest);
bool IO_protocol_respondData(IO_protocol_readType_E originalRequest, uint8_t *data, uint16_t size);
bool IO_protocol_sendNotification(uint8_t *data, uint16_t size);
/**********************************************************************
 * End of File
 **********************************************************************/
#endif /* IO_protocol_H */
