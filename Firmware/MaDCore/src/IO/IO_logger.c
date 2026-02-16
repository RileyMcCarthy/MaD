//
// Created by Riley McCarthy on 25/04/24.
//
/**********************************************************************
 * Includes
 **********************************************************************/
#include "HAL_lock.h"
#include <string.h>
#include "IO_Debug.h"

#include "IO_logger.h"
#include "lib_staticQueue.h"
#include "IO_gcode.h"
#include "emulation_helpers.h"
/**********************************************************************
 * Constants
 **********************************************************************/
#define IO_LOGGER_COMMENT_SIZE 512
#define IO_LOGGER_GCODE_READ_BUFFER_SIZE 64
/*********************************************************************
 * Macros
 **********************************************************************/
#define IO_LOGGER_LOCK_REQ() HAL_lock_try(IO_logger_data.lock)
#define IO_LOGGER_LOCK_REQ_BLOCK() while (IO_LOGGER_LOCK_REQ() == false) EMULATION_YIELD_LOCK();
#define IO_LOGGER_LOCK_REL() HAL_lock_release(IO_logger_data.lock)

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

/**
 * @brief Gcode reader state machine — reads gcode lines from SD file,
 *        decodes them, and pushes decoded moves into a queue for app_motion.
 */
typedef enum
{
    IO_LOGGER_READER_STATE_IDLE,
    IO_LOGGER_READER_STATE_OPEN,
    IO_LOGGER_READER_STATE_READING,
    IO_LOGGER_READER_STATE_DONE,
    IO_LOGGER_READER_STATE_CLOSE,
} IO_logger_readerState_E;

typedef struct
{
    char filePath[256];
} IO_logger_readerInput_S;

typedef struct
{
    bool open;
    bool close;
} IO_logger_readerRequest_S;

typedef struct
{
    IO_logger_readerInput_S externalInput;
    IO_logger_readerInput_S input;
    IO_logger_readerRequest_S externalRequest;
    IO_logger_readerRequest_S request;

    IO_logger_readerState_E state;
    FILE *file;
    bool eof;
    lib_staticQueue_S queue;
    app_motion_move_t queueBuffer[IO_LOGGER_GCODE_READ_BUFFER_SIZE];
} IO_logger_readerData_S;

/**********************************************************************
 * External Variables
 **********************************************************************/
extern IO_logger_config_S IO_logger_config;
/**********************************************************************
 * Private Variable Definitions
 **********************************************************************/
static IO_logger_data_S IO_logger_data;
static IO_logger_readerData_S IO_logger_readerData;
/**********************************************************************
 * Private Function Prototypes
 **********************************************************************/
static void IO_logger_private_readerRun(void);

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
 * Gcode Reader Private Functions
 **********************************************************************/

static void IO_logger_private_readerStageInputs(void)
{
    IO_LOGGER_LOCK_REQ_BLOCK();
    if (IO_logger_readerData.externalRequest.open)
    {
        IO_logger_readerData.request.open = true;
        IO_logger_readerData.externalRequest.open = false;
        memcpy(&IO_logger_readerData.input, &IO_logger_readerData.externalInput, sizeof(IO_logger_readerInput_S));
    }
    if (IO_logger_readerData.externalRequest.close)
    {
        IO_logger_readerData.request.close = true;
        IO_logger_readerData.externalRequest.close = false;
    }
    IO_LOGGER_LOCK_REL();
}

