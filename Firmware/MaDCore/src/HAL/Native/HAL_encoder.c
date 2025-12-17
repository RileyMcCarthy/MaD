#include "HAL_encoder.h"
#include <stdlib.h>
#include <propeller2.h>
#include "SocketIO.h"
#include "IO_Debug.h"
#include "HW_pins.h"

// Static array to store encoder data for each channel
static HAL_encoder_channelData_S HAL_encoder_channelData[HAL_ENCODER_CHANNEL_COUNT];

// Hardware configuration for each encoder channel
static const HAL_encoder_config_S HAL_encoder_config[HAL_ENCODER_CHANNEL_COUNT] = {
    [HAL_ENCODER_CHANNEL_SERVO] = {
        .pinA = HW_PIN_SERVO_ENCODER_A,
        .pinB = HW_PIN_SERVO_ENCODER_B,
        .preset = 0,
        .lo = -1000000,
        .hi = 1000000,
    },
};

void HAL_encoder_start(HAL_encoder_channel_E channel)
{
    if (channel >= HAL_ENCODER_CHANNEL_COUNT)
    {
        return;
    }
    
    // Get configuration for this channel
    const HAL_encoder_config_S *config = &HAL_encoder_config[channel];
    
    HAL_encoder_channelData[channel].socket_a = get_pin_socketid(config->pinA);
    HAL_encoder_channelData[channel].socket_b = get_pin_socketid(config->pinB);
    HAL_encoder_channelData[channel].value = config->preset;
    HAL_encoder_channelData[channel].setup = true;
}

int32_t HAL_encoder_value(HAL_encoder_channel_E channel)
{
    int32_t value = 0;
    if (channel < HAL_ENCODER_CHANNEL_COUNT && HAL_encoder_channelData[channel].setup)
    {
        uint8_t recv_a;
        uint8_t recv_b;
        while (socketio_poll(HAL_encoder_channelData[channel].socket_a) || socketio_poll(HAL_encoder_channelData[channel].socket_b))
        {
            if (socketio_receive(HAL_encoder_channelData[channel].socket_a, &recv_a, 1) == 1)
            {
                HAL_encoder_channelData[channel].value += recv_a;
            }

            if (socketio_receive(HAL_encoder_channelData[channel].socket_b, &recv_b, 1) == 1)
            {
                HAL_encoder_channelData[channel].value -= recv_b;
            }
        }
        value = HAL_encoder_channelData[channel].value;
    }
    return value;
}

void HAL_encoder_set(HAL_encoder_channel_E channel, int32_t value)
{
    if (channel < HAL_ENCODER_CHANNEL_COUNT && HAL_encoder_channelData[channel].setup)
    {
        HAL_encoder_channelData[channel].value = value;
    }
}

