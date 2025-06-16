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
    DEV_COGMANAGER_STATE_INIT,
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
} dev_cogManager_channelConfig_S;

#define DEV_COGMANAGER_CHANNEL_CREATE_INIT(channel, stacksize)                            \
    static uint8_t dev_cogManager_lowerCanary##channel[DEV_COGMANAGER_STACK_CANARY_SIZE]; \
    static uint8_t dev_cogManager_stack##channel[stacksize] = {0};                        \
    static uint8_t dev_cogManager_upperCanary##channel[DEV_COGMANAGER_STACK_CANARY_SIZE]; \
    void dev_cogManager_taskInit##channel(int lock)

#define DEV_COGMANAGER_CHANNEL_CREATE_RUN(channel) \
    void dev_cogManager_taskRun##channel(void *arg)

#define DEV_COGMANAGER_CHANNEL_CONFIG_CREATE(channel)           \
    {                                                           \
        dev_cogManager_taskInit##channel,                       \
        dev_cogManager_taskRun##channel,                        \
        dev_cogManager_stack##channel,                          \
        LIB_UTILITY_ARRAY_COUNT(dev_cogManager_stack##channel), \
        dev_cogManager_lowerCanary##channel,                    \
        dev_cogManager_upperCanary##channel,                    \
    }

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
/**********************************************************************
 * End of File
 **********************************************************************/
#endif /* DEV_COGMANAGER_H */
