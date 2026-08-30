//
// Created by Riley McCarthy on 25/04/24.
// @brief Generic SD card binary struct channel system.
//
/**********************************************************************
 * Includes
 **********************************************************************/
#include "HAL_lock.h"
#include "HAL_time.h"
#include <string.h>
#include <errno.h>
#include "IO_Debug.h"

#include "IO_SDCard.h"
#include "lib_staticQueue.h"
#ifdef __FLEXC__
#include <propeller2.h>
#include <unistd.h> /* mkdir — FlexC declares it here, not in <sys/stat.h> */
#else
#include <sys/stat.h> /* mkdir */
#endif
/**********************************************************************
 * Constants
 **********************************************************************/
/* Upper bound on a single channel's binary item size (bytes). Largest configured
 * item is currently 16 B (app_monitor_sample_t); 64 B leaves headroom for future
 * channel types. processWrite/processRead use a fixed scratch buffer of this size
 * rather than a VLA sized from the (runtime-indexed) channel config — flexcc has no
 * VLA support and they are a MISRA C:2023 Rule 18.8 violation. Both functions
 * bound-check itemSize against this so an oversized channel fails safe. */
#define IO_SDCARD_MAX_ITEM_SIZE 64U

/* Longest fully-expanded channel path (`<mount>/gcode/<id>.bin` and friends),
 * including the terminator. Sizes both the per-channel filename buffer and the
 * scratch buffer the directory walk below uses. */
#define IO_SDCARD_MAX_PATH_SIZE 255U

/*********************************************************************
 * Macros
 **********************************************************************/
#define IO_SDCARD_LOCK_REQ() HAL_lock_try(IO_SDCard_data.lock)
#define IO_SDCARD_LOCK_REQ_BLOCK() while (IO_SDCARD_LOCK_REQ() == false) {}
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
    char fileName[IO_SDCARD_MAX_PATH_SIZE];
    IO_SDCard_mode_E mode;
} IO_SDCard_channelInput_S;

typedef struct
{
    bool enable;
    bool disable;
} IO_SDCard_channelRequest_S;

/* Random-access read request, serviced ON the LOGGER cog (see IO_SDCard_run). The P2
 * binds SD smartpin ownership to the cog that set them up, so a caller on another cog
 * (e.g. file_download on the COMM cog) cannot fopen/fread the SD directly — it fills
 * this request and waits while the LOGGER cog performs the read. */
typedef struct
{
    volatile bool pending;   /* caller -> LOGGER: a read is requested */
    char fileName[64];       /* short id; the LOGGER expands it via the channel nameFormat */
    void *buffer;            /* caller's destination (HUB RAM; valid while it waits) */
    uint32_t itemIndex;
    uint32_t itemCount;
    volatile uint32_t itemsRead;                  /* LOGGER -> caller: result */
    volatile IO_SDCard_readDirectStatus_E status; /* LOGGER -> caller: result */
} IO_SDCard_directRead_S;

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
    bool lastOpenFailed;

    IO_SDCard_directRead_S directRead;

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
static void IO_SDCard_private_processDirectRead(IO_SDCard_channel_E channel);

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
            DEBUG_ERROR("IO_SDCARD: Failed to open file %s (errno %d)\n", IO_SDCARD_INTERNAL_INPUT(channel).fileName, errno);
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

/* Channel queues are cross-cog (COMM/MONITOR push, CONTROL pops, this LOGGER
 * cog pumps file I/O — roles change with the channel mode), which exceeds the
 * queue's lock-free SPSC contract. Every mutating queue op is wrapped in the
 * module lock — per op, never across fread/fwrite, so file I/O latency can't
 * stall the other cogs. */
static bool IO_SDCard_private_lockedPop(IO_SDCard_channel_E channel, void *data)
{
    IO_SDCARD_LOCK_REQ_BLOCK();
    const bool ok = lib_staticQueue_pop(&IO_SDCard_data.channelData[channel].queue, data);
    IO_SDCARD_LOCK_REL();
    return ok;
}

