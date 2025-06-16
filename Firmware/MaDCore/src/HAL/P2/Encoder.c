#include "Encoder.h"
#include <stdlib.h>

void encoder_start(Encoder *self, uint8_t pinA, uint8_t pinB, uint8_t btn, bool d4x, int32_t preset, int32_t lo, int32_t hi)
{
    if (self == NULL)
    {
        return;
    }
    self->start(pinA, pinB, btn, d4x, preset, lo, hi);
}
int32_t encoder_value(Encoder *self)
{
    if (self == NULL)
    {
        return 0;
    }
    return self->value();
}
void encoder_set(Encoder *self, int32_t value)
{
    if (self == NULL)
    {
        return;
    }
    self->set(value);
}

