//
// Created by Riley McCarthy on 25/04/24.
//
/**********************************************************************
 * Includes
 **********************************************************************/
#include <stdlib.h>
#include <stdio.h>
#include <string.h>
#include "propeller2.h"
#include "dev_nvram.h"
#include "IO_Debug.h"
/**********************************************************************
 * Constants
 **********************************************************************/
#define DEV_NVRAM_MAX_MEMORY_SIZE 1024
/*********************************************************************
 * Macros
 **********************************************************************/
#define SM_LOCK_REQ() _locktry(dev_nvram_data.lock)
#define SM_LOCK_REQ_BLOCK()        \
    while (SM_LOCK_REQ() == false) \
        ;
#define SM_LOCK_REL() _lockrel(dev_nvram_data.lock)

#define DEV_NVRAM_CHANNEL_VALID(channel) (channel >= 0 || channel < DEV_NVRAM_CHANNEL_COUNT)
#define DEV_NVRAM_CHANNEL_DATA(channel) dev_nvram_data.channels[channel]
#define DEV_NVRAM_CHANNEL_CONFIG(channel) dev_nvram_config.channels[channel]
/**********************************************************************
 * Typedefs
 **********************************************************************/

typedef struct
{
    void *data;
    bool dirty;
} dev_nvram_channelRequest_t;

typedef struct
{
    void *data;
    bool hasError;
    dev_nvram_state_t state;
} dev_nvram_channelOutput_t;

typedef struct
{
    dev_nvram_channelRequest_t request;
    dev_nvram_channelOutput_t output;
    void *data;
    bool hasError;
    bool dirty;
    bool readComplete;
    bool mountComplete;
    FILE *file;
    dev_nvram_state_t state;
} dev_nvram_channelData_t;

typedef struct
{
    int lock;
    dev_nvram_channelData_t channels[DEV_NVRAM_CHANNEL_COUNT];
} dev_nvram_data_t;

/**********************************************************************
 * External Variables
 **********************************************************************/
extern dev_nvram_config_t dev_nvram_config;
/**********************************************************************
 * Variable Definitions
 **********************************************************************/
static dev_nvram_data_t dev_nvram_data;
/**********************************************************************
 * Private Function Prototypes
 **********************************************************************/
void dev_nvram_private_stageRequest(dev_nvram_channel_t channel);
dev_nvram_state_t dev_nvram_private_getDesiredState(dev_nvram_channel_t channel);
/**********************************************************************
 * Private Function Definitions
 **********************************************************************/
void dev_nvram_private_stageRequest(dev_nvram_channel_t channel)
{
    if (DEV_NVRAM_CHANNEL_VALID(channel))
    {
        SM_LOCK_REQ_BLOCK();
        dev_nvram_data.channels[channel].dirty = dev_nvram_data.channels[channel].request.dirty;
        if (dev_nvram_data.channels[channel].request.dirty)
        {
            memcpy(dev_nvram_data.channels[channel].data, dev_nvram_data.channels[channel].request.data, DEV_NVRAM_CHANNEL_CONFIG(channel).size);
            dev_nvram_data.channels[channel].request.dirty = false;
        }
        SM_LOCK_REL();
    }
}

void dev_nvram_private_stageOutput(dev_nvram_channel_t channel)
{
    if (DEV_NVRAM_CHANNEL_VALID(channel))
    {
        SM_LOCK_REQ_BLOCK();
        memcpy(dev_nvram_data.channels[channel].output.data, dev_nvram_data.channels[channel].data, DEV_NVRAM_CHANNEL_CONFIG(channel).size);
        dev_nvram_data.channels[channel].output.hasError = dev_nvram_data.channels[channel].hasError;
        dev_nvram_data.channels[channel].output.state = dev_nvram_data.channels[channel].state;
        SM_LOCK_REL();
    }
}

