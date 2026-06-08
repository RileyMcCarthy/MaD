//
// Created by Riley McCarthy on 06/12/24.
//
/**********************************************************************
 * Includes
 **********************************************************************/
#include "IO_positionFeedback.h"
#include "dev_nvram.h"

#include "HAL_encoder.h"

#include "lib_utility.h"
/**********************************************************************
 * Constants
 **********************************************************************/

/*********************************************************************
 * Macros
 **********************************************************************/

/**********************************************************************
 * Typedefs
 **********************************************************************/
typedef struct
{
    int32_t stepPerMM;
    HAL_encoder_channel_E encoderChannel;
} IO_positionFeedback_channelData_S;

typedef struct
{
    HAL_encoder_channel_E encoderChannel;
} IO_positionFeedback_channelConfig_S;

/**********************************************************************
 * External Variables
 **********************************************************************/

/**********************************************************************
 * Private Variable Definitions
 **********************************************************************/
static IO_positionFeedback_channelData_S IO_positionFeedback_channelData[IO_POSITION_FEEDBACK_CHANNEL_COUNT];

// Configuration mapping position feedback channels to encoder channels
#ifdef __FLEXC__
static const IO_positionFeedback_channelConfig_S IO_positionFeedback_channelConfig[IO_POSITION_FEEDBACK_CHANNEL_COUNT] = {
    {
        HAL_ENCODER_CHANNEL_SERVO,
    },
};
#else
static const IO_positionFeedback_channelConfig_S IO_positionFeedback_channelConfig[IO_POSITION_FEEDBACK_CHANNEL_COUNT] = {
    [IO_POSITION_FEEDBACK_CHANNEL_SERVO_FEEDBACK] = {
        .encoderChannel = HAL_ENCODER_CHANNEL_SERVO,
    },
};
#endif

/**********************************************************************
 * Private Function Prototypes
 **********************************************************************/

/**********************************************************************
 * Private Function Definitions
 **********************************************************************/

void IO_positionFeedback_init(IO_positionFeedback_channel_E ch, int lock, int32_t stepPerMM)
{
    if (ch >= IO_POSITION_FEEDBACK_CHANNEL_COUNT)
    {
        return;
    }
    
    // Get encoder channel from config
    HAL_encoder_channel_E encoderChannel = IO_positionFeedback_channelConfig[ch].encoderChannel;
    IO_positionFeedback_channelData[ch].encoderChannel = encoderChannel;
    
    // Start the encoder (hardware configuration is in HAL_encoder)
    HAL_encoder_start(encoderChannel);
    IO_positionFeedback_channelData[ch].stepPerMM = stepPerMM == 0 ? 1 : stepPerMM; // ensure non-zero value
}

int32_t IO_positionFeedback_getValue(IO_positionFeedback_channel_E ch)
{
    int32_t positionUM = 0;
    if (ch < IO_POSITION_FEEDBACK_CHANNEL_COUNT)
    {
        const int32_t encoderSteps = HAL_encoder_value(IO_positionFeedback_channelData[ch].encoderChannel);
        positionUM = lib_utility_muldiv64_signed(
            encoderSteps, 1000, IO_positionFeedback_channelData[ch].stepPerMM);
    }
    return positionUM;
}

bool IO_positionFeedback_setValue(IO_positionFeedback_channel_E ch, int32_t positionUM)
{
    bool success = false;
    if (ch < IO_POSITION_FEEDBACK_CHANNEL_COUNT)
    {
        const int32_t encoderSteps = lib_utility_muldiv64_signed(
            positionUM, IO_positionFeedback_channelData[ch].stepPerMM, 1000);
        HAL_encoder_set(IO_positionFeedback_channelData[ch].encoderChannel, encoderSteps);
        success = true;
    }
    return success;
}

/**********************************************************************
 * Public Function Definitions
 **********************************************************************/

/**********************************************************************
 * End of File
 **********************************************************************/
