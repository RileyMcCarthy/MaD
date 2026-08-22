//
// Created by Riley McCarthy on 11/07/26.
// @brief GPIO channel wiring/config table — data only, compiled for every
//        target so the SIL emulator reads the same pin truth the hardware
//        runs (firmware<->emulator contract; see docs/dev/sil-board-simulation-design.md).
//
/**********************************************************************
 * Includes
 **********************************************************************/
#include "HAL_GPIO.h"
/**********************************************************************
 * Constants
 **********************************************************************/
#if defined(__FLEXC__)
#define HAL_CONFIG_USED
#else
#define HAL_CONFIG_USED __attribute__((used))
#endif
/**********************************************************************
 * Public Variable Definitions
 **********************************************************************/
HAL_CONFIG_USED const HAL_GPIO_channelConfig_S HAL_GPIO_channelConfig[HAL_GPIO_COUNT] = {
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
 * End of File
 **********************************************************************/
