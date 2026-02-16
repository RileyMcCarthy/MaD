//
// Created by Riley McCarthy on 25/04/24.
// @brief Generic SD card binary struct channel system.
//
/**********************************************************************
 * Includes
 **********************************************************************/
#include "HAL_lock.h"
#include <string.h>
#include "IO_Debug.h"

#include "IO_SDCard.h"
#include "lib_staticQueue.h"
#include "emulation_helpers.h"
/**********************************************************************
 * Constants
 **********************************************************************/

/*********************************************************************
 * Macros
 **********************************************************************/
#define IO_SDCARD_LOCK_REQ() HAL_lock_try(IO_SDCard_data.lock)
#define IO_SDCARD_LOCK_REQ_BLOCK() while (IO_SDCARD_LOCK_REQ() == false) EMULATION_YIELD_LOCK();
#define IO_SDCARD_LOCK_REL() HAL_lock_release(IO_SDCard_data.lock)

#define IO_SDCARD_LOCKED_INPUT(channel) IO_SDCard_data.channelData[channel].externalInput
#define IO_SDCARD_INTERNAL_INPUT(channel) IO_SDCard_data.channelData[channel].input

#define IO_SDCARD_LOCKED_REQUEST(channel) IO_SDCard_data.channelData[channel].externalRequest
#define IO_SDCARD_INTERNAL_REQUEST(channel) IO_SDCard_data.channelData[channel].request
/**********************************************************************
 * Typedefs
 **********************************************************************/
typedef struct
{
    char fileName[255];
    IO_SDCard_mode_E mode;
} IO_SDCard_channelInput_S;

typedef struct
{
    bool enable;
    bool disable;
} IO_SDCard_channelRequest_S;

typedef struct
{
    IO_SDCard_channelInput_S externalInput;
    IO_SDCard_channelInput_S input;

    IO_SDCard_channelRequest_S externalRequest;
    IO_SDCard_channelRequest_S request;

    bool queueEmpty;
    bool queueFull;
    bool eof;
    FILE *file;

    IO_SDCard_state_E state;
    IO_SDCard_mode_E mode;
    lib_staticQueue_S queue;
} IO_SDCard_channelData_S;

typedef struct
{
    IO_SDCard_channelData_S channelData[IO_SDCARD_CHANNEL_COUNT];
    int32_t lock;
} IO_SDCard_data_S;

/**********************************************************************
 * External Variables
 **********************************************************************/
extern IO_SDCard_config_S IO_SDCard_config;
/**********************************************************************
 * Private Variable Definitions
 **********************************************************************/
static IO_SDCard_data_S IO_SDCard_data;
/**********************************************************************
 * Private Function Prototypes
 **********************************************************************/

/**********************************************************************
 * Private Function Definitions
 **********************************************************************/

static IO_SDCard_state_E IO_SDCard_getDesiredState(IO_SDCard_channel_E channel)
{
    IO_SDCard_state_E desiredState = IO_SDCard_data.channelData[channel].state;
    switch (IO_SDCard_data.channelData[channel].state)
    {
    case IO_SDCARD_STATE_INIT:
        if (IO_SDCARD_INTERNAL_REQUEST(channel).enable)
        {
            desiredState = IO_SDCARD_STATE_OPEN;
        }
        break;
    case IO_SDCARD_STATE_OPEN:
        if (IO_SDCard_data.channelData[channel].file != NULL)
        {
            desiredState = IO_SDCARD_STATE_ACTIVE;
            DEBUG_INFO("IO_SDCARD: Opened file %s\n", IO_SDCARD_INTERNAL_INPUT(channel).fileName);
        }
        else
        {
            desiredState = IO_SDCARD_STATE_INIT;
            DEBUG_ERROR("IO_SDCARD: Failed to open file %s, make sure the directory exists\n", IO_SDCARD_INTERNAL_INPUT(channel).fileName);
        }
        break;
    case IO_SDCARD_STATE_ACTIVE:
        if (IO_SDCard_data.channelData[channel].mode == IO_SDCARD_MODE_WRITE)
        {
            // WRITE mode: process queue items, close when queue empty + close requested
            if (IO_SDCARD_INTERNAL_REQUEST(channel).disable && IO_SDCard_data.channelData[channel].queueEmpty)
            {
                desiredState = IO_SDCARD_STATE_CLOSE;
            }
        }
        else
        {
            // READ mode: close when requested
            if (IO_SDCARD_INTERNAL_REQUEST(channel).disable)
            {
                desiredState = IO_SDCARD_STATE_CLOSE;
            }
        }
        break;
    case IO_SDCARD_STATE_CLOSE:
        desiredState = IO_SDCARD_STATE_INIT;
        break;
    default:
        break;
    }
    return desiredState;
}

