//
// Created by Riley McCarthy on 25/04/24.
//
/**********************************************************************
 * Includes
 **********************************************************************/
#include <stdlib.h>

#include "dev_cogManager_config.h"
#include "dev_cogManager.h"
#include "app_gauge.h"
#include "app_monitor.h"
#include "app_motion.h"
#include "app_control.h"
#include "app_notification.h"
#include "app_messageSlave.h"
#include "app_testManagement.h"

#include "IO_SDCard.h"
#include "dev_stepper.h"
#include "dev_forceGauge.h"
#include "IO_positionFeedback.h"
#include "dev_nvram.h"

#include "dev_servo.h"
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
    app_gauge_init(lock);
    app_monitor_init(lock);
}

DEV_COGMANAGER_CHANNEL_CREATE_RUN(MONITOR)
{
    app_monitor_run();
}

DEV_COGMANAGER_CHANNEL_CREATE_INIT(MOTOR, 4096)
{
#if APP_MOTION_USE_SERVO
    DEBUG_INFO("%s", "Servo (closed-loop) cog initializing\n");
    MachineProfile machineProfile;
    dev_nvram_getChannelData(DEV_NVRAM_CHANNEL_MACHINE_PROFILE, &machineProfile, sizeof(MachineProfile));
    /* The machine profile stores limits in mm; the servo works in encoder counts.
     * Convert with encoderStepsPerMM (int64 intermediate = overflow-safe) so the
     * profile — not a hardcoded constant — governs the velocity/accel ceilings. */
    const int32_t maxVelocityCounts = (int32_t)((int64_t)machineProfile.maxVelocity * machineProfile.encoderStepsPerMM);
    const int32_t maxAccelCounts = (int32_t)((int64_t)machineProfile.maxAcceleration * machineProfile.encoderStepsPerMM);
    dev_servo_init(lock, maxVelocityCounts, maxAccelCounts); /* app_motion enables + commands it via the actuator macros */
#else
    DEBUG_INFO("%s", "Stepper cog initializing\n");
    dev_stepper_init(lock);
#endif
}

DEV_COGMANAGER_CHANNEL_CREATE_RUN(MOTOR)
{
#if APP_MOTION_USE_SERVO
    dev_servo_run(); /* fixed-rate control tick (cog paced at 1 kHz, see CONFIG_CREATE) */
#else
    dev_stepper_run(); /* free-running; IO_pulseOut handles timing */
#endif
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

DEV_COGMANAGER_CHANNEL_CREATE_INIT(CONTROL, 6144)
{
    DEBUG_INFO("%s", "Control cog initializing\n");
    app_motion_init(lock);
    app_testManagement_init(lock);
    app_control_init(lock);
}

DEV_COGMANAGER_CHANNEL_CREATE_RUN(CONTROL)
{
    /* Order matters: testManagement feeds motion's queue, then motion executes,
     * then control evaluates state. */
    app_testManagement_run();
    app_motion_run();
    app_control_run();
}

DEV_COGMANAGER_CHANNEL_CREATE_INIT(LOGGER, 4096)
{
    DEBUG_INFO("%s", "Logger cog initializing\n");
    IO_SDCard_init(lock);
}

DEV_COGMANAGER_CHANNEL_CREATE_RUN(LOGGER)
{
    IO_SDCard_run();
}

DEV_COGMANAGER_CHANNEL_CREATE_INIT(FORCEGAUGE, 2048)
{
    DEBUG_INFO("%s", "Force gauge cog initializing\n");
    dev_forceGauge_init(lock);
}

DEV_COGMANAGER_CHANNEL_CREATE_RUN(FORCEGAUGE)
{
    // Run forcegauge as fast as possible, we use IO_serial to handle timing
    dev_forceGauge_run();
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
#if APP_MOTION_USE_SERVO
        DEV_COGMANAGER_CHANNEL_CONFIG_CREATE(MOTOR, 1000U), /* servo: fixed 1 kHz control tick */
#else
        DEV_COGMANAGER_CHANNEL_CONFIG_CREATE(MOTOR, 0U),    /* stepper: free-run (IO_pulseOut times it) */
#endif
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
