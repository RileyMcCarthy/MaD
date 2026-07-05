#ifndef DEV_COGMANAGER_H
#define DEV_COGMANAGER_H
//
// Created by Riley McCarthy on 25/04/24.
// @brief This file will monitor and run each cog in the system
// @details Will manage: cog allocation, cog run, watchdog kick, and cog error handling
//
/**********************************************************************
 * Includes
 **********************************************************************/
#include "dev_cogManager_config.h"
#include "dev_cogManager.h"
#include "watchdog.h"
#include "lib_utility.h"
#include "watchdog.h"
#include <stdint.h>
/**********************************************************************
 * Constants
 **********************************************************************/
#define DEV_COGMANAGER_STACK_CANARY_SIZE (100U)
/*********************************************************************
 * Macros
 **********************************************************************/

/**********************************************************************
 * Typedefs
 **********************************************************************/
typedef enum
{
    DEV_COGMANAGER_STATE_INITIALIZE,
    DEV_COGMANAGER_STATE_BOOT,
    DEV_COGMANAGER_STATE_RUNNING,
    DEV_COGMANAGER_STATE_ERROR
} dev_cogManager_state_E;

typedef struct
{
    void (*cogFunctionInit)(int lock);
    void (*cogFunctionRun)(void *arg);
    uint8_t *const stack;
    uint32_t stackSize;
    uint8_t *const lowerCanary;
    uint8_t *const upperCanary;
    uint32_t targetFrequencyHz;
    watchdog_channel_t watchdogChannel;
    const char *name;
} dev_cogManager_channelConfig_S;

#define DEV_COGMANAGER_CHANNEL_CREATE_INIT(channel, stacksize)                            \
    static uint8_t dev_cogManager_lowerCanary##channel[DEV_COGMANAGER_STACK_CANARY_SIZE]; \
    static uint8_t dev_cogManager_stack##channel[stacksize] = {0};                        \
    static uint8_t dev_cogManager_upperCanary##channel[DEV_COGMANAGER_STACK_CANARY_SIZE]; \
    static const char dev_cogManager_name##channel[] = #channel;                          \
    void dev_cogManager_taskInit##channel(int lock)

#define DEV_COGMANAGER_CHANNEL_CREATE_RUN(channel) \
    void dev_cogManager_taskRun##channel(void *arg)

#if PROPELLER_FRAMEWORK == FLEXCC
// flexc compiler does not support nested designated initializers
#define DEV_COGMANAGER_CHANNEL_CONFIG_CREATE(channel, frequency)           \
    {                                                           \
        dev_cogManager_taskInit##channel,                       \
        dev_cogManager_taskRun##channel,                        \
        dev_cogManager_stack##channel,                          \
        LIB_UTILITY_ARRAY_COUNT(dev_cogManager_stack##channel), \
        dev_cogManager_lowerCanary##channel,                    \
        dev_cogManager_upperCanary##channel,                    \
        frequency,              \
        WATCHDOG_CHANNEL_##channel,                             \
        dev_cogManager_name##channel,                           \
    }
#else
#define DEV_COGMANAGER_CHANNEL_CONFIG_CREATE(channel, frequency)           \
    [DEV_COGMANAGER_CHANNEL_##channel] = {                           \
        .cogFunctionInit = dev_cogManager_taskInit##channel,       \
        .cogFunctionRun = dev_cogManager_taskRun##channel,         \
        .stack = dev_cogManager_stack##channel,                   \
        .stackSize = LIB_UTILITY_ARRAY_COUNT(dev_cogManager_stack##channel), \
        .lowerCanary = dev_cogManager_lowerCanary##channel,       \
        .upperCanary = dev_cogManager_upperCanary##channel,       \
        .targetFrequencyHz = frequency,                           \
        .watchdogChannel = WATCHDOG_CHANNEL_##channel,            \
        .name = dev_cogManager_name##channel,                     \
    }
#endif
typedef struct
{
    const dev_cogManager_channelConfig_S channels[DEV_COGMANAGER_CHANNEL_COUNT];
} dev_cogManager_config_S;

/**********************************************************************
 * Public Function Definitions
 **********************************************************************/
void dev_cogManager_init(int lock);
void dev_cogManager_run(void);

bool dev_cogManager_isAllRunning(void);

/* Stack high-water diagnostics. `Peak` is the most stack a cog has used since
 * boot (measured from its sentinel fill); `Size` is its allocation; `Name` is
 * the channel label. Safe to call from any cog (lock-free, stale-tolerant). */
uint32_t dev_cogManager_getStackPeak(dev_cogManager_channel_E channel);
uint32_t dev_cogManager_getStackSize(dev_cogManager_channel_E channel);
const char *dev_cogManager_getName(dev_cogManager_channel_E channel);
/**********************************************************************
 * End of File
 **********************************************************************/
#endif /* DEV_COGMANAGER_H */
