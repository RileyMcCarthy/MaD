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
    app_monitor_run();
}

DEV_COGMANAGER_CHANNEL_CREATE_INIT(MOTOR, 2048)
{
    DEBUG_INFO("%s", "Stepper cog initializing\n");
    dev_stepper_init(lock);
}

DEV_COGMANAGER_CHANNEL_CREATE_RUN(MOTOR)
{
    // Run stepper as fast as possible, we we use IO_pulseOut for handle timing
    dev_stepper_run();
}

DEV_COGMANAGER_CHANNEL_CREATE_INIT(COMMUNICATION, 2048)
{
    DEBUG_INFO("%s", "Communication cog initializing\n");
    IO_protocol_init();
    app_messageSlave_init(lock);
    app_notification_init(lock);
}

DEV_COGMANAGER_CHANNEL_CREATE_RUN(COMMUNICATION)
{
    app_notification_run();
    app_messageSlave_run();
}

DEV_COGMANAGER_CHANNEL_CREATE_INIT(CONTROL, 1024)
{
    DEBUG_INFO("%s", "Control cog initializing\n");
    app_motion_init(lock);
    app_control_init(lock);
}

DEV_COGMANAGER_CHANNEL_CREATE_RUN(CONTROL)
{
    app_motion_run();
    app_control_run();
}

DEV_COGMANAGER_CHANNEL_CREATE_INIT(LOGGER, 1024)
{
    DEBUG_INFO("%s", "Logger cog initializing\n");
    IO_logger_init(lock);
}

DEV_COGMANAGER_CHANNEL_CREATE_RUN(LOGGER)
{
    IO_logger_run();
}

DEV_COGMANAGER_CHANNEL_CREATE_INIT(FORCEGAUGE, 1024)
{
    DEBUG_INFO("%s", "Force gauge cog initializing\n");
    dev_forceGauge_init(lock);
}

DEV_COGMANAGER_CHANNEL_CREATE_RUN(FORCEGAUGE)
{
    // Run forcegauge as fast as possible, we use IO_serial to handle timing
    //dev_forceGauge_run();
}

DEV_COGMANAGER_CHANNEL_CREATE_INIT(SERIAL, 1024)
{
    DEBUG_INFO("%s", "Serial cog initializing\n");
    IO_fullDuplexSerial_init(lock);
}

DEV_COGMANAGER_CHANNEL_CREATE_RUN(SERIAL)
{
    IO_fullDuplexSerial_run();
}

const dev_cogManager_config_S dev_cogManager_config = {
    {
        DEV_COGMANAGER_CHANNEL_CONFIG_CREATE(MONITOR, 1000U),
        DEV_COGMANAGER_CHANNEL_CONFIG_CREATE(MOTOR, 0U),
        DEV_COGMANAGER_CHANNEL_CONFIG_CREATE(COMMUNICATION, 100U),
        DEV_COGMANAGER_CHANNEL_CONFIG_CREATE(CONTROL, 1000U),
        DEV_COGMANAGER_CHANNEL_CONFIG_CREATE(LOGGER, 1000U),
        DEV_COGMANAGER_CHANNEL_CONFIG_CREATE(FORCEGAUGE, 0U),
        DEV_COGMANAGER_CHANNEL_CONFIG_CREATE(SERIAL, 0U),
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
