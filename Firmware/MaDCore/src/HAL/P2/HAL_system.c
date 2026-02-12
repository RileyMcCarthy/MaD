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
#if PROPELLER_FRAMEWORK == P2LLVM
    _clkset(_SETFREQ, _CLOCKFREQ);
    _uart_init(DBG_UART_RX_PIN, DBG_UART_TX_PIN, 230400, 0);
#endif
}

void HAL_system_reboot(void)
{
    _reboot();
}

int HAL_system_startThread(void (*func)(void *), void *arg, void *stack, uint32_t stackSize)
{
#ifdef __FLEXC__
    return _cogstart(func, arg, stack, stackSize);
#else
    return cogstart(func, (int)(intptr_t)arg, (int *)stack, stackSize);
#endif
}
/**********************************************************************
 * End of File
 **********************************************************************/
