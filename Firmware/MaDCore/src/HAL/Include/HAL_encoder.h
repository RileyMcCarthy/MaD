#ifndef HAL_ENCODER_H
#define HAL_ENCODER_H

#include <stdint.h>
#include <stdbool.h>

/**********************************************************************
 * Constants
 **********************************************************************/

/**********************************************************************
 * Typedefs
 **********************************************************************/
typedef enum
{
    HAL_ENCODER_CHANNEL_SERVO,
    HAL_ENCODER_CHANNEL_COUNT,
} HAL_encoder_channel_E;

typedef struct
{
    int32_t preset;     // Initial preset value
    int32_t lo;         // Lower limit
    int32_t hi;         // Upper limit
    uint8_t pinA;       // Encoder A input pin
    uint8_t pinB;       // Encoder B input pin
} HAL_encoder_config_S;

/**********************************************************************
 * Public Function Prototypes
 **********************************************************************/
void HAL_encoder_start(HAL_encoder_channel_E channel);
int32_t HAL_encoder_value(HAL_encoder_channel_E channel);
void HAL_encoder_set(HAL_encoder_channel_E channel, int32_t value);

#endif // HAL_ENCODER_H