static void IO_SDCard_private_processWrite(IO_SDCard_channel_E channel)
{
    // Write all queued items to file as raw binary structs
    uint8_t itemBuffer[IO_SDCard_config.channelConfig[channel].queueBufferItemSize];
    while (lib_staticQueue_pop(&IO_SDCard_data.channelData[channel].queue, itemBuffer))
    {
        fwrite(itemBuffer, IO_SDCard_config.channelConfig[channel].queueBufferItemSize, 1,
               IO_SDCard_data.channelData[channel].file);
    }
    fflush(IO_SDCard_data.channelData[channel].file);
}

static void IO_SDCard_private_processRead(IO_SDCard_channel_E channel)
{
    // Fill queue from file as raw binary structs
    if (IO_SDCard_data.channelData[channel].eof)
    {
        return;
    }

    uint8_t itemBuffer[IO_SDCard_config.channelConfig[channel].queueBufferItemSize];
    while (!lib_staticQueue_isfull(&IO_SDCard_data.channelData[channel].queue))
    {
        size_t bytesRead = fread(itemBuffer, IO_SDCard_config.channelConfig[channel].queueBufferItemSize,
                                 1, IO_SDCard_data.channelData[channel].file);
        if (bytesRead == 0)
        {
            // EOF or error
            IO_SDCard_data.channelData[channel].eof = true;
            DEBUG_INFO("%s", "IO_SDCARD: reached EOF on read channel\n");
            break;
        }
        lib_staticQueue_push(&IO_SDCard_data.channelData[channel].queue, itemBuffer);
    }
}

static void IO_SDCard_private_entryAction(IO_SDCard_channel_E channel)
{
    switch (IO_SDCard_data.channelData[channel].state)
    {
    case IO_SDCARD_STATE_INIT:
        DEBUG_INFO("%s", "IO_SDCARD: Initializing\n");
        break;
    case IO_SDCARD_STATE_OPEN:
    {
        IO_SDCard_data.channelData[channel].mode = IO_SDCARD_INTERNAL_INPUT(channel).mode;
        const char *fileMode = (IO_SDCard_data.channelData[channel].mode == IO_SDCARD_MODE_WRITE) ? "wb" : "rb";
        DEBUG_INFO("IO_SDCARD: Opening file %s (mode: %s)\n", IO_SDCARD_INTERNAL_INPUT(channel).fileName, fileMode);
        IO_SDCard_data.channelData[channel].file = fopen(IO_SDCARD_INTERNAL_INPUT(channel).fileName, fileMode);
        IO_SDCard_data.channelData[channel].eof = false;
        break;
    }
    case IO_SDCARD_STATE_ACTIVE:
        break;
    case IO_SDCARD_STATE_CLOSE:
        DEBUG_INFO("IO_SDCARD: Closing file %s\n", IO_SDCARD_INTERNAL_INPUT(channel).fileName);
        if (IO_SDCard_data.channelData[channel].mode == IO_SDCARD_MODE_WRITE)
        {
            // Flush any remaining queued data before closing
            IO_SDCard_private_processWrite(channel);
        }
        fclose(IO_SDCard_data.channelData[channel].file);
        IO_SDCard_data.channelData[channel].file = NULL;
        IO_SDCard_data.channelData[channel].eof = false;
        lib_staticQueue_empty(&IO_SDCard_data.channelData[channel].queue);
        break;
    default:
        break;
    }
}

