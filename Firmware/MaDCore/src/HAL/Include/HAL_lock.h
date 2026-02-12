#ifndef HAL_LOCK_H
#define HAL_LOCK_H
//
// Created by Riley McCarthy on 07/02/26.
// @brief Hardware lock abstraction for mutual exclusion across cogs/threads
//
/**********************************************************************
 * Includes
 **********************************************************************/
#include <stdint.h>
#include <stdbool.h>
/**********************************************************************
 * Public Function Definitions
 **********************************************************************/

/**
 * @brief Allocate a new hardware lock
 * @return Lock ID (>= 0 on success, -1 on failure)
 */
int32_t HAL_lock_create(void);

/**
 * @brief Non-blocking lock acquire attempt
 * @param lock Lock ID from HAL_lock_create
 * @return true if lock was acquired, false if already held
 */
bool HAL_lock_try(int32_t lock);

/**
 * @brief Release a previously acquired lock
 * @param lock Lock ID from HAL_lock_create
 */
void HAL_lock_release(int32_t lock);

/**********************************************************************
 * End of File
 **********************************************************************/
#endif /* HAL_LOCK_H */
