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

/**
 * @brief Main method that is called on program startup.
 * Begins MaD Board instance
 *
 * @return int
 */
#ifdef __EMULATION__
int main() {
    setbuf(stdout, NULL);
    HAL_system_init();
    mad_begin();
    return 0;
}
#else
int main()
{
    HAL_system_init();
    printf("Starting MaD Board\n");
    mad_begin();
    while (1)
        ;
    return 0;
}
#endif
