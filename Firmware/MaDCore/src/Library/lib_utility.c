// https://stackoverflow.com/questions/51731313/cross-platform-lib_utility_CRC8-function-c-and-python-parity-check
//
// Created by Riley McCarthy on 25/04/24.
//
/**********************************************************************
 * Includes
 **********************************************************************/
#include <stdbool.h>
#include <stdint.h>

#include "lib_utility.h"
/**********************************************************************
 * Constants
 **********************************************************************/

/*********************************************************************
 * Macros
 **********************************************************************/

/**********************************************************************
 * Typedefs
 **********************************************************************/

/**********************************************************************
 * External Variables
 **********************************************************************/

/**********************************************************************
 * Private Variable Definitions
 **********************************************************************/

/**********************************************************************
 * Private Function Prototypes
 **********************************************************************/

/**********************************************************************
 * Private Function Definitions
 **********************************************************************/

/**********************************************************************
 * Public Function Definitions
 **********************************************************************/

int32_t lib_utility_muldiv64_signed(int32_t a, int32_t b, int32_t c)
{
    /* Compute the sign of (a*b)/c in C; the CORDIC ops below operate on
     * unsigned magnitudes. XOR of the three sign bits gives the result sign. */
    const bool negative = (((a < 0) ? 1U : 0U)
                         ^ ((b < 0) ? 1U : 0U)
                         ^ ((c < 0) ? 1U : 0U)) != 0U;
    const uint32_t ua = (a < 0) ? (uint32_t)(-(int64_t)a) : (uint32_t)a;
    const uint32_t ub = (b < 0) ? (uint32_t)(-(int64_t)b) : (uint32_t)b;
    /* Absolute magnitude of c is the actual divisor. Guard on uc (not c) so
     * the divide cannot be a zero-divisor path under static analysis either. */
    const uint32_t uc = (c < 0) ? (uint32_t)(-(int64_t)c) : (uint32_t)c;

    if (uc == 0U)
    {
        return 0;
    }

    uint32_t quotient = 0U;

#ifdef __FLEXC__
    /* Propeller 2: QMUL gives 64-bit product in QX (low) / QY (high).
     * SETQ loads the high word of the dividend before QDIV does
     * (QY:QX) / uc, with the 32-bit quotient in QX. */
    uint32_t productLo;
    uint32_t productHi;
    __asm {
        qmul ua, ub
        getqx productLo
        getqy productHi
        setq productHi
        qdiv productLo, uc
        getqx quotient
    }
#else
    /* Native / SIL: rely on host 64-bit arithmetic. */
    const uint64_t product = (uint64_t)ua * (uint64_t)ub;
    quotient = (uint32_t)(product / (uint64_t)uc);
#endif

    return negative ? -(int32_t)quotient : (int32_t)quotient;
}

bool lib_utility_elapsed_gt(uint32_t now, uint32_t start, uint32_t period)
{
    /* Modular subtraction is well-defined for unsigned types and is the
     * standard pattern for rollover-safe elapsed-time checks. */
    return (now - start) > period;
}

uint8_t lib_utility_CRC8(uint8_t *addr, uint16_t len)
{
    uint8_t crc = 0U;
    for (uint16_t i = 0U; i < len; i++)
    {
        uint8_t inbyte = addr[i];
        for (uint8_t j = 0U; j < 8U; j++)
        {
            uint8_t mix = (crc ^ inbyte) & 0x01;
            crc >>= 1;
            if (mix)
            {
                crc ^= 0x8C;
            }
            inbyte >>= 1;
        }
    }
    return crc;
}

/**********************************************************************
 * End of File
 **********************************************************************/
