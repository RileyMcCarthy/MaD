#ifndef DEBUG_H
#define DEBUG_H

#include <stdio.h>
#include "HAL_lock.h"
#include "HAL_time.h"
#include "HAL_serial.h"

#define ANSI_COLOR_RED "\x1b[31m"
#define ANSI_COLOR_GREEN "\x1b[32m"
#define ANSI_COLOR_YELLOW "\x1b[33m"
#define ANSI_COLOR_BLUE "\x1b[34m"
#define ANSI_COLOR_MAGENTA "\x1b[35m"
#define ANSI_COLOR_CYAN "\x1b[36m"
#define ANSI_COLOR_RESET "\x1b[0m"

extern int _stdio_debug_lock;

#if ENABLE_DEBUG_SERIAL
// if we have a seperate debug serial port, we can use the raw printf. This is useful for debugging
#define DEBUG_PRINTF_RAW(color, fmt, ...)                                                                                  \
    while (!HAL_lock_try(_stdio_debug_lock))                                                                                   \
    {                                                                                                                      \
    }                                                                                                                      \
    fprintf(stdout, color "%0.3f - %s:%d: " fmt ANSI_COLOR_RESET, HAL_time_getUs() / 1000000.0f, __FILE__, __LINE__, __VA_ARGS__); \
    HAL_lock_release(_stdio_debug_lock);
#else
#define DEBUG_PRINTF_RAW(color, fmt, ...)
#endif

#define DEBUG_MESSAGE(color, fmt, ...)DEBUG_PRINTF_RAW(color, fmt, __VA_ARGS__);

#define DEBUG_WARNING(fmt, ...) DEBUG_MESSAGE(ANSI_COLOR_YELLOW, fmt, __VA_ARGS__);

#define DEBUG_INFO(fmt, ...) DEBUG_MESSAGE(ANSI_COLOR_GREEN, fmt, __VA_ARGS__);

#define DEBUG_ERROR(fmt, ...) DEBUG_MESSAGE(ANSI_COLOR_RED, fmt, __VA_ARGS__);

#endif