static void IO_SDCard_private_exitAction(IO_SDCard_channel_E channel)
{
    switch (IO_SDCard_data.channelData[channel].state)
    {
    case IO_SDCARD_STATE_INIT:
        IO_SDCARD_INTERNAL_REQUEST(channel).enable = false;
        break;
    case IO_SDCARD_STATE_OPEN:
        break;
    case IO_SDCARD_STATE_ACTIVE:
        break;
    case IO_SDCARD_STATE_CLOSE:
        IO_SDCARD_INTERNAL_REQUEST(channel).disable = false;
        break;
    default:
        break;
    }
}

static void IO_SDCard_private_stageInputs(IO_SDCard_channel_E channel)
{
    IO_SDCARD_LOCK_REQ_BLOCK();
    memcpy(&IO_SDCARD_INTERNAL_INPUT(channel), &IO_SDCARD_LOCKED_INPUT(channel), sizeof(IO_SDCard_channelInput_S));
    if (IO_SDCARD_LOCKED_REQUEST(channel).enable)
    {
        IO_SDCARD_INTERNAL_REQUEST(channel).enable = true;
        IO_SDCARD_LOCKED_REQUEST(channel).enable = false;
    }
    if (IO_SDCARD_LOCKED_REQUEST(channel).disable)
    {
        IO_SDCARD_INTERNAL_REQUEST(channel).disable = true;
        IO_SDCARD_LOCKED_REQUEST(channel).disable = false;
    }
    IO_SDCARD_LOCK_REL();

    // Static queue is thread safe
    IO_SDCard_data.channelData[channel].queueEmpty = lib_staticQueue_isempty(&IO_SDCard_data.channelData[channel].queue);
    IO_SDCard_data.channelData[channel].queueFull = lib_staticQueue_isfull(&IO_SDCard_data.channelData[channel].queue);
}

static void IO_SDCard_private_processActive(IO_SDCard_channel_E channel)
{
    if (IO_SDCard_data.channelData[channel].state != IO_SDCARD_STATE_ACTIVE)
    {
        return;
    }

    if (IO_SDCard_data.channelData[channel].mode == IO_SDCARD_MODE_WRITE)
    {
        if (!IO_SDCard_data.channelData[channel].queueEmpty)
        {
            IO_SDCard_private_processWrite(channel);
        }
    }
    else
    {
        IO_SDCard_private_processRead(channel);
    }
}

/**********************************************************************
 * Public Function Definitions
 **********************************************************************/
void IO_SDCard_init(int lock)
{
    IO_SDCard_data.lock = lock;
    for (IO_SDCard_channel_E channel = (IO_SDCard_channel_E)0U; channel < IO_SDCARD_CHANNEL_COUNT; channel++)
    {
        IO_SDCard_data.channelData[channel].state = IO_SDCARD_STATE_INIT;
        IO_SDCard_data.channelData[channel].file = NULL;
        IO_SDCard_data.channelData[channel].eof = false;
        lib_staticQueue_init(&IO_SDCard_data.channelData[channel].queue,
                             IO_SDCard_config.channelConfig[channel].queueBuffer,
                             IO_SDCard_config.channelConfig[channel].queueBufferSize,
                             IO_SDCard_config.channelConfig[channel].queueBufferItemSize,
                             IO_SDCard_data.lock);
    }
}

void IO_SDCard_run(void)
{
    for (IO_SDCard_channel_E channel = (IO_SDCard_channel_E)0U; channel < IO_SDCARD_CHANNEL_COUNT; channel++)
    {
        IO_SDCard_private_stageInputs(channel);

        // Process active channel data (read/write)
        IO_SDCard_private_processActive(channel);

        // State machine transitions
        IO_SDCard_state_E desiredState = IO_SDCard_getDesiredState(channel);
        if (IO_SDCard_data.channelData[channel].state != desiredState)
        {
            IO_SDCard_private_exitAction(channel);
            IO_SDCard_data.channelData[channel].state = desiredState;
            IO_SDCard_private_entryAction(channel);
        }
    }
}