dev_nvram_state_t dev_nvram_private_getDesiredState(dev_nvram_channel_t channel)
{
    dev_nvram_state_t desiredState = dev_nvram_data.channels[channel].state;
    switch (dev_nvram_data.channels[channel].state)
    {
    case DEV_NVRAM_INIT:
        if (dev_nvram_config.channels[channel].loadOnBoot)
        {
            desiredState = DEV_NVRAM_BOOT_LOAD;
        }
        else
        {
            desiredState = DEV_NVRAM_READY;
        }
        break;
    case DEV_NVRAM_BOOT_LOAD:
        if (dev_nvram_data.channels[channel].hasError)
        {
            desiredState = DEV_NVRAM_ERROR;
        }
        else if (dev_nvram_data.channels[channel].readComplete)
        {
            desiredState = DEV_NVRAM_READY;
        }
        break;
    case DEV_NVRAM_READ:
        if (dev_nvram_data.channels[channel].hasError)
        {
            desiredState = DEV_NVRAM_ERROR;
        }
        else if (dev_nvram_data.channels[channel].readComplete)
        {
            desiredState = DEV_NVRAM_READY;
        }
        break;
    case DEV_NVRAM_READY:
        if (dev_nvram_data.channels[channel].dirty)
        {
            desiredState = DEV_NVRAM_WRITE;
        }
        break;
    case DEV_NVRAM_WRITE:
        if (dev_nvram_data.channels[channel].hasError)
        {
            desiredState = DEV_NVRAM_ERROR;
        }
        else if (dev_nvram_data.channels[channel].dirty == false)
        {
            desiredState = DEV_NVRAM_READY;
        }
        break;
    case DEV_NVRAM_ERROR:
        break;
    default:
        break;
    }
    return desiredState;
}

void dev_nvram_private_exitAction(dev_nvram_channel_t channel)
{
    switch (dev_nvram_data.channels[channel].state)
    {
    case DEV_NVRAM_INIT:
        break;
    case DEV_NVRAM_BOOT_LOAD:
        if (dev_nvram_data.channels[channel].file != NULL)
        {
            fclose(dev_nvram_data.channels[channel].file);
        }
        break;
    case DEV_NVRAM_READY:
        break;
    case DEV_NVRAM_WRITE:
        if (dev_nvram_data.channels[channel].file != NULL)
        {
            fclose(dev_nvram_data.channels[channel].file);
        }
        break;
    case DEV_NVRAM_ERROR:
        break;
    default:
        break;
    }
}

void dev_nvram_private_entryAction(dev_nvram_channel_t channel)
{
    switch (dev_nvram_data.channels[channel].state)
    {
    case DEV_NVRAM_INIT:
        dev_nvram_data.channels[channel].mountComplete = (mount(SD_CARD_MOUNT_PATH, _vfs_open_sdcard()) == 0);
        break;
    case DEV_NVRAM_BOOT_LOAD:
        dev_nvram_data.channels[channel].readComplete = false;
        if (dev_nvram_data.channels[channel].mountComplete)
        {
            dev_nvram_data.channels[channel].file = fopen(dev_nvram_config.channels[channel].path, "r");
        }
        else
        {
            dev_nvram_data.channels[channel].file = NULL;
            dev_nvram_data.channels[channel].hasError = true;
        }
        break;
    case DEV_NVRAM_READY:
        // Open file
        break;
    case DEV_NVRAM_WRITE:
        dev_nvram_data.channels[channel].file = fopen(dev_nvram_config.channels[channel].path, "w");
        break;
    case DEV_NVRAM_ERROR:
        break;
    default:
        break;
    }
}

void dev_nvram_private_runAction(dev_nvram_channel_t channel)
{
    switch (dev_nvram_data.channels[channel].state)
    {
    case DEV_NVRAM_INIT:
        break;
    case DEV_NVRAM_BOOT_LOAD:
        if (dev_nvram_data.channels[channel].file == NULL)
        {
            // Load default data
            dev_nvram_data.channels[channel].readComplete = true;
            memcpy(dev_nvram_data.channels[channel].data, dev_nvram_config.channels[channel].dataDefault, dev_nvram_config.channels[channel].size);
        }
        else
        {
            // Read data from file
            size_t n = fread(dev_nvram_data.channels[channel].data, dev_nvram_config.channels[channel].size, 1, dev_nvram_data.channels[channel].file);
#if defined(__EMULATION__)
            if (n != 1)
#else
            // propeller fread returns the number of bytes read
            if (n != dev_nvram_config.channels[channel].size)
#endif
            {
                DEBUG_ERROR("incorrect number of bytes read: %zu\n", n);
                dev_nvram_data.channels[channel].hasError = true;
            }
            else
            {
                dev_nvram_data.channels[channel].readComplete = true;
            }
        }
        break;
    case DEV_NVRAM_READY:
        break;
    case DEV_NVRAM_WRITE:
        if (dev_nvram_data.channels[channel].file == NULL)
        {
            DEBUG_ERROR("failed to open file to write: %s\n", dev_nvram_config.channels[channel].path);
            dev_nvram_data.channels[channel].hasError = true;
        }
        else
        {
            // Write data from request
            size_t n = fwrite(dev_nvram_data.channels[channel].request.data, dev_nvram_config.channels[channel].size, 1, dev_nvram_data.channels[channel].file);
#if defined(__EMULATION__)
            if (n != 1)
#else
            // propeller fread returns the number of bytes read
            if (n != dev_nvram_config.channels[channel].size)
#endif
            {
                DEBUG_ERROR("incorrect number of bytes read: %zu\n", n);
                dev_nvram_data.channels[channel].hasError = true;
            }
            else
            {
                dev_nvram_data.channels[channel].dirty = false;
            }
        }
        break;
    case DEV_NVRAM_ERROR:
        break;
    default:
        break;
    }
}

