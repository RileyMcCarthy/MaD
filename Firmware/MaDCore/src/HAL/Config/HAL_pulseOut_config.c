//
// Created by Riley McCarthy on 11/07/26.
// @brief Pulse-out channel wiring/config table — data only, compiled for every
//        target so the SIL emulator reads the same pin truth the hardware
//        runs (firmware<->emulator contract; see docs/dev/sil-board-simulation-design.md).
//
/**********************************************************************
 * Includes
 **********************************************************************/
#include "HAL_pulseOut.h"
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
HAL_CONFIG_USED const HAL_pulseOut_channelConfig_S HAL_pulseOut_channelConfig[HAL_PULSE_OUT_CHANNEL_COUNT] = {
    {
        (65535U * 2U),     // maxHardwareClockCyclePerStep
        HW_PIN_SERVO_PUL,  // pin
    },
};
/**********************************************************************
 * End of File
 **********************************************************************/
