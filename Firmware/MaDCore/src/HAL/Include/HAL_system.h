#ifndef HAL_SYSTEM_H
#define HAL_SYSTEM_H
//
// Created by Riley McCarthy on 07/02/26.
// @brief System abstraction for platform init, reboot, and thread/cog management
//
/**********************************************************************
 * Includes
 **********************************************************************/
#include <stdint.h>
/**********************************************************************
 * Public Function Definitions
 **********************************************************************/

/**
 * @brief Initialize the platform (clock setup on P2, simulator init on native)
 */
void HAL_system_init(void);

/**
 * @brief Reboot the system
 */
void HAL_system_reboot(void);

/**
 * @brief Start a new thread/cog
 * @param func Function to execute on the new thread/cog
 * @param arg Argument passed to func
 * @param stack Pointer to stack memory (may be ignored on native)
 * @param stackSize Size of stack in bytes
 * @return >= 0 on success (cog/thread ID), -1 on failure
 */
int HAL_system_startThread(void (*func)(void *), void *arg, void *stack, uint32_t stackSize);

/**********************************************************************
 * End of File
 **********************************************************************/
#endif /* HAL_SYSTEM_H */
