#define P2_TARGET_MHZ 200
#include "MaD.h"
#include <propeller.h>
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
    init_simulator();
    mad_begin();
    return 0;
}
#else
int main()
{
#if PROPELLER_FRAMEWORK == P2LLVM
    _clkset(_SETFREQ, _CLOCKFREQ);
    _uart_init(DBG_UART_RX_PIN, DBG_UART_TX_PIN, 230400, 0);
#endif
    printf("Starting MaD Board\n");
    printf("framework: %d == %d, not %d\n", PROPELLER_FRAMEWORK, P2LLVM, FLEXCC);
    mad_begin();
    while (1)
        ;
    return 0;
}
#endif
