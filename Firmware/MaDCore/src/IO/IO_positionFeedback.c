//
// Created by Riley McCarthy on 06/12/24.
//
/**********************************************************************
 * Includes
 **********************************************************************/
#include "IO_positionFeedback.h"
#include "dev_nvram.h"

#include "Encoder.h"
#include "HW_pins.h"

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

    Encoder encoder;
} IO_positionFeedback_channelData_S;

IO_positionFeedback_channelData_S IO_positionFeedback_channelData[IO_POSITION_FEEDBACK_CHANNEL_COUNT];
/**********************************************************************
 * External Variables
 **********************************************************************/

/**********************************************************************
 * Private Variable Definitions
 **********************************************************************/

typedef struct
{
    // ideally this just has a HAL_quadrature channel but cause of SPIN its easier to give raw pin values
    // using direct HW channels is fine for now tbh
    HW_pin_E encoderA;
    HW_pin_E encoderB;
} IO_positionFeedback_channeConfig_S;

IO_positionFeedback_channeConfig_S IO_positionFeedback_channelConfig[IO_POSITION_FEEDBACK_CHANNEL_COUNT] = {
    {
        HW_PIN_SERVO_ENCODER_A,
        HW_PIN_SERVO_ENCODER_B,
    },
};
/**********************************************************************
 * Private Function Prototypes
 **********************************************************************/

/**********************************************************************
 * Private Function Definitions
 **********************************************************************/

void IO_positionFeedback_init(IO_positionFeedback_channel_E ch, int lock, int32_t stepPerMM)
{
    encoder_start(&IO_positionFeedback_channelData[ch].encoder, IO_positionFeedback_channelConfig[ch].encoderA, IO_positionFeedback_channelConfig[ch].encoderB, -1, false, 0, -1000000, 1000000);
    IO_positionFeedback_channelData[ch].stepPerMM = stepPerMM == 0 ? 1 : stepPerMM; // ensure non-zero value
}

int32_t IO_positionFeedback_getValue(IO_positionFeedback_channel_E ch)
{
    int32_t positionUM = 0;
    if (ch < IO_POSITION_FEEDBACK_CHANNEL_COUNT)
    {
        const int32_t encoderSteps = encoder_value(&IO_positionFeedback_channelData[ch].encoder);
        positionUM = LIB_UTILITY_MM_TO_UM(encoderSteps / IO_positionFeedback_channelData[ch].stepPerMM);
    }
    return positionUM;
}

bool IO_positionFeedback_setValue(IO_positionFeedback_channel_E ch, int32_t positionUM)
{
    bool success = false;
    if (ch < IO_POSITION_FEEDBACK_CHANNEL_COUNT)
    {
        const int32_t encoderSteps = (positionUM * IO_positionFeedback_channelData[ch].stepPerMM) / 1000;
        encoder_set(&IO_positionFeedback_channelData[ch].encoder, encoderSteps);
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
