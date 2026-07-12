//
// Created by Riley McCarthy on 11/07/26.
// @brief Encoder channel wiring/config table — data only, compiled for every
//        target so the SIL emulator reads the same pin truth the hardware
//        runs (firmware<->emulator contract; see docs/dev/sil-board-simulation-design.md).
//
/**********************************************************************
 * Includes
 **********************************************************************/
#include "HAL_encoder.h"
#include "HW_pins.h"
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
/* Positional order matches HAL_encoder_config_S declaration:
 * { preset, lo, hi, pinA, pinB }. (The previous FlexC-only initializer listed
 * pins first, silently scrambling every field on hardware builds.) */
HAL_CONFIG_USED const HAL_encoder_config_S HAL_encoder_config[HAL_ENCODER_CHANNEL_COUNT] = {
    {
        0,                       // preset
        -1000000,                // lo
        1000000,                 // hi
        HW_PIN_SERVO_ENCODER_A,  // pinA
        HW_PIN_SERVO_ENCODER_B,  // pinB
    },
};
/**********************************************************************
 * End of File
 **********************************************************************/
