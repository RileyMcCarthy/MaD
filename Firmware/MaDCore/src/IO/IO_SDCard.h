#ifndef IO_SDCARD_H
#define IO_SDCARD_H
//
// Created by Riley McCarthy on 25/04/24.
// @brief Generic SD card binary struct channel system.
// @details Each channel reads or writes raw packed C structs to/from files.
//          No CSV, no text encoding — just binary fwrite/fread of structs.
//          Channels support WRITE mode (push structs → queue → fwrite to file)
//          or READ mode (fread from file → queue → pop structs).
//
/**********************************************************************
 * Includes
 **********************************************************************/
#include <stdint.h>
#include <stdbool.h>
#include <stdio.h>

#include "IO_SDCard_config.h"
#include "lib_staticQueue.h"
/**********************************************************************
 * Constants
 **********************************************************************/

/*********************************************************************
 * Macros
 **********************************************************************/

/**
 * @brief Declare a channel's static buffer and path format.
 *        Used in IO_SDCard_config.c to define per-channel storage.
 */
#define IO_SDCARD_CHANNEL_DATA_DEFINE(channel, type, bufferSize, nameformat) \
    static type IO_SDCard_##channel##_dataBuffer[bufferSize];                \
    static const char IO_SDCard_##channel##_nameFormat[] = nameformat

#define IO_SDCARD_CHANNEL_CREATE(channel)                                                         \
    {                                                                                             \
        IO_SDCard_##channel##_dataBuffer,                                                         \
        sizeof(IO_SDCard_##channel##_dataBuffer) / sizeof(IO_SDCard_##channel##_dataBuffer[0]),    \
        sizeof(IO_SDCard_##channel##_dataBuffer[0]),                                              \
        IO_SDCard_##channel##_nameFormat,                                                         \
    }

/**********************************************************************
 * Typedefs
 **********************************************************************/

typedef enum
{
    IO_SDCARD_MODE_WRITE,  // Push structs → queue → fwrite to file
    IO_SDCARD_MODE_READ,   // fread from file → queue → pop structs
} IO_SDCard_mode_E;

typedef enum
{
    IO_SDCARD_STATE_INIT,     // No file opened
    IO_SDCARD_STATE_OPEN,     // Opening file
    IO_SDCARD_STATE_ACTIVE,   // File open, processing data (read or write)
    IO_SDCARD_STATE_CLOSE,    // Closing file
} IO_SDCard_state_E;

typedef struct
{
    void *const queueBuffer;
    const uint32_t queueBufferSize;
    const uint32_t queueBufferItemSize;
    const char *nameFormat;
} IO_SDCard_channelConfig_S;

typedef struct
{
    IO_SDCard_channelConfig_S channelConfig[IO_SDCARD_CHANNEL_COUNT];
} IO_SDCard_config_S;
/**********************************************************************
 * Public Function Definitions
 **********************************************************************/
void IO_SDCard_init(int lock);
void IO_SDCard_run(void);

/**
 * @brief Open a channel for writing or reading.
 * @param channel The channel to open.
 * @param fileName Base name (inserted into the channel's path format).
 * @param mode WRITE to push structs to file, READ to read structs from file.
 * @return true if the open request was accepted.
 */
bool IO_SDCard_open(IO_SDCard_channel_E channel, const char *fileName, IO_SDCard_mode_E mode);

/**
 * @brief Close a channel. For WRITE mode, flushes remaining queue data first.
 */
bool IO_SDCard_close(IO_SDCard_channel_E channel);

/**
 * @brief Check if a channel is in INIT state (closed / idle).
 */
bool IO_SDCard_isClosed(IO_SDCard_channel_E channel);

/**
 * @brief Push a struct into a WRITE-mode channel's queue.
 * @param data Pointer to the struct to push.
 * @param size Must equal the channel's queueBufferItemSize.
 */
bool IO_SDCard_push(IO_SDCard_channel_E channel, void *data, uint32_t size);

/**
 * @brief Pop a struct from a READ-mode channel's queue.
 * @param data Pointer to receive the struct.
 */
bool IO_SDCard_pop(IO_SDCard_channel_E channel, void *data);

/**
 * @brief Pop up to maxCount structs from a channel's queue into a contiguous buffer.
 * @param buffer Destination buffer (must hold at least maxCount * itemSize bytes).
 * @param maxCount Maximum number of items to pop.
 * @return Number of items actually popped.
 */
uint32_t IO_SDCard_popMultiple(IO_SDCard_channel_E channel, void *buffer, uint32_t maxCount);

/**
 * @brief Direct synchronous read from a channel's file, bypassing the queue.
 * @details Opens the file, seeks to itemIndex * itemSize, reads up to itemCount items
 *          into the buffer, then closes the file. Does NOT use the queue or state machine.
 *          Caller provides the file name (inserted into the channel's path format).
 * @param channel The channel (used only for item size and path format).
 * @param fileName Base name inserted into the channel's path format.
 * @param buffer Destination buffer (must hold at least itemCount * itemSize bytes).
 * @param itemIndex Zero-based index of the first item to read.
 * @param itemCount Maximum number of items to read.
 * @return Number of items actually read (0 on error or EOF).
 */
uint32_t IO_SDCard_readDirect(IO_SDCard_channel_E channel, const char *fileName,
                              void *buffer, uint32_t itemIndex, uint32_t itemCount);

/**
 * @brief Check if a READ-mode channel has reached EOF and its queue is empty.
 */
bool IO_SDCard_isReadDone(IO_SDCard_channel_E channel);

/**********************************************************************
 * End of File
 **********************************************************************/
#endif /* IO_SDCARD_H */
