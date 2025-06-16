#ifndef IO_LOGGER_CONFIG_H
#define IO_LOGGER_CONFIG_H
//
// Created by Riley McCarthy on 25/04/24.
//
/**********************************************************************
 * Includes
 **********************************************************************/
#include "IO_logger.h"
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
    IO_LOGGER_CHANNEL_SAMPLE_DATA,
    IO_LOGGER_CHANNEL_COUNT,
} IO_logger_channel_E;

typedef struct
{
    int32_t force;    // mN
    int32_t position; // um
    uint32_t time;    // us
    uint32_t index;   // sample id, should determine overflow at 1000sps
    int32_t setpoint; // um
} IO_logger_testSample_S;

typedef struct
{
    char header[255];
} IO_logger_testSampleHeader_S;

/**********************************************************************
 * Public Function Definitions
 **********************************************************************/

/**********************************************************************
 * End of File
 **********************************************************************/
#endif /* IO_LOGGER_CONFIG_H */
