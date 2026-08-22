//
// Created by Riley McCarthy on 11/07/26.
// @brief Serial channel wiring/config table — data only, compiled for every
//        target so the SIL emulator reads the same pin/baud truth the hardware
//        runs (firmware<->emulator contract; see docs/dev/sil-board-simulation-design.md).
//
/**********************************************************************
 * Includes
 **********************************************************************/
#include "HAL_serial.h"
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
HAL_CONFIG_USED const HAL_serial_channelConfig_S HAL_serial_channelConfig[HAL_SERIAL_CHANNEL_COUNT] = {
    {HW_PIN_FORCE_GAUGE_RX, HW_PIN_FORCE_GAUGE_TX, 115200, HAL_SERIAL_TYPE_HARDWARE, false}, // FORCE_GAUGE
#if ENABLE_DEBUG_SERIAL
    // leave the MAIN_RX and MAIN_TX open for debug serial
    {HW_PIN_RPI_RX, HW_PIN_RPI_TX, 2000000, HAL_SERIAL_TYPE_HARDWARE, false}, // MAIN
#else
    {HW_PIN_MAIN_RX, HW_PIN_MAIN_TX, 2000000, HAL_SERIAL_TYPE_BUILTIN, false}, // MAIN
#endif
};
/**********************************************************************
 * End of File
 **********************************************************************/
