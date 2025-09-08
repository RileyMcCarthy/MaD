#ifndef EMULATION_HELPERS_H
#define EMULATION_HELPERS_H
//
// Created by AI Assistant for native emulation optimizations
// @brief Helper macros to reduce CPU usage in native emulation
//

/**********************************************************************
 * Includes
 **********************************************************************/
#ifdef __EMULATION__
#include <unistd.h>
#endif

/**********************************************************************
 * Emulation Helper Macros
 **********************************************************************/

// Conditional sleep for polling loops in native emulation
#ifdef __EMULATION__
    // Small sleep to yield CPU in tight polling loops
    #define EMULATION_YIELD_CPU() usleep(10)  // 10 microseconds
    
    // Longer sleep for less critical polling
    #define EMULATION_YIELD_CPU_LONG() usleep(100)  // 100 microseconds
    
    // Very short sleep for high-frequency operations
    #define EMULATION_YIELD_CPU_SHORT() usleep(1)  // 1 microsecond
    
    // Sleep for lock contention
    #define EMULATION_YIELD_LOCK() usleep(5)  // 5 microseconds
    
    // Sleep for serial/communication polling
    #define EMULATION_YIELD_SERIAL() usleep(50)  // 50 microseconds
#else
    // No-op on real hardware
    #define EMULATION_YIELD_CPU()
    #define EMULATION_YIELD_CPU_LONG() 
    #define EMULATION_YIELD_CPU_SHORT()
    #define EMULATION_YIELD_LOCK()
    #define EMULATION_YIELD_SERIAL()
#endif

/**********************************************************************
 * End of File
 **********************************************************************/
#endif /* EMULATION_HELPERS_H */
