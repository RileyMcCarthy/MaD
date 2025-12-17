#ifndef HAL_ENCODER_PRIVATE_H
#define HAL_ENCODER_PRIVATE_H

#include <stdint.h>
#include <stdbool.h>
#include "HAL_encoder.h"

typedef struct {
    int32_t socket_a;
    int32_t socket_b;
    int32_t value;
    bool setup;
} HAL_encoder_channelData_S;

#endif // HAL_ENCODER_PRIVATE_H
