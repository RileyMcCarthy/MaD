
//
// Created by Riley McCarthy on 25/04/24.
//
/**********************************************************************
 * Includes
 **********************************************************************/
#include "HAL_pulseOut.h"
#include "HAL_pulseOut_private.h"

#include "SocketIO.h"
#include "propeller2.h"
#include "IO_Debug.h"
/**********************************************************************
 * Constants
 **********************************************************************/
#define HAL_PULSE_OUT_MAX_STEPS_PER_SECOND (255U) // MAX 1 byte of steps per second
/*********************************************************************
 * Macros
 **********************************************************************/

/**********************************************************************
 * Typedefs
 **********************************************************************/
typedef struct
{
    int32_t socket_id;
    uint32_t pulses;
    uint32_t frequency;
    uint32_t currentPulse;
} HAL_pulseOut_channelData_S;
/**********************************************************************
 * External Variables
 **********************************************************************/
static const HAL_pulseOut_channelConfig_S HAL_pulseOut_channelConfig[HAL_PULSE_OUT_CHANNEL_COUNT] = {
    [HAL_PULSE_OUT_CHANNEL_SERVO] = {
        .pin = HW_PIN_SERVO_PUL,
    }
};

/**********************************************************************
 * Private Variable Definitions
 **********************************************************************/
static HAL_pulseOut_channelData_S HAL_pulseOut_channelData[HAL_PULSE_OUT_CHANNEL_COUNT];
/**********************************************************************
 * Private Function Prototypes
 **********************************************************************/

/**********************************************************************
 * Private Function Definitions
 **********************************************************************/

/**********************************************************************
 * Public Function Definitions
 **********************************************************************/

void HAL_pulseOut_start(HAL_pulseOut_channel_E ch, uint32_t pulses, uint32_t frequency)
{
    HAL_pulseOut_channelData[ch].socket_id = get_pin_socketid(HAL_pulseOut_channelConfig[ch].pin);
    HAL_pulseOut_channelData[ch].pulses = pulses;
    HAL_pulseOut_channelData[ch].frequency = frequency;
    HAL_pulseOut_channelData[ch].currentPulse = 0U;
}

bool HAL_pulseOut_run(HAL_pulseOut_channel_E ch, uint32_t *pulses)
{
    uint32_t remainingPulses = HAL_pulseOut_channelData[ch].pulses - HAL_pulseOut_channelData[ch].currentPulse;
    remainingPulses = (remainingPulses > HAL_PULSE_OUT_MAX_STEPS_PER_SECOND) ? HAL_PULSE_OUT_MAX_STEPS_PER_SECOND : remainingPulses;
    uint32_t waittime = ((1000000*remainingPulses) / HAL_pulseOut_channelData[ch].frequency); // 255 / 1000 = 0.255 seconds
    socketio_send(HAL_pulseOut_channelData[ch].socket_id, remainingPulses);
    if (waittime == 0)
    {
        DEBUG_WARNING("%s\n", "Moving too fast, waittime is 0 seconds");
    }
    _waitus(waittime);
    HAL_pulseOut_channelData[ch].currentPulse+=remainingPulses;
    *pulses = HAL_pulseOut_channelData[ch].currentPulse;
    return (HAL_pulseOut_channelData[ch].currentPulse == HAL_pulseOut_channelData[ch].pulses);
}

void HAL_pulseOut_stop(HAL_pulseOut_channel_E ch)
{
    HAL_pulseOut_channelData[ch].currentPulse = 0U;
    HAL_pulseOut_channelData[ch].pulses = 0U;
}
/**********************************************************************
 * End of File
 **********************************************************************/
