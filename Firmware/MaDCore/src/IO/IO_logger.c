//
// Created by Riley McCarthy on 25/04/24.
//
/**********************************************************************
 * Includes
 **********************************************************************/
#include "propeller2.h"
#include <string.h>
#include "IO_Debug.h"

#include "IO_logger.h"
#include "lib_staticQueue.h"
/**********************************************************************
 * Constants
 **********************************************************************/
#define IO_LOGGER_COMMENT_SIZE 512
/*********************************************************************
 * Macros
 **********************************************************************/
#define IO_LOGGER_LOCK_REQ() _locktry(IO_logger_data.lock)
#define IO_LOGGER_LOCK_REQ_BLOCK()        \
    while (IO_LOGGER_LOCK_REQ() == false) \
    {                                     \
    }
#define IO_LOGGER_LOCK_REL() _lockrel(IO_logger_data.lock)

#define IO_LOGGER_LOCKED_INPUT(channel) IO_logger_data.channelData[channel].externalInput
#define IO_LOGGER_INTERNAL_INPUT(channel) IO_logger_data.channelData[channel].input

#define IO_LOGGER_LOCKED_REQUEST(channel) IO_logger_data.channelData[channel].externalRequest
#define IO_LOGGER_INTERNAL_REQUEST(channel) IO_logger_data.channelData[channel].request
/**********************************************************************
 * Typedefs
 **********************************************************************/
typedef struct
{
    char fileName[255];
    char comment[IO_LOGGER_COMMENT_SIZE];
} IO_logger_channelInput_S;

typedef struct
{
    bool enable;
    bool disable;
    bool writeComment;
} IO_logger_channelRequest_S;

typedef struct
{
    IO_logger_channelInput_S externalInput;
    IO_logger_channelInput_S input;

    IO_logger_channelRequest_S externalRequest;
    IO_logger_channelRequest_S request;

    bool writeComment;
    bool enabled;
    bool queueEmpty;
    bool queueFull;
    FILE *file;

    IO_logger_state_E state;
    lib_staticQueue_S queue;
} IO_logger_channelData_S;

typedef struct
{
    IO_logger_channelData_S channelData[IO_LOGGER_CHANNEL_COUNT];
    int32_t lock;
} IO_logger_data_S;

/**********************************************************************
 * External Variables
 **********************************************************************/
extern IO_logger_config_S IO_logger_config;
/**********************************************************************
 * Private Variable Definitions
 **********************************************************************/
static IO_logger_data_S IO_logger_data;
/**********************************************************************
 * Private Function Prototypes
 **********************************************************************/

/**********************************************************************
 * Private Function Definitions
 **********************************************************************/

static IO_logger_state_E IO_logger_getDesiredState(IO_logger_channel_E channel)
{
    IO_logger_state_E desiredState = IO_logger_data.channelData[channel].state;
    switch (IO_logger_data.channelData[channel].state)
    {
    case IO_LOGGER_STATE_INIT:
        if (IO_LOGGER_INTERNAL_REQUEST(channel).enable)
        {
            desiredState = IO_LOGGER_STATE_OPEN;
        }
        break;
    case IO_LOGGER_STATE_OPEN:
        if (IO_logger_data.channelData[channel].file != NULL)
        {
            desiredState = IO_LOGGER_STATE_WAITING;
            DEBUG_INFO("IO_LOGGER: Opened file %s\n", IO_LOGGER_INTERNAL_INPUT(channel).fileName);
        }
        else
        {
            desiredState = IO_LOGGER_STATE_INIT;
            DEBUG_ERROR("IO_LOGGER: Failed to open file %s, make sure the directory exists\n", IO_LOGGER_INTERNAL_INPUT(channel).fileName);
        }
        break;
    case IO_LOGGER_STATE_WAITING:
        if (IO_LOGGER_INTERNAL_REQUEST(channel).writeComment)
        {
            desiredState = IO_LOGGER_STATE_WRITE_COMMENT;
        }
        else if (IO_logger_data.channelData[channel].queueEmpty == false)
        {
            desiredState = IO_LOGGER_STATE_WRITE_DATA;
        }
        else if (IO_LOGGER_INTERNAL_REQUEST(channel).disable)
        {
            // Queue is empty and logging is disabled
            desiredState = IO_LOGGER_STATE_CLOSE;
        }
        else
        {
            // wait for data
        }
        break;
    case IO_LOGGER_STATE_WRITE_DATA:
        desiredState = IO_LOGGER_STATE_WAITING;
        break;
    case IO_LOGGER_STATE_WRITE_COMMENT:
        desiredState = IO_LOGGER_STATE_WAITING;
        break;
    case IO_LOGGER_STATE_CLOSE:
        desiredState = IO_LOGGER_STATE_INIT;
        break;
    default:
        break;
    }
    return desiredState;
}

