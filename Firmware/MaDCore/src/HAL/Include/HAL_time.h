#ifndef HAL_TIME_H
#define HAL_TIME_H
//
// Created by Riley McCarthy on 07/02/26.
// @brief Timing abstraction for delays and time measurement
//
/**********************************************************************
 * Includes
 **********************************************************************/
#include <stdint.h>
/**********************************************************************
 * Public Function Definitions
 **********************************************************************/

/**
 * @brief Get milliseconds elapsed since system start
 * @return Milliseconds (wraps at ~49 days)
 */
uint32_t HAL_time_getMs(void);

/**
 * @brief Get microseconds elapsed since system start
 * @return Microseconds (wraps at ~71 minutes)
 */
uint32_t HAL_time_getUs(void);

/**
 * @brief Blocking wait for specified milliseconds
 * @param ms Milliseconds to wait
 */
void HAL_time_waitMs(uint32_t ms);

/**
 * @brief Blocking wait for specified microseconds
 * @param us Microseconds to wait
 */
void HAL_time_waitUs(uint32_t us);

/**
 * @brief Get raw cycle counter value
 * @return Clock cycles since system start
 */
uint32_t HAL_time_getCycles(void);

/**
 * @brief Get system clock frequency in Hz
 * @return Clock frequency
 */
uint32_t HAL_time_getClockFreq(void);

/**********************************************************************
 * End of File
 **********************************************************************/
#endif /* HAL_TIME_H */
