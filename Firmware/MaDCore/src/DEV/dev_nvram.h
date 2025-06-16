#ifndef DEV_NVRAM_H
#define DEV_NVRAM_H
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include "dev_nvram_config.h"
// handles non-volatile memory storage
// handles data that can be loaded on boot
// and data that is not loaded on boot but can be appended to (sdcard)
#define DEV_NVRAM_PATH_MAX 64

typedef enum
{
    DEV_NVRAM_INIT,
    DEV_NVRAM_BOOT_LOAD,
    DEV_NVRAM_READ,
    DEV_NVRAM_WRITE,
    DEV_NVRAM_READY,
    DEV_NVRAM_ERROR,
} dev_nvram_state_t;

typedef struct
{
    void *data;
    void *dataExternal;
    const void *dataDefault;

    const char path[DEV_NVRAM_PATH_MAX];
    const uint32_t size;
    const bool loadOnBoot; // Load data once on boot
} dev_nvram_channelConfig_t;

#define DEV_NVRAM_CHANNEL_CONFIG_CREATE(type, path, loadOnBoot) \
    {                                                           \
        &dev_nvram_##type##Data,                                \
        &dev_nvram_##type##DataExternal,                        \
        &dev_nvram_##type##Default,                             \
        path,                                                   \
        sizeof(type),                                           \
        loadOnBoot,                                             \
    },

#define DEV_NVRAM_CHANNEL_DATA_CREATE(type)     \
    static type dev_nvram_##type##Data;         \
    static type dev_nvram_##type##DataExternal; \
    static const type dev_nvram_##type##Default

typedef struct
{
    const dev_nvram_channelConfig_t channels[DEV_NVRAM_CHANNEL_COUNT];
} dev_nvram_config_t;

void dev_nvram_init(int lock);
void dev_nvram_run(void);

// Requests
bool dev_nvram_updateChannelData(dev_nvram_channel_t channel, void *data, size_t size);

// Outputs
bool dev_nvram_getChannelData(dev_nvram_channel_t channel, void *data, size_t size);

// non thread-safe functions
dev_nvram_state_t dev_nvram_getState(dev_nvram_channel_t channel);
bool dev_nvram_nosync_runUntilReady(void);

#endif // WATCHDOG_H
