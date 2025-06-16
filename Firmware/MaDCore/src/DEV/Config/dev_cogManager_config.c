//
// Created by Riley McCarthy on 25/04/24.
//
/**********************************************************************
 * Includes
 **********************************************************************/
#include <stdlib.h>

#include "dev_cogManager_config.h"
#include "dev_cogManager.h"
#include "app_monitor.h"
#include "app_motion.h"
#include "app_control.h"
#include "app_notification.h"
#include "app_messageSlave.h"

#include "IO_logger.h"
#include "dev_stepper.h"
#include "dev_forceGauge.h"
#include "IO_positionFeedback.h"
#include "dev_nvram.h"

#include "IO_protocol.h"
#include "IO_fullDuplexSerial.h"

#include "watchdog.h"
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

DEV_COGMANAGER_CHANNEL_CREATE_INIT(MONITOR, 1024U)
{
    DEBUG_INFO("%s", "Monitor cog init\n");
    MachineProfile machineProfile;
    dev_nvram_getChannelData(DEV_NVRAM_CHANNEL_MACHINE_PROFILE, &machineProfile, sizeof(MachineProfile));
    IO_positionFeedback_init(IO_POSITION_FEEDBACK_CHANNEL_SERVO_FEEDBACK, lock, machineProfile.encoderStepsPerMM);
    app_monitor_init(lock);
}

DEV_COGMANAGER_CHANNEL_CREATE_RUN(MONITOR)
{
    DEBUG_INFO("%s", "Monitor cog running\n");
    while (1)
    {
        app_monitor_run();
        watchdog_kick(WATCHDOG_CHANNEL_MONITOR);
    }
}

DEV_COGMANAGER_CHANNEL_CREATE_INIT(MOTOR, 1024U)
{
    DEBUG_INFO("%s", "Stepper cog initializing\n");
    dev_stepper_init(lock);
}

DEV_COGMANAGER_CHANNEL_CREATE_RUN(MOTOR)
{
    DEBUG_INFO("%s", "Stepper cog running\n");
    while (1)
    {
        dev_stepper_run();
        watchdog_kick(WATCHDOG_CHANNEL_MOTOR);
    }
}

DEV_COGMANAGER_CHANNEL_CREATE_INIT(COMMUNICATION, 2048)
{
    DEBUG_INFO("%s", "Communication cog initializing\n");
    IO_protocol_init();
    app_messageSlave_init(lock);
    app_notification_init(lock);
    app_motion_init(lock); // temp spot until control is fixed
}

DEV_COGMANAGER_CHANNEL_CREATE_RUN(COMMUNICATION)
{
    DEBUG_INFO("%s", "Communication cog running\n");
    while (1)
    {
        app_notification_run();
        app_messageSlave_run();
        app_motion_run();
        watchdog_kick(WATCHDOG_CHANNEL_COMMUNICATION);
    }
}

DEV_COGMANAGER_CHANNEL_CREATE_INIT(CONTROL, 1024)
{
    DEBUG_INFO("%s", "Control cog initializing\n");
    app_control_init(lock);
}

DEV_COGMANAGER_CHANNEL_CREATE_RUN(CONTROL)
{
    DEBUG_INFO("%s", "Control cog running\n");
    while (1)
    {
        app_control_run();
        watchdog_kick(WATCHDOG_CHANNEL_CONTROL);
    }
}

DEV_COGMANAGER_CHANNEL_CREATE_INIT(LOGGER, 1024)
{
    DEBUG_INFO("%s", "Logger cog initializing\n");
    IO_logger_init(lock);
}

DEV_COGMANAGER_CHANNEL_CREATE_RUN(LOGGER)
{
    DEBUG_INFO("%s", "Logger cog running\n");
    while (1)
    {
        IO_logger_run();
        watchdog_kick(WATCHDOG_CHANNEL_LOGGER);
    }
}

DEV_COGMANAGER_CHANNEL_CREATE_INIT(FORCEGAUGE, 1024)
{
    DEBUG_INFO("%s", "Force gauge cog initializing\n");
    dev_forceGauge_init(lock);
}

DEV_COGMANAGER_CHANNEL_CREATE_RUN(FORCEGAUGE)
{
    DEBUG_INFO("%s", "Force gauge cog running\n");
    while (1)
    {
        dev_forceGauge_run();
        watchdog_kick(WATCHDOG_CHANNEL_FORCEGAUGE);
    }
}

DEV_COGMANAGER_CHANNEL_CREATE_INIT(FULLDUPLEXSERIAL, 1024)
{
    DEBUG_INFO("%s", "Serial cog initializing\n");
    IO_fullDuplexSerial_init(lock);
}

DEV_COGMANAGER_CHANNEL_CREATE_RUN(FULLDUPLEXSERIAL)
{
    DEBUG_INFO("%s", "Serial cog running\n");
    while (1)
    {
        IO_fullDuplexSerial_run();
        watchdog_kick(WATCHDOG_CHANNEL_SERIAL);
    }
}

const dev_cogManager_config_S dev_cogManager_config = {
    {
        DEV_COGMANAGER_CHANNEL_CONFIG_CREATE(MONITOR),
        DEV_COGMANAGER_CHANNEL_CONFIG_CREATE(MOTOR),
        DEV_COGMANAGER_CHANNEL_CONFIG_CREATE(COMMUNICATION),
        DEV_COGMANAGER_CHANNEL_CONFIG_CREATE(CONTROL),
        DEV_COGMANAGER_CHANNEL_CONFIG_CREATE(LOGGER),
        DEV_COGMANAGER_CHANNEL_CONFIG_CREATE(FORCEGAUGE),
        DEV_COGMANAGER_CHANNEL_CONFIG_CREATE(FULLDUPLEXSERIAL),
    },
};
/**********************************************************************
 * Private Variable Definitions
 **********************************************************************/

/**********************************************************************
 * Private Function Prototypes
 **********************************************************************/

/**********************************************************************
 * Private Function Definitions
 **********************************************************************/

/**********************************************************************
 * Public Function Definitions
 **********************************************************************/

/**********************************************************************
 * End of File
 **********************************************************************/
