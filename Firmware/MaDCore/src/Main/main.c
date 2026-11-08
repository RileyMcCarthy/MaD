#define P2_TARGET_MHZ 200
#include "MaD.h"
#include "HAL_system.h"
#if PROPELLER_FRAMEWORK == P2LLVM
#include <sys/p2es_clock.h>
#endif
#include <stdio.h>
#include <stdint.h>
#include <string.h>
#include <stdlib.h>

enum
{
    HEAPSIZE = 32400 * 4
};

/* The version the boot line names: the build's stamp, as the protocol's
 * firmware-version reply reports it (APP/app_messageSlave.c), so a log on P62
 * says which image booted. */
#ifdef FIRMWARE_VERSION
#define MAIN_FIRMWARE_VERSION FIRMWARE_VERSION
#else
#define MAIN_FIRMWARE_VERSION "0.0.0"
#endif

/**
 * @brief Main method that is called on program startup.
 * Begins MaD Board instance
 *
 * @return int
 */
int main()
{
    HAL_system_init();
    printf("Starting MaD Board %s\n", MAIN_FIRMWARE_VERSION);
    mad_begin();
    while (1)
        ;
    return 0;
}
