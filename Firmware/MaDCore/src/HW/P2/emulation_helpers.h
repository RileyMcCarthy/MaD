#ifndef EMULATION_HELPERS_H
#define EMULATION_HELPERS_H
//
// Created by AI Assistant for native emulation optimizations
// @brief Helper macros to reduce CPU usage in native emulation
//

/**********************************************************************
 * Includes
 **********************************************************************/

/**********************************************************************
 * Emulation Helper Macros
 **********************************************************************/

    // No-op on real hardware
    #define EMULATION_YIELD_CPU()
    #define EMULATION_YIELD_CPU_LONG() 
    #define EMULATION_YIELD_CPU_SHORT()
    #define EMULATION_YIELD_LOCK()
    #define EMULATION_YIELD_SERIAL()

/**********************************************************************
 * End of File
 **********************************************************************/
#endif /* EMULATION_HELPERS_H */
