//
// Created by Riley McCarthy on 07/02/26.
//
/**********************************************************************
 * Includes
 **********************************************************************/
#include "HAL_time.h"
#include <propeller2.h>
/**********************************************************************
 * Public Function Definitions
 **********************************************************************/

uint32_t HAL_time_getMs(void)
{
    return _getms();
}

uint32_t HAL_time_getUs(void)
{
    return _getus();
}

void HAL_time_waitMs(uint32_t ms)
{
    _waitms(ms);
}

void HAL_time_waitUs(uint32_t us)
{
    _waitus(us);
}

uint32_t HAL_time_getCycles(void)
{
    return _cnt();
}

uint32_t HAL_time_getClockFreq(void)
{
    return _clockfreq();
}
/**********************************************************************
 * End of File
 **********************************************************************/
