#ifndef HAL_ENCODER_PRIVATE_H
#define HAL_ENCODER_PRIVATE_H

//
// Created by Riley McCarthy on 05/10/25.
// @brief Private definitions for HAL encoder implementation
//

/**********************************************************************
 * Includes
 **********************************************************************/
#include <stdint.h>
#include <stdbool.h>
#include "HAL_encoder.h"

/**********************************************************************
 * Constants
 **********************************************************************/

/*********************************************************************
 * Macros
 **********************************************************************/

/**********************************************************************
 * Typedefs
 **********************************************************************/
typedef struct
{
    int32_t pinA;                  // A input pin
    int32_t pinB;                  // B input pin  
    int32_t offset;                // Offset for preset values
    int32_t lolimit;               // Lower limit
    int32_t hilimit;               // Upper limit
    bool setup;                    // True when pin is configured
} HAL_encoder_channelData_S;

/**********************************************************************
 * Private Function Prototypes
 **********************************************************************/

/**********************************************************************
 * End of File
 **********************************************************************/
#endif /* HAL_ENCODER_PRIVATE_H */
