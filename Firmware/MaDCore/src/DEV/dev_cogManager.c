//
// Created by Riley McCarthy on 25/04/24.
//
/**********************************************************************
 * Includes
 **********************************************************************/
#include <propeller.h>
#include <stdlib.h>
#include <stdint.h>
#include "dev_cogManager.h"
#include "IO_Debug.h"
#include "lib_utility.h"
#include "emulation_helpers.h"

#include <string.h>
/**********************************************************************
 * Constants
 **********************************************************************/

/*********************************************************************
 * Macros
 **********************************************************************/
#define APP_COGMANAGER_LOCK_REQ() _locktry(dev_cogManager_data.lock)
#define APP_COGMANAGER_LOCK_REQ_BLOCK()        \
    while (APP_COGMANAGER_LOCK_REQ() == false) \
    {                                          \
        EMULATION_YIELD_LOCK();                \
    }
#define APP_COGMANAGER_LOCK_REL() _lockrel(dev_cogManager_data.lock)

/**********************************************************************
 * Typedefs
 **********************************************************************/

typedef struct
{
    bool running;
} dev_cogManager_channelOutput_S;

typedef struct
{
    dev_cogManager_state_E state;
    int cogid;
    int lockid;
    uint8_t crcLower;
    uint8_t crcUpper;
    dev_cogManager_channelOutput_S output;
} dev_cogManager_channelData_S;

typedef struct
{
    dev_cogManager_channelData_S channels[DEV_COGMANAGER_CHANNEL_COUNT];
    int lock;
} dev_cogManager_data_S;

/**********************************************************************
 * External Variables
 **********************************************************************/
extern const dev_cogManager_config_S dev_cogManager_config;
/**********************************************************************
 * Private Variable Definitions
 **********************************************************************/
static dev_cogManager_data_S dev_cogManager_data;
/**********************************************************************
 * Private Function Definitions
 **********************************************************************/

static void dev_cogManager_private_wrapper(void *arg)
{
    const dev_cogManager_channelConfig_S * config = (dev_cogManager_channelConfig_S *)arg;
    const uint32_t targetFrequencyHz = config->targetFrequencyHz;
    const uint32_t maxWaitTime = 1000000 / targetFrequencyHz;
    while (1)
    {
        const uint32_t startTime = _getus();
        watchdog_kick(config->watchdogChannel);
        config->cogFunctionRun(NULL);
        if (targetFrequencyHz != 0U)
        {
            const uint32_t endTime = _getus();
            const uint32_t duration = endTime - startTime;
            if (duration > maxWaitTime)
            {
#if !defined(__EMULATION__)
                // emulator doesnt run fast enough to catch this
                DEBUG_ERROR("Scheduling overrun (%d/%d us) %s\n", duration, maxWaitTime, config->name);
#endif
            }
            else
            {
                const uint32_t waitTime = maxWaitTime - duration;
                _waitus(waitTime);
            }
        }
    }
}

void dev_cogManager_private_stageOutput(dev_cogManager_channel_E channel)
{
    APP_COGMANAGER_LOCK_REQ_BLOCK();
    dev_cogManager_data.channels[channel].output.running = dev_cogManager_data.channels[channel].state == DEV_COGMANAGER_STATE_RUNNING;
    APP_COGMANAGER_LOCK_REL();
}

dev_cogManager_state_E dev_cogManager_getDesiredState(dev_cogManager_channel_E channel)
{
    dev_cogManager_state_E desiredState = dev_cogManager_data.channels[channel].state;
    switch (dev_cogManager_data.channels[channel].state)
    {
    case DEV_COGMANAGER_STATE_INITIALIZE:
        if (dev_cogManager_data.channels[channel].lockid == -1)
        {
            desiredState = DEV_COGMANAGER_STATE_ERROR;
            DEBUG_ERROR("Lock not created for channel %d\n", channel);
        }
        else
        {
            desiredState = DEV_COGMANAGER_STATE_BOOT;
        }
        break;
    case DEV_COGMANAGER_STATE_BOOT:
        if (dev_cogManager_data.channels[channel].cogid != -1)
        {
            desiredState = DEV_COGMANAGER_STATE_RUNNING;
        }
        break;
    case DEV_COGMANAGER_STATE_RUNNING:
        break;
    case DEV_COGMANAGER_STATE_ERROR:
        break;
    default:
        break;
    }
    return desiredState;
}