/**********************************************************************
 * Public Function Definitions
 **********************************************************************/

void dev_nvram_init(int lock)
{
    dev_nvram_data.lock = lock;
    for (dev_nvram_channel_t channel = (dev_nvram_channel_t)0U; channel < DEV_NVRAM_CHANNEL_COUNT; channel++)
    {
        dev_nvram_data.channels[channel].data = dev_nvram_config.channels[channel].data;
        dev_nvram_data.channels[channel].hasError = false;
        dev_nvram_data.channels[channel].dirty = false;
        dev_nvram_data.channels[channel].readComplete = false;
        dev_nvram_data.channels[channel].mountComplete = false;
        dev_nvram_data.channels[channel].file = NULL;
        dev_nvram_data.channels[channel].state = DEV_NVRAM_INIT;

        dev_nvram_data.channels[channel].request.data = dev_nvram_config.channels[channel].dataExternal;
        dev_nvram_data.channels[channel].output.data = dev_nvram_config.channels[channel].dataExternal;
        dev_nvram_private_stageRequest(channel);
        dev_nvram_private_stageOutput(channel);
    }
}

void dev_nvram_run()
{
    for (dev_nvram_channel_t channel = (dev_nvram_channel_t)0U; channel < DEV_NVRAM_CHANNEL_COUNT; channel++)
    {
        dev_nvram_private_stageRequest(channel);

        dev_nvram_state_t desiredState = dev_nvram_private_getDesiredState(channel);
        if (desiredState != dev_nvram_data.channels[channel].state)
        {
            dev_nvram_private_exitAction(channel);
            dev_nvram_data.channels[channel].state = desiredState;
            dev_nvram_private_entryAction(channel);
        }

        dev_nvram_private_runAction(channel);

        dev_nvram_private_stageOutput(channel);
    }
}

bool dev_nvram_updateChannelData(dev_nvram_channel_t channel, void *data, size_t size)
{
    bool requestValid = false;
    if (DEV_NVRAM_CHANNEL_VALID(channel) && (data != NULL))
    {
        if (size == dev_nvram_config.channels[channel].size)
        {
            SM_LOCK_REQ_BLOCK();
            memcpy(DEV_NVRAM_CHANNEL_DATA(channel).request.data, data, DEV_NVRAM_CHANNEL_CONFIG(channel).size);
            DEV_NVRAM_CHANNEL_DATA(channel).request.dirty = true;
            requestValid = true;
            SM_LOCK_REL();
        }
    }
    return requestValid;
}

bool dev_nvram_getChannelData(dev_nvram_channel_t channel, void *data, size_t size)
{
    bool requestValid = false;
    if (DEV_NVRAM_CHANNEL_VALID(channel) && (data != NULL))
    {
        if (size == dev_nvram_config.channels[channel].size)
        {
            SM_LOCK_REQ_BLOCK();
            memcpy(data, DEV_NVRAM_CHANNEL_DATA(channel).data, DEV_NVRAM_CHANNEL_CONFIG(channel).size);
            requestValid = true;
            SM_LOCK_REL();
        }
    }
    return requestValid;
}

/**********************************************************************
 * Non Thread-Safe Function Definitions
 **********************************************************************/

dev_nvram_state_t dev_nvram_getState(dev_nvram_channel_t channel)
{
    dev_nvram_state_t state = DEV_NVRAM_ERROR;
    if (DEV_NVRAM_CHANNEL_VALID(channel))
    {
        state = dev_nvram_data.channels[channel].state;
    }
    return state;
}

bool dev_nvram_nosync_runUntilReady()
{
    bool isReady = false;
    while (isReady == false)
    {
        dev_nvram_run();

        isReady = true;
        for (dev_nvram_channel_t channel = (dev_nvram_channel_t)0U; channel < DEV_NVRAM_CHANNEL_COUNT; channel++)
        {
            isReady &= (dev_nvram_data.channels[channel].state == DEV_NVRAM_READY);
            if (dev_nvram_data.channels[channel].state == DEV_NVRAM_ERROR)
            {
                return false;
            }
        }
    }
    return isReady;
}

/**********************************************************************
 * End of File
 **********************************************************************/
