#ifndef HAL_GPIO_H
#define HAL_GPIO_H
//
// Created by Riley McCarthy on 25/04/24.
// @brief Non threadsafe implementation of GPIO control, for use in single cog applications.
//        If using multiple cogs, only give a single cog to access a channel.
//
/**********************************************************************
 * Includes
 **********************************************************************/
#include <stdbool.h>
/**********************************************************************
 * Constants
 **********************************************************************/

/*********************************************************************
 * Macros
 **********************************************************************/

/**********************************************************************
 * Typedefs
 **********************************************************************/
typedef enum
{
    HAL_GPIO_SERVO_ENA,
    HAL_GPIO_SERVO_DIR,
    HAL_GPIO_SERVO_RDY,
    HAL_GPIO_ESD_UPPER,
    HAL_GPIO_ESD_LOWER,
    HAL_GPIO_ESD_SWITCH,
    HAL_GPIO_ENDSTOP_UPPER,
    HAL_GPIO_ENDSTOP_LOWER,
    HAL_GPIO_ENDSTOP_DOOR,
    HAL_GPIO_ESD_POWER,
    HAL_GPIO_CHARGE_PUMP,
    HAL_GPIO_COUNT,
} HAL_GPIO_channel_E;

/**********************************************************************
 * Public Function Definitions
 **********************************************************************/

void HAL_GPIO_setActive(HAL_GPIO_channel_E channel, bool active);
bool HAL_GPIO_getActive(HAL_GPIO_channel_E channel);
void HAL_GPIO_toggleActive(HAL_GPIO_channel_E channel);
/**********************************************************************
 * End of File
 **********************************************************************/
#endif /* HAL_GPIO_H */