static void IO_logger_private_entryAction(IO_logger_channel_E channel)
{
    switch (IO_logger_data.channelData[channel].state)
    {
    case IO_LOGGER_STATE_INIT:
        DEBUG_INFO("%s", "IO_LOGGER: Initializing\n");
        break;
    case IO_LOGGER_STATE_OPEN:
        DEBUG_INFO("IO_LOGGER: Opening file %s\n", IO_LOGGER_INTERNAL_INPUT(channel).fileName);
        DEBUG_INFO("IO_LOGGER: Write type %s\n", IO_logger_config.channelConfig[channel].writeType);
        IO_logger_data.channelData[channel].file = fopen(IO_LOGGER_INTERNAL_INPUT(channel).fileName, IO_logger_config.channelConfig[channel].writeType);
        break;
    case IO_LOGGER_STATE_WAITING:
        break;
    case IO_LOGGER_STATE_WRITE_DATA:
        IO_logger_config.channelConfig[channel].format(IO_logger_data.channelData[channel].file, &IO_logger_data.channelData[channel].queue);
        break;
    case IO_LOGGER_STATE_WRITE_COMMENT:
        DEBUG_INFO("IO_LOGGER: Writing comment to file %s\n", IO_LOGGER_INTERNAL_INPUT(channel).fileName);
        fprintf(IO_logger_data.channelData[channel].file, "# %s\n", IO_LOGGER_INTERNAL_INPUT(channel).comment);
        break;
    case IO_LOGGER_STATE_CLOSE:
        DEBUG_INFO("IO_LOGGER: Closing file %s\n", IO_LOGGER_INTERNAL_INPUT(channel).fileName);
        fclose(IO_logger_data.channelData[channel].file);
        IO_logger_data.channelData[channel].file = NULL;
        break;
    default:
        break;
    }
}

static void IO_logger_private_exitAction(IO_logger_channel_E channel)
{
    switch (IO_logger_data.channelData[channel].state)
    {
    case IO_LOGGER_STATE_INIT:
        IO_LOGGER_INTERNAL_REQUEST(channel).enable = false;
        break;
    case IO_LOGGER_STATE_OPEN:
        break;
    case IO_LOGGER_STATE_WAITING:
        break;
    case IO_LOGGER_STATE_WRITE_DATA:
        break;
    case IO_LOGGER_STATE_WRITE_COMMENT:
        IO_LOGGER_INTERNAL_REQUEST(channel).writeComment = false;
        break;
    case IO_LOGGER_STATE_CLOSE:
        IO_LOGGER_INTERNAL_REQUEST(channel).disable = false;
        break;
    default:
        break;
    }
}

static void IO_logger_private_stageInputs(IO_logger_channel_E channel)
{
    IO_LOGGER_LOCK_REQ_BLOCK();
    memcpy(&IO_LOGGER_INTERNAL_INPUT(channel), &IO_LOGGER_LOCKED_INPUT(channel), sizeof(IO_logger_channelInput_S));
    if (IO_LOGGER_LOCKED_REQUEST(channel).writeComment)
    {
        IO_LOGGER_INTERNAL_REQUEST(channel).writeComment = true;
        IO_LOGGER_LOCKED_REQUEST(channel).writeComment = false;
    }
    if (IO_LOGGER_LOCKED_REQUEST(channel).enable)
    {
        IO_LOGGER_INTERNAL_REQUEST(channel).enable = true;
        IO_LOGGER_LOCKED_REQUEST(channel).enable = false;
    }
    if (IO_LOGGER_LOCKED_REQUEST(channel).disable)
    {
        IO_LOGGER_INTERNAL_REQUEST(channel).disable = true;
        IO_LOGGER_LOCKED_REQUEST(channel).disable = false;
    }
    IO_LOGGER_LOCK_REL();

    // Static queue is thread safe
    IO_logger_data.channelData[channel].queueEmpty = lib_staticQueue_isempty(&IO_logger_data.channelData[channel].queue);
    IO_logger_data.channelData[channel].queueFull = lib_staticQueue_isfull(&IO_logger_data.channelData[channel].queue);
}

/**********************************************************************
 * Public Function Definitions
 **********************************************************************/
void IO_logger_init(int lock)
{
    IO_logger_data.lock = lock;
    for (IO_logger_channel_E channel = (IO_logger_channel_E)0U; channel < IO_LOGGER_CHANNEL_COUNT; channel++)
    {
        IO_logger_data.channelData[channel].state = IO_LOGGER_STATE_INIT;
        lib_staticQueue_init(&IO_logger_data.channelData[channel].queue,
                             IO_logger_config.channelConfig[channel].queueBuffer,
                             IO_logger_config.channelConfig[channel].queueBufferSize,
                             IO_logger_config.channelConfig[channel].queueBufferItemSize,
                             IO_logger_data.lock);
    }
}

