#ifndef IO_SDCARD_CONFIG_H
#define IO_SDCARD_CONFIG_H
//
// Created by Riley McCarthy on 25/04/24.
// @brief IO_SDCard channel configuration — defines channels and their data types.
//
/**********************************************************************
 * Includes
 **********************************************************************/
#include "IO_SDCard.h"
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
    IO_SDCARD_CHANNEL_SAMPLE_DATA,
    IO_SDCARD_CHANNEL_GCODE,
    /* The machine profile. Exists so `dev_nvram`'s save runs on the LOGGER
     * cog like every other SD access: the P2 ORs pin DIR/OUT across cogs, so a
     * profile save issued from MAIN drives the same SPI pins the LOGGER cog
     * owns and leaves CS high for good (errno 12 on every later open). */
    IO_SDCARD_CHANNEL_PROFILE,
    IO_SDCARD_CHANNEL_COUNT,
} IO_SDCard_channel_E;

/**********************************************************************
 * Public Function Definitions
 **********************************************************************/

/**********************************************************************
 * End of File
 **********************************************************************/
#endif /* IO_SDCARD_CONFIG_H */
