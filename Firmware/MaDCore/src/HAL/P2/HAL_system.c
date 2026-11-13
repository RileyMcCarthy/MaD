//
// Created by Riley McCarthy on 07/02/26.
//
/**********************************************************************
 * Includes
 **********************************************************************/
#include "HAL_system.h"
#include <propeller2.h>
#include <propeller.h>
/**********************************************************************
 * Public Function Definitions
 **********************************************************************/

void HAL_system_init(void)
{
    /* Nothing to set up: the image runs on the clock and debug serial the
     * FlexC startup code leaves in place. */
}

void HAL_system_reboot(void)
{
    _reboot();
}

int HAL_system_startThread(void (*func)(void *), void *arg, void *stack, uint32_t stackSize)
{
    return _cogstart(func, arg, stack, stackSize);
}
/**********************************************************************
 * End of File
 **********************************************************************/
