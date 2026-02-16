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

/**********************************************************************
 * External Variables
 **********************************************************************/

/**********************************************************************
 * Private Variable Definitions
 **********************************************************************/

IO_LOGGER_CHANNEL_DATA_DEFINE(SAMPLE_DATA, IO_logger_testSample_S, 64, "a", SD_CARD_MOUNT_PATH "/test/%s.csv")
{
    bool result = false;
    // Write CSV header if file is empty (first write after open)
    if (ftell(file) == 0)
    {
        fprintf(file, "time_us,index,force_mN,position_um,setpoint_um\n");
    }
    IO_logger_testSample_S sample;
    while (lib_staticQueue_pop(queue, &sample))
    {
        fprintf(file, "%u,%u,%d,%d,%d\n", sample.time, sample.index, sample.force, sample.position, sample.setpoint);
        result = true;
    }
    return result;
}

IO_LOGGER_CHANNEL_DATA_DEFINE(GCODE, IO_logger_gcodeLine_S, 32, "w", SD_CARD_MOUNT_PATH "/gcode/%s.gcode")
{
    bool result = false;
    IO_logger_gcodeLine_S gcodeLine;
    while (lib_staticQueue_pop(queue, &gcodeLine))
    {
        fprintf(file, "%s\n", gcodeLine.line);
        result = true;
    }
    return result;
}

IO_logger_config_S IO_logger_config = {
    {
        IO_LOGGER_CHANNEL_CREATE(SAMPLE_DATA),
        IO_LOGGER_CHANNEL_CREATE(GCODE),
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