static void IO_logger_private_readerRun(void)
{
    IO_logger_private_readerStageInputs();

    switch (IO_logger_readerData.state)
    {
    case IO_LOGGER_READER_STATE_IDLE:
        if (IO_logger_readerData.request.open)
        {
            IO_logger_readerData.request.open = false;
            IO_logger_readerData.file = fopen(IO_logger_readerData.input.filePath, "r");
            if (IO_logger_readerData.file != NULL)
            {
                IO_logger_readerData.eof = false;
                lib_staticQueue_empty(&IO_logger_readerData.queue);
                IO_logger_readerData.state = IO_LOGGER_READER_STATE_READING;
                DEBUG_INFO("GCODE_READER: opened %s\n", IO_logger_readerData.input.filePath);
            }
            else
            {
                DEBUG_ERROR("GCODE_READER: failed to open %s\n", IO_logger_readerData.input.filePath);
                IO_logger_readerData.eof = true;
                IO_logger_readerData.state = IO_LOGGER_READER_STATE_DONE;
            }
        }
        break;

    case IO_LOGGER_READER_STATE_READING:
        if (IO_logger_readerData.request.close)
        {
            IO_logger_readerData.request.close = false;
            IO_logger_readerData.state = IO_LOGGER_READER_STATE_CLOSE;
        }
        else if (!lib_staticQueue_isfull(&IO_logger_readerData.queue))
        {
            // Read lines and decode into moves until queue is full or EOF
            char line[IO_LOGGER_GCODE_LINE_SIZE];
            while (!lib_staticQueue_isfull(&IO_logger_readerData.queue) &&
                   fgets(line, sizeof(line), IO_logger_readerData.file) != NULL)
            {
                // Strip newline
                size_t len = strlen(line);
                while (len > 0 && (line[len - 1] == '\n' || line[len - 1] == '\r'))
                {
                    line[--len] = '\0';
                }

                // Skip empty lines and comments
                if (len == 0 || line[0] == ';')
                {
                    continue;
                }

                // Decode the gcode line into a move
                app_motion_move_t move;
                if (IO_gcode_decodeMove(line, &move))
                {
                    lib_staticQueue_push(&IO_logger_readerData.queue, &move);
                }
                else
                {
                    DEBUG_WARNING("GCODE_READER: failed to decode: %s\n", line);
                }
            }

            // Check if we hit EOF
            if (feof(IO_logger_readerData.file))
            {
                IO_logger_readerData.eof = true;
                fclose(IO_logger_readerData.file);
                IO_logger_readerData.file = NULL;
                IO_logger_readerData.state = IO_LOGGER_READER_STATE_DONE;
                DEBUG_INFO("%s", "GCODE_READER: reached EOF\n");
            }
        }
        break;

    case IO_LOGGER_READER_STATE_DONE:
        // Stay in DONE until closed or all moves consumed
        if (IO_logger_readerData.request.close)
        {
            IO_logger_readerData.request.close = false;
            IO_logger_readerData.state = IO_LOGGER_READER_STATE_CLOSE;
        }
        break;

    case IO_LOGGER_READER_STATE_CLOSE:
        if (IO_logger_readerData.file != NULL)
        {
            fclose(IO_logger_readerData.file);
            IO_logger_readerData.file = NULL;
        }
        lib_staticQueue_empty(&IO_logger_readerData.queue);
        IO_logger_readerData.eof = false;
        IO_logger_readerData.state = IO_LOGGER_READER_STATE_IDLE;
        DEBUG_INFO("%s", "GCODE_READER: closed\n");
        break;

    default:
        break;
    }
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

    // Initialize gcode reader
    IO_logger_readerData.state = IO_LOGGER_READER_STATE_IDLE;
    IO_logger_readerData.file = NULL;
    IO_logger_readerData.eof = false;
    IO_logger_readerData.externalRequest.open = false;
    IO_logger_readerData.externalRequest.close = false;
    IO_logger_readerData.request.open = false;
    IO_logger_readerData.request.close = false;
    lib_staticQueue_init(&IO_logger_readerData.queue,
                         IO_logger_readerData.queueBuffer,
                         IO_LOGGER_GCODE_READ_BUFFER_SIZE,
                         sizeof(app_motion_move_t),
                         lock);
}

void IO_logger_run(void)
{
    // Process write channels
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

    // Process gcode reader
    IO_logger_private_readerRun();
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

bool IO_logger_isClosed(IO_logger_channel_E channel)
{
    bool closed = false;
    if (channel < IO_LOGGER_CHANNEL_COUNT)
    {
        closed = (IO_logger_data.channelData[channel].state == IO_LOGGER_STATE_INIT);
    }
    return closed;
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

bool IO_logger_openGcodeReader(const char *filePath)
{
    IO_LOGGER_LOCK_REQ_BLOCK();
    strncpy(IO_logger_readerData.externalInput.filePath, filePath, sizeof(IO_logger_readerData.externalInput.filePath) - 1);
    IO_logger_readerData.externalInput.filePath[sizeof(IO_logger_readerData.externalInput.filePath) - 1] = '\0';
    IO_logger_readerData.externalRequest.open = true;
    IO_LOGGER_LOCK_REL();
    return true;
}

bool IO_logger_closeGcodeReader(void)
{
    IO_LOGGER_LOCK_REQ_BLOCK();
    IO_logger_readerData.externalRequest.close = true;
    IO_LOGGER_LOCK_REL();
    return true;
}

bool IO_logger_popGcodeMove(app_motion_move_t *move)
{
    return lib_staticQueue_pop(&IO_logger_readerData.queue, move);
}

bool IO_logger_isGcodeReaderDone(void)
{
    // Reader is done when EOF was reached AND queue is empty
    return IO_logger_readerData.eof && lib_staticQueue_isempty(&IO_logger_readerData.queue);
}

/**********************************************************************
 * End of File
 **********************************************************************/