void dev_cogManager_entryAction(dev_cogManager_channel_E channel)
{
    switch (dev_cogManager_data.channels[channel].state)
    {
    case DEV_COGMANAGER_STATE_INITIALIZE:
        dev_cogManager_data.channels[channel].lockid = _locknew();
        dev_cogManager_config.channels[channel].cogFunctionInit(dev_cogManager_data.channels[channel].lockid);
        break;
    case DEV_COGMANAGER_STATE_BOOT:
#ifdef __FLEXC__
    dev_cogManager_data.channels[channel].cogid = _cogstart(dev_cogManager_private_wrapper,
        (void *)&dev_cogManager_config.channels[channel],
        dev_cogManager_config.channels[channel].stack,
        dev_cogManager_config.channels[channel].stackSize);
#else
        dev_cogManager_data.channels[channel].cogid = cogstart(dev_cogManager_private_wrapper,
                                                                (int)(intptr_t)&dev_cogManager_config.channels[channel],
                                                                (int *)dev_cogManager_config.channels[channel].stack,
                                                                dev_cogManager_config.channels[channel].stackSize);
#endif
        break;
    case DEV_COGMANAGER_STATE_RUNNING:
        break;
    case DEV_COGMANAGER_STATE_ERROR:
        break;
    default:
        break;
    }
}

void dev_cogManager_runAction(dev_cogManager_channel_E channel)
{
    switch (dev_cogManager_data.channels[channel].state)
    {
    case DEV_COGMANAGER_STATE_INITIALIZE:
        break;
    case DEV_COGMANAGER_STATE_BOOT:
        break;
    case DEV_COGMANAGER_STATE_RUNNING:
    {
        uint8_t crcLower = lib_utility_CRC8(&dev_cogManager_config.channels[channel].lowerCanary[0], DEV_COGMANAGER_STACK_CANARY_SIZE);
        uint8_t crcUpper = lib_utility_CRC8(&dev_cogManager_config.channels[channel].upperCanary[0], DEV_COGMANAGER_STACK_CANARY_SIZE);
        if (crcLower != dev_cogManager_data.channels[channel].crcLower)
        {
            DEBUG_ERROR("Stack overflow detected on channel %d\n", channel);
            dev_cogManager_data.channels[channel].state = DEV_COGMANAGER_STATE_ERROR;
        }
        else if (crcUpper != dev_cogManager_data.channels[channel].crcUpper)
        {
            DEBUG_ERROR("Stack underflow detected on channel %d\n", channel);
            dev_cogManager_data.channels[channel].state = DEV_COGMANAGER_STATE_ERROR;
        }
        else
        {
            // DEBUG_ERROR("Stack OK on channel %d: %d == %d\n", channel, crcLower, dev_cogManager_data.channels[channel].crcLower);
        }
    }
    break;
    case DEV_COGMANAGER_STATE_ERROR:
        break;
    default:
        break;
    }
}
/**********************************************************************
 * Public Function Definitions
 **********************************************************************/
void dev_cogManager_init(int lock)
{
    dev_cogManager_data.lock = lock;
    for (dev_cogManager_channel_E channel = (dev_cogManager_channel_E)0U; channel < DEV_COGMANAGER_CHANNEL_COUNT; channel++)
    {
        dev_cogManager_data.channels[channel].state = DEV_COGMANAGER_STATE_INITIALIZE;
        dev_cogManager_data.channels[channel].cogid = -1;
        dev_cogManager_data.channels[channel].crcLower = lib_utility_CRC8(dev_cogManager_config.channels[channel].lowerCanary, DEV_COGMANAGER_STACK_CANARY_SIZE);
        dev_cogManager_data.channels[channel].crcUpper = lib_utility_CRC8(dev_cogManager_config.channels[channel].upperCanary, DEV_COGMANAGER_STACK_CANARY_SIZE);
        dev_cogManager_entryAction(channel);
    }
}

void dev_cogManager_run(void)
{
    for (dev_cogManager_channel_E channel = (dev_cogManager_channel_E)0U; channel < DEV_COGMANAGER_CHANNEL_COUNT; channel++)
    {
        dev_cogManager_state_E currentState = dev_cogManager_data.channels[channel].state;
        dev_cogManager_state_E desiredState = dev_cogManager_getDesiredState(channel);
        if (desiredState != currentState)
        {
            dev_cogManager_data.channels[channel].state = desiredState;
            dev_cogManager_entryAction(channel);
        }
        dev_cogManager_runAction(channel);
        dev_cogManager_private_stageOutput(channel);
    }
}

bool dev_cogManager_isAllRunning(void)
{
    bool isRunning = true;
    APP_COGMANAGER_LOCK_REQ_BLOCK();
    for (dev_cogManager_channel_E channel = (dev_cogManager_channel_E)0U; channel < DEV_COGMANAGER_CHANNEL_COUNT; channel++)
    {
        if (dev_cogManager_data.channels[channel].output.running == false)
        {
            isRunning = false;
            break;
        }
    }
    APP_COGMANAGER_LOCK_REL();
    return isRunning;
}
/**********************************************************************
 * End of File
 **********************************************************************/
