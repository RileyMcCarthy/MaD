//
// Created by Riley McCarthy on 25/04/24.
//
/**********************************************************************
 * Includes
 **********************************************************************/
#include "propeller2.h"
#include <time.h>
#include <stdlib.h>
#include <string.h>
#include "watchdog.h"
#include "IO_Debug.h"
/**********************************************************************
 * Constants
 **********************************************************************/
#define TIMEOUT_WARNING 100U // Timeout for each channel
#define TIMEOUT_ERROR 2000U  // Timeout for each channel
/*********************************************************************
 * Macros
 **********************************************************************/
#define SM_LOCK_REQ() _locktry(watchdog_data.lock)
#define SM_LOCK_REQ_BLOCK()        \
    while (SM_LOCK_REQ() == false) \
        ;
#define SM_LOCK_REL() _lockrel(watchdog_data.lock)

#define WATCHDOG_CHANNEL_VALID(channel) (channel >= 0 || channel < WATCHDOG_CHANNEL_COUNT)
/**********************************************************************
 * Typedefs
 **********************************************************************/

typedef enum
{
    WATCHDOG_INIT,
    WATCHDOG_OK,
    WATCHDOG_ERROR
} watchdog_state_t;

typedef struct
{
    uint32_t lastKick;
} watchdog_channelRequest_t;

typedef struct
{
    uint32_t timeBetweenKick;
    bool isAlive;
} watchdog_channelOutput_t;

typedef struct
{
    watchdog_channelRequest_t stagedRequest;
    watchdog_channelRequest_t request;

    watchdog_state_t state;

    watchdog_channelOutput_t stagedOutput;
    watchdog_channelOutput_t output;
} watchdog_channelData_t;

typedef struct
{
    int lock;
    watchdog_channelData_t channels[WATCHDOG_CHANNEL_COUNT];
} watchdog_data_t;

/**********************************************************************
 * Private Variable Definitions
 **********************************************************************/
static watchdog_data_t watchdog_data;
/**********************************************************************
 * Private Function Prototypes
 **********************************************************************/

/**********************************************************************
 * Private Function Definitions
 **********************************************************************/
void watchdog_private_stageRequest(watchdog_channel_t channel)
{
    SM_LOCK_REQ_BLOCK();
    memcpy(&watchdog_data.channels[channel].request, &watchdog_data.channels[channel].stagedRequest, sizeof(watchdog_channelRequest_t));
    SM_LOCK_REL();
}

void watchdog_private_stageOutput(watchdog_channel_t channel)
{
    SM_LOCK_REQ_BLOCK();
    memcpy(&watchdog_data.channels[channel].output, &watchdog_data.channels[channel].stagedOutput, sizeof(watchdog_channelOutput_t));
    SM_LOCK_REL();
}

void watchdog_private_processInputs(watchdog_channel_t channel)
{
    const uint32_t lastKick = watchdog_data.channels[channel].request.lastKick;
    const uint32_t currentTime = _getms();

    uint32_t timeSinceLastKick = currentTime - lastKick;
    if (lastKick > currentTime)
    {
        // Time has wrapped around
        DEBUG_ERROR("%s", "Time has wrapped around\n");
        timeSinceLastKick = 0; // assuming its fine I guess :(
    }

    watchdog_data.channels[channel].stagedOutput.timeBetweenKick = timeSinceLastKick;
}

watchdog_state_t watchdog_private_getDesiredState(watchdog_channel_t channel)
{
    watchdog_state_t desiredState = watchdog_data.channels[channel].state;
    const bool timeout = (watchdog_data.channels[channel].stagedOutput.timeBetweenKick >= TIMEOUT_ERROR);
    switch (watchdog_data.channels[channel].state)
    {
    case WATCHDOG_INIT:
        desiredState = WATCHDOG_OK;
        break;
    case WATCHDOG_OK:
        if (timeout)
        {
            desiredState = WATCHDOG_ERROR;
        }
        break;
    case WATCHDOG_ERROR:
        if (timeout == false)
        {
            desiredState = WATCHDOG_OK;
        }
        break;
    default:
        break;
    }
    return desiredState;
}

