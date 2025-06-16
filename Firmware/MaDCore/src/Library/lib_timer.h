#ifndef LIB_TIMER_H
#define LIB_TIMER_H
//
// Created by Riley McCarthy on 25/04/24.
//
/**********************************************************************
 * Includes
 **********************************************************************/
#include <stdbool.h>
#include <stdint.h>
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
    lib_timer_STATE_OFF,
    lib_timer_STATE_RUNNING,
    lib_timer_STATE_EXPIRED,
    lib_timer_STATE_COUNT,
} lib_timer_state_E;

typedef struct
{
    uint32_t startms;
    uint32_t periodms;
    lib_timer_state_E state;
} lib_timer_S;
/**********************************************************************
 * Public Function Definitions
 **********************************************************************/
void lib_timer_init(lib_timer_S *timer, uint32_t periodms);
void lib_timer_start(lib_timer_S *timer);
void lib_timer_stop(lib_timer_S *timer);
lib_timer_state_E lib_timer_state(lib_timer_S *timer);
bool lib_timer_expired(lib_timer_S *timer);
/**********************************************************************
 * End of File
 **********************************************************************/
#endif /* LIB_TIMER_H */
