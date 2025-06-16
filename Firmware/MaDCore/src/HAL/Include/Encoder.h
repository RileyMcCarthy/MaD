#ifndef ENCODER_H
#define ENCODER_H
#include <stdint.h>
#include <stdbool.h>
#include "Encoder_private.h"

void encoder_start(Encoder *self, uint8_t pinA, uint8_t pinB, uint8_t btn, bool d4x, int32_t preset, int32_t lo, int32_t hi);
int32_t encoder_value(Encoder *self);
void encoder_set(Encoder *self, int32_t value);

#endif // ENCODER_H