void watchdog_private_exitAction(watchdog_channel_t channel, watchdog_state_t currentState)
{
    switch (currentState)
    {
    case WATCHDOG_INIT:
        break;
    case WATCHDOG_OK:
        break;
    case WATCHDOG_ERROR:
        DEBUG_WARNING("Watchdog channel %d is now responding\n", channel);
        break;
    default:
        break;
    }
}

void watchdog_private_entryAction(watchdog_channel_t channel, watchdog_state_t desiredState)
{
    switch (desiredState)
    {
    case WATCHDOG_INIT:
        watchdog_data.channels[channel].stagedOutput.isAlive = true;
        break;
    case WATCHDOG_OK:
        watchdog_data.channels[channel].stagedOutput.isAlive = true;
        break;
    case WATCHDOG_ERROR:
        watchdog_data.channels[channel].stagedOutput.isAlive = false;
        DEBUG_ERROR("Watchdog channel %d is not responding\n", channel);
        break;
    default:
        break; // should throw error
    }
}

void watchdog_private_runAction(watchdog_channel_t channel, watchdog_state_t desiredState)
{
    switch (desiredState)
    {
    case WATCHDOG_INIT:
        break;
    case WATCHDOG_OK:
        break;
    case WATCHDOG_ERROR:
        break;
    default:
        break; // should throw error
    }
}
/**********************************************************************
 * Public Function Definitions
 **********************************************************************/

void watchdog_init(int lock)
{
    watchdog_data.lock = lock;
    for (watchdog_channel_t channel = (watchdog_channel_t)0U; channel < WATCHDOG_CHANNEL_COUNT; channel++)
    {
        watchdog_data.channels[channel].state = WATCHDOG_INIT;
        watchdog_data.channels[channel].stagedRequest.lastKick = _getms();
        watchdog_data.channels[channel].stagedOutput.timeBetweenKick = 0;
        watchdog_data.channels[channel].stagedOutput.isAlive = true;
        watchdog_private_stageOutput(channel);
    }
}

void watchdog_run()
{
    // can config librarys to have dependencies on each other
    // should config this to have a dependency on a timer library and cog management library

    for (watchdog_channel_t channel = (watchdog_channel_t)0U; channel < WATCHDOG_CHANNEL_COUNT; channel++)
    {
        watchdog_private_stageRequest(channel);
        watchdog_private_processInputs(channel);

        watchdog_state_t currentState = watchdog_data.channels[channel].state;
        watchdog_state_t desiredState = watchdog_private_getDesiredState(channel);
        if (desiredState != currentState)
        {
            watchdog_private_exitAction(channel, currentState);
            watchdog_private_entryAction(channel, desiredState);
        }

        watchdog_private_runAction(channel, desiredState);

        watchdog_data.channels[channel].state = desiredState;

        watchdog_private_stageOutput(channel);
    }
}

void watchdog_kick(watchdog_channel_t channel)
{
    if (WATCHDOG_CHANNEL_VALID(channel))
    {
        SM_LOCK_REQ_BLOCK();
        watchdog_data.channels[channel].stagedRequest.lastKick = _getms();
        SM_LOCK_REL();
    }
}

bool watchdog_isAlive(watchdog_channel_t channel)
{
    bool isAlive = false;
    if (WATCHDOG_CHANNEL_VALID(channel))
    {
        SM_LOCK_REQ_BLOCK();
        isAlive = watchdog_data.channels[channel].output.isAlive;
        SM_LOCK_REL();
    }
    return isAlive;
}

bool watchdog_isAllAlive()
{
    bool isAlive = true;
    for (watchdog_channel_t channel = (watchdog_channel_t)0U; channel < WATCHDOG_CHANNEL_COUNT; channel++)
    {
        if (watchdog_isAlive(channel) == false)
        {
            isAlive = false;
            break;
        }
    }
    return isAlive;
}

/**********************************************************************
 * End of File
 **********************************************************************/
