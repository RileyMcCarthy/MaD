//
// Created by Riley McCarthy on 25/04/24.
//
/**********************************************************************
 * Includes
 **********************************************************************/
#include "lib_timer.h"
#include "propeller2.h"
/**********************************************************************
 * Constants
 **********************************************************************/

/*********************************************************************
 * Macros
 **********************************************************************/

/**********************************************************************
 * Typedefs
 **********************************************************************/

/**********************************************************************
 * External Variables
 **********************************************************************/

/**********************************************************************
 * Private Variable Definitions
 **********************************************************************/

/**********************************************************************
 * Private Function Prototypes
 **********************************************************************/

/**********************************************************************
 * Private Function Definitions
 **********************************************************************/
uint32_t lib_timer_private_getms()
{
    return _getms();
}
/**********************************************************************
 * Public Function Definitions
 **********************************************************************/

void lib_timer_init(lib_timer_S *timer, uint32_t periodms)
{
    timer->periodms = periodms;
    timer->state = lib_timer_STATE_OFF;
    timer->startms = 0U;
}

void lib_timer_start(lib_timer_S *timer)
{
    timer->startms = lib_timer_private_getms();
    timer->state = lib_timer_STATE_RUNNING;
}

void lib_timer_stop(lib_timer_S *timer)
{
    timer->startms = 0U;
    timer->state = lib_timer_STATE_OFF;
}

lib_timer_state_E lib_timer_state(lib_timer_S *timer)
{
    const uint32_t currentms = lib_timer_private_getms();
    switch (timer->state)
    {
    case lib_timer_STATE_OFF:
        break;
    case lib_timer_STATE_RUNNING:
        // If timer is uint32_t rollover is 49 days...
        if ((currentms - timer->startms) > timer->periodms)
        {
            timer->state = lib_timer_STATE_EXPIRED;
        }
        break;
    case lib_timer_STATE_EXPIRED:
    case lib_timer_STATE_COUNT:
    default:
        break;
    }
    return timer->state;
}

bool lib_timer_expired(lib_timer_S *timer)
{
    return lib_timer_state(timer) == lib_timer_STATE_EXPIRED;
}

/**********************************************************************
 * End of File
 **********************************************************************/
