//
// Created by Riley McCarthy on 25/04/24.
//
/**********************************************************************
 * Includes
 **********************************************************************/
#include <stdlib.h>
#include <stdint.h>
#include "dev_cogManager.h"
#include "HAL_lock.h"
#include "HAL_time.h"
#include "HAL_system.h"
#include "IO_Debug.h"
#include "lib_utility.h"

#include <string.h>
/**********************************************************************
 * Constants
 **********************************************************************/
/* Sentinel byte painted into each cog stack before launch. Untouched sentinel
 * bytes left at the unused (high) end measure the stack high-water mark. The
 * canary guard regions are separate and stay zeroed (their CRC baseline holds). */
#define DEV_COGMANAGER_STACK_SENTINEL (0xA5U)
/* Cadence of the stack high-water report on the debug serial. */
#define DEV_COGMANAGER_STACK_REPORT_PERIOD_US (5000000U)

/*********************************************************************
 * Macros
 **********************************************************************/
#define APP_COGMANAGER_LOCK_REQ() HAL_lock_try(dev_cogManager_data.lock)
#define APP_COGMANAGER_LOCK_REQ_BLOCK()        \
    while (APP_COGMANAGER_LOCK_REQ() == false) \
    {                                          \
    }
#define APP_COGMANAGER_LOCK_REL() HAL_lock_release(dev_cogManager_data.lock)

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
    uint32_t stackPeak; /* high-water mark of stack bytes used (0 until measured) */
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
    /* Guard against divide-by-zero for free-running (frequency == 0) channels; the
     * value is only used in the `targetFrequencyHz != 0U` branch below. */
    const uint32_t maxWaitTime = (targetFrequencyHz != 0U) ? (1000000U / targetFrequencyHz) : 0U;
    while (1)
    {
        const uint32_t startTime = HAL_time_getUs();
        watchdog_kick(config->watchdogChannel);
        config->cogFunctionRun(NULL);
        if (targetFrequencyHz != 0U)
        {
            const uint32_t endTime = HAL_time_getUs();
            const uint32_t duration = endTime - startTime;
            if (duration > maxWaitTime)
            {
#if !defined(__EMULATION__)
                // emulator doesnt run fast enough to catch this
                DEBUG_ERROR("Scheduling overrun (%u/%u us) %s\n", duration, maxWaitTime, config->name);
#endif
            }
            else
            {
                const uint32_t waitTime = maxWaitTime - duration;
                HAL_time_waitUs(waitTime);
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
        dev_cogManager_data.channels[channel].lockid = HAL_lock_create();
        dev_cogManager_config.channels[channel].cogFunctionInit(dev_cogManager_data.channels[channel].lockid);
        break;
    case DEV_COGMANAGER_STATE_BOOT:
        /* Paint the stack with a sentinel just before launch so the high-water
         * mark can be measured (untouched sentinel bytes = unused headroom).
         * Leaves the canaries alone, so their baseline CRC still holds. */
        (void)memset(dev_cogManager_config.channels[channel].stack,
                     DEV_COGMANAGER_STACK_SENTINEL,
                     dev_cogManager_config.channels[channel].stackSize);
#ifdef __FLEXC__
        /* FlexC's __builtin_cogstart is macro-like: it must launch a DIRECT, compile-time
         * function call. A runtime function pointer (e.g. through a generic HAL launcher)
         * produces a corrupt cog launch that wedges the system once >2 cogs run.
         * dev_cogManager_private_wrapper is the single statically-known launch function, so
         * call it by name here; the per-channel cogFunctionRun indirection then happens
         * safely INSIDE the cog. (Native/SIL builds keep the HAL path below.) */
        dev_cogManager_data.channels[channel].cogid = __builtin_cogstart(
            dev_cogManager_private_wrapper((void *)&dev_cogManager_config.channels[channel]),
            dev_cogManager_config.channels[channel].stack);
#else
        dev_cogManager_data.channels[channel].cogid = HAL_system_startThread(dev_cogManager_private_wrapper,
            (void *)&dev_cogManager_config.channels[channel],
            dev_cogManager_config.channels[channel].stack,
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
/* Measure each running cog's stack high-water mark from its sentinel fill and
 * periodically report it on the debug serial. Runs on the manager (main) cog,
 * which only READS the worker stacks — a byte overwritten mid-scan just makes
 * the estimate more conservative, so no lock is needed. */
static void dev_cogManager_private_monitorStacks(void)
{
    for (dev_cogManager_channel_E channel = (dev_cogManager_channel_E)0U; channel < DEV_COGMANAGER_CHANNEL_COUNT; channel++)
    {
        if (dev_cogManager_data.channels[channel].state != DEV_COGMANAGER_STATE_RUNNING)
        {
            continue;
        }
        const uint8_t *const stack = dev_cogManager_config.channels[channel].stack;
        const uint32_t size = dev_cogManager_config.channels[channel].stackSize;
        /* Stack grows up from stack[0] toward the upper canary, so untouched
         * sentinel bytes form a contiguous run at the high end; the first
         * non-sentinel from the top is the high-water mark. */
        uint32_t freeBytes = 0U;
        while ((freeBytes < size) &&
               (stack[size - 1U - freeBytes] == DEV_COGMANAGER_STACK_SENTINEL))
        {
            freeBytes++;
        }
        const uint32_t used = size - freeBytes;
        if (used > dev_cogManager_data.channels[channel].stackPeak)
        {
            dev_cogManager_data.channels[channel].stackPeak = used;
        }
    }

    static uint32_t lastReportUs = 0U;
    const uint32_t now = HAL_time_getUs();
    if ((now - lastReportUs) >= DEV_COGMANAGER_STACK_REPORT_PERIOD_US)
    {
        lastReportUs = now;
        for (dev_cogManager_channel_E channel = (dev_cogManager_channel_E)0U; channel < DEV_COGMANAGER_CHANNEL_COUNT; channel++)
        {
            const uint32_t size = dev_cogManager_config.channels[channel].stackSize;
            const uint32_t peak = dev_cogManager_data.channels[channel].stackPeak;
            DEBUG_INFO("[stack] %s: %u/%u bytes (%u%%) peak\n",
                       dev_cogManager_config.channels[channel].name,
                       peak, size, (size != 0U) ? ((peak * 100U) / size) : 0U);
        }
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
        dev_cogManager_data.channels[channel].stackPeak = 0U;
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
    dev_cogManager_private_monitorStacks();
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

uint32_t dev_cogManager_getStackPeak(dev_cogManager_channel_E channel)
{
    return (channel < DEV_COGMANAGER_CHANNEL_COUNT) ? dev_cogManager_data.channels[channel].stackPeak : 0U;
}

uint32_t dev_cogManager_getStackSize(dev_cogManager_channel_E channel)
{
    return (channel < DEV_COGMANAGER_CHANNEL_COUNT) ? dev_cogManager_config.channels[channel].stackSize : 0U;
}

const char *dev_cogManager_getName(dev_cogManager_channel_E channel)
{
    return (channel < DEV_COGMANAGER_CHANNEL_COUNT) ? dev_cogManager_config.channels[channel].name : "?";
}
/**********************************************************************
 * End of File
 **********************************************************************/