static bool IO_SDCard_private_lockedPush(IO_SDCard_channel_E channel, void *data)
{
    IO_SDCARD_LOCK_REQ_BLOCK();
    const bool ok = lib_staticQueue_push(&IO_SDCard_data.channelData[channel].queue, data);
    IO_SDCARD_LOCK_REL();
    return ok;
}

static void IO_SDCard_private_processWrite(IO_SDCard_channel_E channel)
{
    // Write all queued items to file as raw binary structs
    const uint32_t itemSize = IO_SDCard_config.channelConfig[channel].queueBufferItemSize;
    if (itemSize > IO_SDCARD_MAX_ITEM_SIZE)
    {
        return; // configured item exceeds scratch buffer — fail safe (cannot happen for configured channels)
    }
    uint8_t itemBuffer[IO_SDCARD_MAX_ITEM_SIZE];
    while (IO_SDCard_private_lockedPop(channel, itemBuffer))
    {
        fwrite(itemBuffer, itemSize, 1, IO_SDCard_data.channelData[channel].file);
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

    const uint32_t itemSize = IO_SDCard_config.channelConfig[channel].queueBufferItemSize;
    if (itemSize > IO_SDCARD_MAX_ITEM_SIZE)
    {
        return; // configured item exceeds scratch buffer — fail safe (cannot happen for configured channels)
    }
    uint8_t itemBuffer[IO_SDCARD_MAX_ITEM_SIZE];
    while (!lib_staticQueue_isfull(&IO_SDCard_data.channelData[channel].queue))
    {
        size_t bytesRead = fread(itemBuffer, itemSize,
                                 1, IO_SDCard_data.channelData[channel].file);
        if (bytesRead == 0)
        {
            // EOF or error
            IO_SDCard_data.channelData[channel].eof = true;
            DEBUG_INFO("%s", "IO_SDCARD: reached EOF on read channel\n");
            break;
        }
        (void)IO_SDCard_private_lockedPush(channel, itemBuffer);
    }
}

/* `fopen(path, "wb")` creates the file but never the directories above it, and
 * every channel path template nests one level under the mount point
 * (`<mount>/gcode/%s.bin`, `<mount>/test/%s.bin` — see IO_SDCard_config.c). On a
 * card that has never held a test — a freshly formatted SD, or the emulator's
 * SD root in a clean checkout — the open therefore fails with ENOENT, the
 * G-code is silently never stored, and the test that was uploaded runs zero
 * moves. Provision the path instead: walk it and mkdir each component, so the
 * first write to a virgin card is the one that creates its layout.
 *
 * EEXIST is the overwhelmingly common outcome and is not an error, so the
 * result is deliberately discarded — a genuine failure (a full or read-only
 * card) is reported by the fopen that follows, with the errno that describes
 * what actually went wrong.
 *
 * This runs from IO_SDCard_run, i.e. on the LOGGER cog, which is the cog that
 * mounts and owns the SD bus — the P2 binds smartpin ownership to the cog that
 * set the pins up, so a mkdir from anywhere else would corrupt the transfer.
 * On FlexC/FatFs mkdir has been seen to fail while reporting a misleading errno;
 * discarding the result means a card where it cannot work behaves exactly as it
 * did before (subdirectories must pre-exist), while the native/emulator path —
 * where it does work — no longer needs a hand-provisioned SD root. */
static void IO_SDCard_private_ensureDirectories(const char *filePath)
{
    char dirPath[IO_SDCARD_MAX_PATH_SIZE];
    const size_t length = strlen(filePath);
    if (length < sizeof(dirPath))
    {
        (void)memcpy(dirPath, filePath, length + 1U);
        /* From 1, not 0: a leading '/' is the filesystem root, which always
         * exists and whose prefix here would be the empty string. */
        for (size_t i = 1U; i < length; i++)
        {
            if (dirPath[i] == '/')
            {
                dirPath[i] = '\0';
                (void)mkdir(dirPath, 0777);
                dirPath[i] = '/';
            }
        }
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
        const char *const fileName = IO_SDCARD_INTERNAL_INPUT(channel).fileName;
        const char *fileMode = (IO_SDCard_data.channelData[channel].mode == IO_SDCARD_MODE_WRITE) ? "wb" : "rb";
        DEBUG_INFO("IO_SDCARD: Opening file %s (mode: %s)\n", fileName, fileMode);
        if (IO_SDCard_data.channelData[channel].mode == IO_SDCARD_MODE_WRITE)
        {
            IO_SDCard_private_ensureDirectories(fileName);
        }
        IO_SDCard_data.channelData[channel].file = fopen(fileName, fileMode);
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
        IO_SDCARD_LOCK_REQ_BLOCK();
        lib_staticQueue_empty(&IO_SDCard_data.channelData[channel].queue);
        IO_SDCARD_LOCK_REL();
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
        if (IO_SDCard_data.channelData[channel].file == NULL)
        {
            IO_SDCard_data.channelData[channel].lastOpenFailed = true;
        }
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

    // Snapshot reads (advisory; exact enough for state-machine pacing).
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
    /* IMPORTANT: dev_cogManager calls cogFunctionInit on the MAIN cog (before it
     * launches the worker cog), so this runs on the MAIN cog — NOT the LOGGER cog.
     * Do NOT mount or touch the SD hardware here: the P2 ORs pin DIR + smartpin
     * ownership per cog, so the cog that sets up the SD SPI smartpins must be the
     * same one that drives them. The mount is deferred to IO_SDCard_run (LOGGER). */
    IO_SDCard_data.lock = lock;
    for (IO_SDCard_channel_E channel = (IO_SDCard_channel_E)0U; channel < IO_SDCARD_CHANNEL_COUNT; channel++)
    {
        IO_SDCard_data.channelData[channel].state = IO_SDCARD_STATE_INIT;
        IO_SDCard_data.channelData[channel].file = NULL;
        IO_SDCard_data.channelData[channel].eof = false;
        IO_SDCard_data.channelData[channel].lastOpenFailed = false;
        lib_staticQueue_init(&IO_SDCard_data.channelData[channel].queue,
                             IO_SDCard_config.channelConfig[channel].queueBuffer,
                             IO_SDCard_config.channelConfig[channel].queueBufferSize,
                             IO_SDCard_config.channelConfig[channel].queueBufferItemSize);
    }
}

void IO_SDCard_run(void)
{
#ifdef __FLEXC__
    /* Mount on the FIRST run — i.e. on the LOGGER cog itself, NOT in IO_SDCard_init
     * (which dev_cogManager runs on the MAIN cog). The cog that sets up the SD SPI
     * smartpins must also drive them, or the P2 per-cog pin/smartpin ownership
     * corrupts every transfer (writes fail errno 12 even though the MAIN-cog boot
     * read + an init-time write looked fine). */
    static bool sdMounted = false;
    if (!sdMounted)
    {
        sdMounted = true;
        const int mountResult = mount(SD_CARD_MOUNT_PATH, _vfs_open_sdcard());
        DEBUG_INFO("IO_SDCARD: LOGGER-cog mount result=%d\n", mountResult);
        (void)mountResult;
    }
#endif
    for (IO_SDCard_channel_E channel = (IO_SDCard_channel_E)0U; channel < IO_SDCARD_CHANNEL_COUNT; channel++)
    {
        IO_SDCard_private_processDirectRead(channel);
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
        IO_SDCard_data.channelData[channel].lastOpenFailed = false;
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
        /* Closing while already INIT must not latch disable: INIT never consumes disable in the
         * state machine (only OPEN/ACTIVE does), so a redundant close leaves disable stuck and the
         * next WRITE session can reopen then immediately fall through ACTIVE→CLOSE with an empty
         * queue (truncated file before new moves are queued). */
        if (IO_SDCard_data.channelData[channel].state == IO_SDCARD_STATE_INIT)
        {
            IO_SDCARD_LOCKED_REQUEST(channel).disable = false;
            IO_SDCARD_INTERNAL_REQUEST(channel).disable = false;
            success = true;
        }
        else
        {
            IO_SDCARD_LOCKED_REQUEST(channel).disable = true;
            success = true;
        }
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

bool IO_SDCard_lastOpenFailed(IO_SDCard_channel_E channel)
{
    bool failed = false;
    if (channel < IO_SDCARD_CHANNEL_COUNT)
    {
        IO_SDCARD_LOCK_REQ_BLOCK();
        failed = IO_SDCard_data.channelData[channel].lastOpenFailed;
        IO_SDCARD_LOCK_REL();
    }
    return failed;
}

void IO_SDCard_clearLastOpenFailed(IO_SDCard_channel_E channel)
{
    if (channel < IO_SDCARD_CHANNEL_COUNT)
    {
        IO_SDCARD_LOCK_REQ_BLOCK();
        IO_SDCard_data.channelData[channel].lastOpenFailed = false;
        IO_SDCARD_LOCK_REL();
    }
}

bool IO_SDCard_push(IO_SDCard_channel_E channel, void *data, uint32_t size)
{
    bool success = false;
    if ((channel < IO_SDCARD_CHANNEL_COUNT) && (size == IO_SDCard_config.channelConfig[channel].queueBufferItemSize))
    {
        success = IO_SDCard_private_lockedPush(channel, data);
    }
    return success;
}

bool IO_SDCard_pop(IO_SDCard_channel_E channel, void *data)
{
    bool success = false;
    if (channel < IO_SDCARD_CHANNEL_COUNT)
    {
        success = IO_SDCard_private_lockedPop(channel, data);
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
        // One lock for the whole batch: memory-to-memory, bounded by maxCount.
        IO_SDCARD_LOCK_REQ_BLOCK();
        while (count < maxCount)
        {
            if (!lib_staticQueue_pop(&IO_SDCard_data.channelData[channel].queue, &dst[count * itemSize]))
            {
                break;
            }
            count++;
        }
        IO_SDCARD_LOCK_REL();
    }
    return count;
}

#define IO_SDCARD_DIRECT_READ_TIMEOUT_US 2000000U /* caller's max wait for the LOGGER cog */

/* The actual SD random-access read. MUST run on the LOGGER cog (it drives the SD
 * smartpins): called from IO_SDCard_private_processDirectRead on FlexC, or directly on
 * native/SIL where stdio is thread-safe. */
static uint32_t IO_SDCard_private_doDirectRead(IO_SDCard_channel_E channel, const char *fileName,
                                               void *buffer, uint32_t itemIndex, uint32_t itemCount,
                                               IO_SDCard_readDirectStatus_E *outStatus)
{
    uint32_t itemsRead = 0U;
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
            if (outStatus != NULL)
            {
                *outStatus = IO_SDCARD_READDIRECT_STATUS_OK;
            }
        }
        else if (outStatus != NULL)
        {
            *outStatus = IO_SDCARD_READDIRECT_STATUS_SEEK_ERROR;
        }
        fclose(file);
    }
    else
    {
        DEBUG_ERROR("IO_SDCard_readDirect: failed to open %s (errno %d)\n", filePath, errno);
        if (outStatus != NULL)
        {
            *outStatus = IO_SDCARD_READDIRECT_STATUS_FILE_ERROR;
        }
    }

    return itemsRead;
}

/* LOGGER cog: service a pending random-access read (set by a caller on another cog via
 * IO_SDCard_readDirectEx). One request in flight per channel — the caller blocks until
 * `pending` clears, so the request fields are stable while we read them here. */
static void IO_SDCard_private_processDirectRead(IO_SDCard_channel_E channel)
{
    IO_SDCard_directRead_S *const dr = &IO_SDCard_data.channelData[channel].directRead;
    if (!dr->pending)
    {
        return;
    }
    IO_SDCard_readDirectStatus_E status = IO_SDCARD_READDIRECT_STATUS_FILE_ERROR;
    const uint32_t itemsRead = IO_SDCard_private_doDirectRead(channel, dr->fileName, dr->buffer,
                                                             dr->itemIndex, dr->itemCount, &status);
    dr->itemsRead = itemsRead;
    dr->status = status;
    dr->pending = false; /* result fields written above; clear last to release the caller */
}

uint32_t IO_SDCard_readDirectEx(IO_SDCard_channel_E channel, const char *fileName,
                                void *buffer, uint32_t itemIndex, uint32_t itemCount,
                                IO_SDCard_readDirectStatus_E *outStatus)
{
    if (outStatus != NULL)
    {
        *outStatus = IO_SDCARD_READDIRECT_STATUS_FILE_ERROR;
    }

    if ((channel >= IO_SDCARD_CHANNEL_COUNT) || (buffer == NULL) || (itemCount == 0U) || (fileName == NULL))
    {
        return 0U;
    }

    IO_SDCard_state_E channelState;
    IO_SDCard_mode_E channelMode;
    IO_SDCARD_LOCK_REQ_BLOCK();
    channelState = IO_SDCard_data.channelData[channel].state;
    channelMode = IO_SDCard_data.channelData[channel].mode;
    IO_SDCARD_LOCK_REL();

    if ((channelState != IO_SDCARD_STATE_INIT) && (channelMode == IO_SDCARD_MODE_WRITE))
    {
        if (outStatus != NULL)
        {
            *outStatus = IO_SDCARD_READDIRECT_STATUS_BUSY;
        }
        return 0U;
    }

#ifdef __FLEXC__
    /* On the P2 the SD smartpins belong to the LOGGER cog, so we cannot fopen/fread the
     * SD from this (caller's) cog. Hand the read to the LOGGER cog and block until it
     * finishes (file_download is a one-shot, so a short stall on the caller is fine). */
    IO_SDCard_directRead_S *const dr = &IO_SDCard_data.channelData[channel].directRead;
    strncpy(dr->fileName, fileName, sizeof(dr->fileName) - 1U);
    dr->fileName[sizeof(dr->fileName) - 1U] = '\0';
    dr->buffer = buffer;
    dr->itemIndex = itemIndex;
    dr->itemCount = itemCount;
    dr->itemsRead = 0U;
    dr->status = IO_SDCARD_READDIRECT_STATUS_FILE_ERROR;
    dr->pending = true; /* request fields set above; arm last */

    const uint32_t startUs = (uint32_t)HAL_time_getUs();
    while (dr->pending)
    {
        if (((uint32_t)HAL_time_getUs() - startUs) > IO_SDCARD_DIRECT_READ_TIMEOUT_US)
        {
            dr->pending = false;
            if (outStatus != NULL)
            {
                *outStatus = IO_SDCARD_READDIRECT_STATUS_FILE_ERROR;
            }
            return 0U;
        }
        HAL_time_waitUs(50U);
    }

    if (outStatus != NULL)
    {
        *outStatus = dr->status;
    }
    return dr->itemsRead;
#else
    /* Native/SIL: stdio is thread-safe, read directly on the caller's thread. */
    return IO_SDCard_private_doDirectRead(channel, fileName, buffer, itemIndex, itemCount, outStatus);
#endif
}

uint32_t IO_SDCard_readDirect(IO_SDCard_channel_E channel, const char *fileName,
                              void *buffer, uint32_t itemIndex, uint32_t itemCount)
{
    return IO_SDCard_readDirectEx(channel, fileName, buffer, itemIndex, itemCount, NULL);
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
