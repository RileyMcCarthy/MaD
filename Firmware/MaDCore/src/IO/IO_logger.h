#ifndef IO_LOGGER_H
#define IO_LOGGER_H
//
// Created by Riley McCarthy on 25/04/24.
//
/**********************************************************************
 * Includes
 **********************************************************************/
#include <stdint.h>
#include <stdio.h>

#include "IO_logger_config.h"
#include "app_monitor.h"
#include "lib_staticQueue.h"
/**********************************************************************
 * Constants
 **********************************************************************/

/*********************************************************************
 * Macros
 **********************************************************************/

#define IO_LOGGER_CHANNEL_DATA_DEFINE(channel, type, bufferSize, writeTypeStr, nameformat) \
    static type IO_logger_##channel##_dataBuffer[bufferSize];                              \
    static const char IO_logger_##channel##_writeType[] = writeTypeStr;                    \
    static const char IO_logger_##channel##_nameFormat[] = nameformat;                     \
    static bool IO_logger_##channel##Format(FILE *file, lib_staticQueue_S *queue)

#define IO_LOGGER_CHANNEL_CREATE(channel)                                                       \
    {                                                                                           \
        IO_logger_##channel##Format,                                                            \
        IO_logger_##channel##_writeType,                                                        \
        IO_logger_##channel##_dataBuffer,                                                       \
        sizeof(IO_logger_##channel##_dataBuffer) / sizeof(IO_logger_##channel##_dataBuffer[0]), \
        sizeof(IO_logger_##channel##_dataBuffer[0]),                                            \
        IO_logger_##channel##_nameFormat,                                                       \
    }
/**********************************************************************
 * Typedefs
 **********************************************************************/
typedef enum
{
    IO_LOGGER_STATE_INIT,          // no file opened
    IO_LOGGER_STATE_OPEN,          // open or create file
    IO_LOGGER_STATE_WAITING,       // waiting for data
    IO_LOGGER_STATE_WRITE_DATA,    // write data
    IO_LOGGER_STATE_WRITE_COMMENT, // write comment
    IO_LOGGER_STATE_CLOSE,         // close file
} IO_logger_state_E;

typedef struct
{
    bool (*format)(FILE *, lib_staticQueue_S *);
    const char *const writeType;
    void *const queueBuffer;
    const uint32_t queueBufferSize;
    const uint32_t queueBufferItemSize;
    const char *nameFormat;
} IO_logger_channelConfig_S;

typedef struct
{
    IO_logger_channelConfig_S channelConfig[IO_LOGGER_CHANNEL_COUNT];
} IO_logger_config_S;
/**********************************************************************
 * Public Function Definitions
 **********************************************************************/
// HI FUTURE riley, main issue right now is solving how messageSlave will interact with the logger
// either addComment is blocking or we need way to close file after we are done with it
// I think blocking is best... but we need to make it fast.
void IO_logger_init(int lock);
void IO_logger_run(void);

// we have buffered logging + single shot comments (blocking)
bool IO_logger_open(IO_logger_channel_E channel, const char *fileName);
bool IO_logger_reopen(IO_logger_channel_E channel);
bool IO_logger_close(IO_logger_channel_E channel);
bool IO_logger_push(IO_logger_channel_E channel, void *data, uint32_t size);
bool IO_logger_isEmpty(IO_logger_channel_E channel);
bool IO_logger_addComment(IO_logger_channel_E channel, const char *comment, uint32_t size);
/**********************************************************************
 * End of File
 **********************************************************************/
#endif /* IO_LOGGER_H */
