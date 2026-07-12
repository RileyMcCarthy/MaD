//
// Created by Riley McCarthy on 05/10/25.
//
/**********************************************************************
 * Includes
 **********************************************************************/
#include "HAL_encoder.h"
#include "HAL_encoder_private.h"
#include "IO_Debug.h"
#include "HW_pins.h"

#include "propeller2.h"
#include "smartpins.h"

/**********************************************************************
 * Constants
 **********************************************************************/

/*********************************************************************
 * Macros
 **********************************************************************/
#define ABS(x) ((x) < 0 ? -(x) : (x))

/**********************************************************************
 * Typedefs
 **********************************************************************/

/**********************************************************************
 * External Variables
 **********************************************************************/

/**********************************************************************
 * Private Variable Definitions
 **********************************************************************/
static HAL_encoder_channelData_S HAL_encoder_channelData[HAL_ENCODER_CHANNEL_COUNT];

// channel config table lives in HAL/Config/HAL_encoder_config.c (data-only, all targets)

/**********************************************************************
 * Private Function Prototypes
 **********************************************************************/

/**********************************************************************
 * Private Function Definitions
 **********************************************************************/

/**********************************************************************
 * Public Function Definitions
 **********************************************************************/

void HAL_encoder_init(void)
{
    // Initialize all encoder channel data to zero
    // Use memset to avoid SROA bug in p2llvm that mistyping int32_t fields as i1
    memset(HAL_encoder_channelData, 0, sizeof(HAL_encoder_channelData));
}

void HAL_encoder_start(HAL_encoder_channel_E channel)
{
    if (channel >= HAL_ENCODER_CHANNEL_COUNT)
    {
        return;
    }
    
    // Get configuration for this channel
    const HAL_encoder_config_S *config = &HAL_encoder_config[channel];
    
    // Stop any existing encoder first
    if (HAL_encoder_channelData[channel].setup)
    {
        _pinclear(HAL_encoder_channelData[channel].pinA);
    }
    
    // Check pin difference - B pin must be within +/-3 of A pin
    int32_t dif = config->pinB - config->pinA;
    if ((dif == 0) || (ABS(dif) > 3))
    {
        return;
    }
    
    // Store configuration
    HAL_encoder_channelData[channel].pinA = config->pinA;
    HAL_encoder_channelData[channel].pinB = config->pinB;
    HAL_encoder_channelData[channel].lolimit = config->lo;
    HAL_encoder_channelData[channel].hilimit = config->hi;
    
    // Configure smart pin for quadrature mode
    // P_QUADRATURE mode with pin difference encoded in bits 24-26
    uint32_t pin_mode = P_QUADRATURE | ((dif & 0x7) << 24);
    _pinstart(config->pinA, pin_mode, 0, 0);
    
    // Set initial value
    HAL_encoder_channelData[channel].offset = config->preset;
    
    HAL_encoder_channelData[channel].setup = true;
}

int32_t HAL_encoder_value(HAL_encoder_channel_E channel)
{
    if (channel >= HAL_ENCODER_CHANNEL_COUNT)
    {
        return 0;
    }
    
    if (!HAL_encoder_channelData[channel].setup)
    {
        return 0;
    }
    
    // Read raw value from smart pin
    int32_t raw_value = (int32_t)_rdpin(HAL_encoder_channelData[channel].pinA);
    int32_t result = raw_value + HAL_encoder_channelData[channel].offset;
    
    // Apply limits
    if (result < HAL_encoder_channelData[channel].lolimit)
    {
        result = HAL_encoder_channelData[channel].lolimit;
        HAL_encoder_channelData[channel].offset = result;
    }
    else if (result > HAL_encoder_channelData[channel].hilimit)
    {
        result = HAL_encoder_channelData[channel].hilimit;
        HAL_encoder_channelData[channel].offset = result;
    }
    
    return result;
}

void HAL_encoder_set(HAL_encoder_channel_E channel, int32_t value)
{
    if (channel >= HAL_ENCODER_CHANNEL_COUNT)
    {
        return;
    }
    
    if (!HAL_encoder_channelData[channel].setup)
    {
        return;
    }
    
    // Reset and clear the smart pin
    _pinclear(HAL_encoder_channelData[channel].pinA);
    
    // Restart the pin
    int32_t dif = HAL_encoder_channelData[channel].pinB - HAL_encoder_channelData[channel].pinA;
    uint32_t pin_mode = P_QUADRATURE | ((dif & 0x7) << 24);
    _pinstart(HAL_encoder_channelData[channel].pinA, pin_mode, 0, 0);
    
    // Set the offset to achieve the desired preset value
    HAL_encoder_channelData[channel].offset = value;
}

/**********************************************************************
 * End of File
 **********************************************************************/
