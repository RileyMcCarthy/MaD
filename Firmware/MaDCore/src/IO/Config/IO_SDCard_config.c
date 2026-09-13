//
// Created by Riley McCarthy on 25/04/24.
// @brief IO_SDCard channel configuration — defines channel buffers and paths.
//
/**********************************************************************
 * Includes
 **********************************************************************/
#include "IO_SDCard.h"
#include "dev_nvram_machineProfile.h"
#include "app_monitor.h"
#include "app_motion.h"
/**********************************************************************
 * Constants
 **********************************************************************/

/*********************************************************************
 * Macros
 **********************************************************************/

/**********************************************************************
 * Typedefs
 **********************************************************************/

/**********************************************************************
 * External Variables
 **********************************************************************/

/**********************************************************************
 * Private Variable Definitions
 **********************************************************************/

IO_SDCARD_CHANNEL_DATA_DEFINE(SAMPLE_DATA, app_monitor_sample_t, 64, SD_CARD_MOUNT_PATH "/test/%s.bin");
IO_SDCARD_CHANNEL_DATA_DEFINE(GCODE, app_motion_move_t, 64, SD_CARD_MOUNT_PATH "/gcode/%s.bin");
/* FOUR slots, not one: `lib_staticQueue` is a ring that reserves a slot —
 * `isfull` is `(rear + 1) % max_size == front` — so N slots hold N-1 items and
 * a 1-slot channel is permanently full, refusing every push. A save only ever
 * needs one item in flight; the rest is headroom. The name format keeps the
 * file exactly where it has always been, `/sd/profile.bin`, so the boot read
 * is unchanged. */
IO_SDCARD_CHANNEL_DATA_DEFINE(PROFILE, MachineProfile, 4, SD_CARD_MOUNT_PATH "/%s.bin");

IO_SDCard_config_S IO_SDCard_config = {
    {
        IO_SDCARD_CHANNEL_CREATE(SAMPLE_DATA),
        IO_SDCARD_CHANNEL_CREATE(GCODE),
        IO_SDCARD_CHANNEL_CREATE(PROFILE),
    },
};

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
