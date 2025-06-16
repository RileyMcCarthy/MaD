#ifndef IO_POSITION_FEEDBACK_H
#define IO_POSITION_FEEDBACK_H
//
// Created by Riley McCarthy on 25/04/24.
// @brief this file might not need to exist, should be IO
//
/**********************************************************************
 * Includes
 **********************************************************************/
#include <stdint.h>
#include <stdbool.h>
/**********************************************************************
 * Constants
 **********************************************************************/

/*********************************************************************
 * Macros
 **********************************************************************/

/**********************************************************************
 * Typedefs
 **********************************************************************/
typedef enum
{
    IO_POSITION_FEEDBACK_CHANNEL_SERVO_FEEDBACK,
    IO_POSITION_FEEDBACK_CHANNEL_COUNT,
} IO_positionFeedback_channel_E;
/**********************************************************************
 * Public Function Definitions
 **********************************************************************/
void IO_positionFeedback_init(IO_positionFeedback_channel_E ch, int lock, int32_t stepPerUM);
int32_t IO_positionFeedback_getValue(IO_positionFeedback_channel_E ch);
bool IO_positionFeedback_setValue(IO_positionFeedback_channel_E ch, int32_t positionUM);
/**********************************************************************
 * End of File
 **********************************************************************/
#endif /* IO_POSITION_FEEDBACK_H */