void IO_logger_run(void)
{
    for (IO_logger_channel_E channel = (IO_logger_channel_E)0U; channel < IO_LOGGER_CHANNEL_COUNT; channel++)
    {
        IO_logger_private_stageInputs(channel);
        IO_logger_state_E desiredState = IO_logger_getDesiredState(channel);
        if (IO_logger_data.channelData[channel].state != desiredState)
        {
            // DEBUG_INFO("Transitioning from %d -> %d\n", IO_logger_data.channelData[channel].state, desiredState);
            IO_logger_private_exitAction(channel);
            IO_logger_data.channelData[channel].state = desiredState;
            IO_logger_private_entryAction(channel);
        }
    }
}

bool IO_logger_open(IO_logger_channel_E channel, const char *fileName)
{
    bool success = false;
    if (channel < IO_LOGGER_CHANNEL_COUNT)
    {
        IO_LOGGER_LOCK_REQ_BLOCK();
        IO_LOGGER_LOCKED_REQUEST(channel).enable = true;
        snprintf(IO_LOGGER_LOCKED_INPUT(channel).fileName, sizeof(IO_LOGGER_LOCKED_INPUT(channel).fileName), IO_logger_config.channelConfig[channel].nameFormat, fileName);
        DEBUG_INFO("IO_LOGGER: Starting channel %d with file %s\n", channel, IO_LOGGER_LOCKED_INPUT(channel).fileName);
        success = true;
        IO_LOGGER_LOCK_REL();
    }
    return success;
}

bool IO_logger_reopen(IO_logger_channel_E channel)
{
    bool success = false;
    if (channel < IO_LOGGER_CHANNEL_COUNT)
    {
        IO_LOGGER_LOCK_REQ_BLOCK();
        if (strncmp(IO_LOGGER_LOCKED_INPUT(channel).fileName, "", sizeof(IO_LOGGER_LOCKED_INPUT(channel).fileName)) != 0)
        {
            IO_LOGGER_LOCKED_REQUEST(channel).enable = true;
            DEBUG_INFO("IO_LOGGER: Reopening channel %d with file %s\n", channel, IO_LOGGER_LOCKED_INPUT(channel).fileName);
            success = true;
        }
        else
        {
            DEBUG_ERROR("IO_LOGGER: Failed to reopen channel %d, file is not set\n", channel);
        }
        IO_LOGGER_LOCK_REL();
    }
    return success;
}

bool IO_logger_addComment(IO_logger_channel_E channel, const char *comment, uint32_t size)
{
    bool success = false;
    if (channel < IO_LOGGER_CHANNEL_COUNT)
    {
        if ((IO_logger_data.channelData[channel].writeComment == false) && (size < IO_LOGGER_COMMENT_SIZE))
        {
            IO_LOGGER_LOCK_REQ_BLOCK();
            IO_LOGGER_LOCKED_REQUEST(channel).writeComment = true;
            // could use a blocking function to save buffering memory
            strncpy(IO_LOGGER_LOCKED_INPUT(channel).comment, comment, size);
            DEBUG_INFO("IO_LOGGER: Adding comment to channel %d: %s\n", channel, comment);
            success = true;
            IO_LOGGER_LOCK_REL();
        }
    }
    return success;
}

/*
 * @brief Stop logging to the file, complete writing the queue and close the file.
 */
bool IO_logger_close(IO_logger_channel_E channel)
{
    bool success = false;
    if (channel < IO_LOGGER_CHANNEL_COUNT)
    {
        IO_LOGGER_LOCK_REQ_BLOCK();
        IO_LOGGER_LOCKED_REQUEST(channel).disable = true;
        success = true;
        IO_LOGGER_LOCK_REL();
    }
    return success;
}

bool IO_logger_push(IO_logger_channel_E channel, void *data, uint32_t size)
{
    bool success = false;
    if ((channel < IO_LOGGER_CHANNEL_COUNT) && (size == IO_logger_config.channelConfig[channel].queueBufferItemSize))
    {
        success = lib_staticQueue_push(&IO_logger_data.channelData[channel].queue, data);
    }
    return success;
}

bool IO_logger_isEmpty(IO_logger_channel_E channel)
{
    bool isEmpty = false;
    if (channel < IO_LOGGER_CHANNEL_COUNT)
    {
        isEmpty = lib_staticQueue_isempty(&IO_logger_data.channelData[channel].queue);
    }
    return isEmpty;
}

/**********************************************************************
 * End of File
 **********************************************************************/