bool IO_SDCard_open(IO_SDCard_channel_E channel, const char *fileName, IO_SDCard_mode_E mode)
{
    bool success = false;
    if (channel < IO_SDCARD_CHANNEL_COUNT)
    {
        IO_SDCARD_LOCK_REQ_BLOCK();
        IO_SDCARD_LOCKED_REQUEST(channel).enable = true;
        IO_SDCARD_LOCKED_INPUT(channel).mode = mode;
        snprintf(IO_SDCARD_LOCKED_INPUT(channel).fileName, sizeof(IO_SDCARD_LOCKED_INPUT(channel).fileName),
                 IO_SDCard_config.channelConfig[channel].nameFormat, fileName);
        DEBUG_INFO("IO_SDCARD: Opening channel %d with file %s (mode %d)\n", channel,
                   IO_SDCARD_LOCKED_INPUT(channel).fileName, mode);
        success = true;
        IO_SDCARD_LOCK_REL();
    }
    return success;
}

bool IO_SDCard_close(IO_SDCard_channel_E channel)
{
    bool success = false;
    if (channel < IO_SDCARD_CHANNEL_COUNT)
    {
        IO_SDCARD_LOCK_REQ_BLOCK();
        IO_SDCARD_LOCKED_REQUEST(channel).disable = true;
        success = true;
        IO_SDCARD_LOCK_REL();
    }
    return success;
}

bool IO_SDCard_isClosed(IO_SDCard_channel_E channel)
{
    bool closed = false;
    if (channel < IO_SDCARD_CHANNEL_COUNT)
    {
        closed = (IO_SDCard_data.channelData[channel].state == IO_SDCARD_STATE_INIT);
    }
    return closed;
}

bool IO_SDCard_push(IO_SDCard_channel_E channel, void *data, uint32_t size)
{
    bool success = false;
    if ((channel < IO_SDCARD_CHANNEL_COUNT) && (size == IO_SDCard_config.channelConfig[channel].queueBufferItemSize))
    {
        success = lib_staticQueue_push(&IO_SDCard_data.channelData[channel].queue, data);
    }
    return success;
}

bool IO_SDCard_pop(IO_SDCard_channel_E channel, void *data)
{
    bool success = false;
    if (channel < IO_SDCARD_CHANNEL_COUNT)
    {
        success = lib_staticQueue_pop(&IO_SDCard_data.channelData[channel].queue, data);
    }
    return success;
}

uint32_t IO_SDCard_popMultiple(IO_SDCard_channel_E channel, void *buffer, uint32_t maxCount)
{
    uint32_t count = 0U;
    if ((channel < IO_SDCARD_CHANNEL_COUNT) && (buffer != NULL) && (maxCount > 0U))
    {
        const uint32_t itemSize = IO_SDCard_config.channelConfig[channel].queueBufferItemSize;
        uint8_t *dst = (uint8_t *)buffer;
        while (count < maxCount)
        {
            if (!lib_staticQueue_pop(&IO_SDCard_data.channelData[channel].queue, &dst[count * itemSize]))
            {
                break;
            }
            count++;
        }
    }
    return count;
}

uint32_t IO_SDCard_readDirect(IO_SDCard_channel_E channel, const char *fileName,
                              void *buffer, uint32_t itemIndex, uint32_t itemCount)
{
    uint32_t itemsRead = 0U;
    if ((channel >= IO_SDCARD_CHANNEL_COUNT) || (buffer == NULL) || (itemCount == 0U))
    {
        return 0U;
    }

    const uint32_t itemSize = IO_SDCard_config.channelConfig[channel].queueBufferItemSize;

    char filePath[255];
    snprintf(filePath, sizeof(filePath), IO_SDCard_config.channelConfig[channel].nameFormat, fileName);

    FILE *file = fopen(filePath, "rb");
    if (file != NULL)
    {
        const long seekOffset = (long)(itemIndex * itemSize);
        if (fseek(file, seekOffset, SEEK_SET) == 0)
        {
            itemsRead = (uint32_t)fread(buffer, itemSize, itemCount, file);
        }
        fclose(file);
    }
    else
    {
        DEBUG_ERROR("IO_SDCard_readDirect: failed to open %s\n", filePath);
    }

    return itemsRead;
}

bool IO_SDCard_isReadDone(IO_SDCard_channel_E channel)
{
    bool done = false;
    if (channel < IO_SDCARD_CHANNEL_COUNT)
    {
        done = IO_SDCard_data.channelData[channel].eof &&
               lib_staticQueue_isempty(&IO_SDCard_data.channelData[channel].queue);
    }
    return done;
}

/**********************************************************************
 * End of File
 **********************************************************************/
