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
    /* The length of the one earlier record this one extends by appending
     * fields (0 = none). A file of exactly this length is read as a prefix and
     * the newer fields keep their defaults; any other short file is an
     * unrelated older layout and is ignored in favour of the defaults.
     *
     * Kept before loadOnBoot, not after it: flexcc initialises a uint32_t that
     * follows a bool in this const table three bytes off from where it reads
     * it (72 read back as 0x48000000 on the P2, 2026-10-26), so every older
     * card fell back to the defaults on hardware while the host tests passed. */
    const uint32_t legacySize;
    const bool loadOnBoot; // Load data once on boot
} dev_nvram_channelConfig_t;

#define DEV_NVRAM_CHANNEL_CONFIG_CREATE(type, path, loadOnBoot, legacySize) \
    {                                                                       \
        &dev_nvram_##type##Data,                                            \
        &dev_nvram_##type##DataExternal,                                    \
        &dev_nvram_##type##Default,                                         \
        path,                                                               \
        sizeof(type),                                                       \
        legacySize,                                                         \
        loadOnBoot,                                                         \
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
void dev_nvram_forceSave(dev_nvram_channel_t channel);

/* Release this (main) cog's DIR on the SD SPI pins after the boot NVRAM load so
 * the LOGGER cog (IO_SDCard) can drive the SD without a P2 cross-cog pin-OR
 * conflict (else its writes fail EIO). Call once, before the worker cogs start. */
void dev_nvram_releaseSDPins(void);

#endif // WATCHDOG_H
