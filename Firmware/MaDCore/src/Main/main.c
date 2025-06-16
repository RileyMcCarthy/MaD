#include "MaD.h"
#include <propeller2.h>
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
    init_simulator();
    mad_begin();
    return 0;
}
#else
int main()
{
    mad_begin();
    while (1)
        ;
    return 0;
}
#endif
