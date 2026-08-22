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

/**********************************************************************
 * External Variables
 **********************************************************************/

// channel config table lives in HAL/Config/HAL_GPIO_config.c (data-only, all targets)

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
