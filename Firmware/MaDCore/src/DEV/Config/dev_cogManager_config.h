#ifndef DEV_COGMANAGER_CONFIG_H
#define DEV_COGMANAGER_CONFIG_H
//
// Created by Riley McCarthy on 25/04/24.
//
/**********************************************************************
 * Includes
 **********************************************************************/
#include <stdbool.h>
#include <stdint.h>
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
    DEV_COGMANAGER_CHANNEL_MONITOR,       // Watchdog, and SDCard. CogManager will also run on this channel.
    DEV_COGMANAGER_CHANNEL_MOTOR,         // Motor control
    DEV_COGMANAGER_CHANNEL_COMMUNICATION, // message, notification
    DEV_COGMANAGER_CHANNEL_CONTROL,       // control
    DEV_COGMANAGER_CHANNEL_LOGGER,        // logger
    DEV_COGMANAGER_CHANNEL_FORCEGAUGE,    // force gauge
    DEV_COGMANAGER_CHANNEL_FULLDUPLEXSERIAL, // full duplex serial
    DEV_COGMANAGER_CHANNEL_COUNT,
} dev_cogManager_channel_E;
/**********************************************************************
 * Public Function Definitions
 **********************************************************************/

/**********************************************************************
 * End of File
 **********************************************************************/
#endif /* DEV_COGMANAGER_CONFIG_H */
