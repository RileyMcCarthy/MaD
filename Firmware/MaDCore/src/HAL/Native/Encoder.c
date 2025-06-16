#include "Encoder.h"
#include <stdlib.h>
#include <propeller2.h>
#include "SocketIO.h"
#include "IO_Debug.h"

void encoder_start(Encoder *self, uint8_t pinA, uint8_t pinB, uint8_t btn, bool d4x, int32_t preset, int32_t lo, int32_t hi)
{
    if (self != NULL)
    {
        self->socket_a = get_pin_socketid(pinA);
        self->socket_b = get_pin_socketid(pinB);
    }
}
int32_t encoder_value(Encoder *self)
{
    int32_t value = 0;
    if (self != NULL)
    {
        uint8_t recv_a;
        uint8_t recv_b;
        while (socketio_poll(self->socket_a) || socketio_poll(self->socket_b))
        {
            if (socketio_receive(self->socket_a, &recv_a, 1) == 1)
            {
                self->value += recv_a;
            }

            if (socketio_receive(self->socket_b, &recv_b, 1) == 1)
            {
                self->value -= recv_b;
            }
        }
        value = self->value;
    }
    return value;
}
void encoder_set(Encoder *self, int32_t value)
{
    if (self != NULL)
    {
        self->value = value;
    }
}

