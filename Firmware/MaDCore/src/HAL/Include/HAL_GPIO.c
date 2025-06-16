//
// Created by Riley McCarthy on 25/04/24.
//
/**********************************************************************
 * Includes
 **********************************************************************/
#include "HAL_GPIO.h"

#include "HW_pins.h"
#include <propeller2.h>
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
    const HW_pin_E pin;
    const bool activeLow;
} HAL_GPIO_channelConfig_S;

/**********************************************************************
 * External Variables
 **********************************************************************/

const HAL_GPIO_channelConfig_S HAL_GPIO_channelConfig[HAL_GPIO_COUNT] = {
    {HW_PIN_SERVO_ENA, false},
    {HW_PIN_SERVO_DIR, false},
    {HW_PIN_SERVO_RDY, false},
    {HW_PIN_ESD_UPPER, true},
    {HW_PIN_ESD_LOWER, true},
    {HW_PIN_ESD_SWITCH, true},
    {HW_PIN_ENDSTOP_UPPER, false},
    {HW_PIN_ENDSTOP_LOWER, false},
    {HW_PIN_ENDSTOP_DOOR, false},
    {HW_PIN_ESD_POWER, false},
    {HW_PIN_CHARGE_PUMP, false},
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

void HAL_GPIO_setActive(HAL_GPIO_channel_E channel, bool active)
{
    if (HAL_GPIO_channelConfig[channel].activeLow)
    {
        active = !active;
    }

    if (active)
    {
        _pinh(HAL_GPIO_channelConfig[channel].pin);
    }
    else
    {
        _pinl(HAL_GPIO_channelConfig[channel].pin);
    }
}

bool HAL_GPIO_getActive(HAL_GPIO_channel_E channel)
{
    bool active = _pinr(HAL_GPIO_channelConfig[channel].pin);
    if (HAL_GPIO_channelConfig[channel].activeLow)
    {
        active = !active;
    }
    return active;
}

void HAL_GPIO_toggleActive(HAL_GPIO_channel_E channel)
{
    if (HAL_GPIO_getActive(channel))
    {
        HAL_GPIO_setActive(channel, false);
    }
    else
    {
        HAL_GPIO_setActive(channel, true);
    }
}

/**********************************************************************
 * End of File
 **********************************************************************/
