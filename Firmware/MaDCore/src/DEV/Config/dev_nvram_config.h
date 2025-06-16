#ifndef DEV_NVRAM_CONFIG_H
#define DEV_NVRAM_CONFIG_H
#include <stdbool.h>
#include <stdint.h>
#include "dev_nvram_machineProfile.h"

#ifndef SD_CARD_MOUNT_PATH
#error "SD_CARD_MOUNT_PATH is not defined"
#endif

typedef enum
{
    DEV_NVRAM_CHANNEL_MACHINE_PROFILE,
    DEV_NVRAM_CHANNEL_COUNT,
} dev_nvram_channel_t;

#endif // DEV_NVRAM_CONFIG_H
