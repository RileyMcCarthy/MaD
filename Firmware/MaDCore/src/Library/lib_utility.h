#ifndef IO_CRC_H
#define IO_CRC_H
//
// Created by Riley McCarthy on 25/04/24.
//
/**********************************************************************
 * Includes
 **********************************************************************/
#include <stdbool.h>
#include <stdint.h>
/**********************************************************************
 * Constants
 **********************************************************************/
#define LIB_UTILITY_UM_PER_MM (1000U)
#define LIB_UTILITY_MM_TO_UM(mm) ((mm) * LIB_UTILITY_UM_PER_MM)
#define LIB_UTILITY_UM_TO_MM(um) ((um) / LIB_UTILITY_UM_PER_MM)

#define LIB_UTILITY_US_PER_MS (1000U)
#define LIB_UTILITY_MS_TO_US(ms) ((ms) * LIB_UTILITY_US_PER_MS)
#define LIB_UTILITY_MN_TO_N(mN) ((mN) / 1000.0f)

#define LIB_UTILITY_BIT_MASK_1 0x01
#define LIB_UTILITY_BIT_MASK_2 0x03
#define LIB_UTILITY_BIT_MASK_3 0x07
#define LIB_UTILITY_BIT_MASK_4 0x0F
#define LIB_UTILITY_BIT_MASK_5 0x1F
#define LIB_UTILITY_BIT_MASK_6 0x3F
#define LIB_UTILITY_BIT_MASK_7 0x7F
#define LIB_UTILITY_BIT_MASK_8 0xFF

#define LIB_UTILITY_CREATE_MASK(bits, shift, value) (((value) & LIB_UTILITY_BIT_MASK_##bits) << (shift))

#define LIB_UTILITY_SET_BIT(value, bit) ((value) |= (1 << (bit)))
#define LIB_UTILITY_SET_BITS(value, bits, shift, bitValue) ((value) = ((value) & ~(LIB_UTILITY_BIT_MASK_##bits << shift)) | ((bitValue & LIB_UTILITY_BIT_MASK_##bits) << shift))
#define LIB_UTILITY_CLEAR_BIT(value, bit) ((value) &= ~(1 << (bit)))
#define LIB_UTILITY_TOGGLE_BIT(value, bit) ((value) ^= (1 << (bit)))
#define LIB_UTILITY_GET_BIT(value, bit) (((value) >> (bit)) & 0x01)

#define LIB_UTILITY_ARRAY_COUNT(array) (sizeof(array) / sizeof(array[0]))

#define LIB_UTILITY_LIMIT(value, lower, upper) ((((value < lower) ? lower : value) > upper) ? upper : value)

#define LIB_UTILITY_MIN(a, b) ((a) < (b) ? (a) : (b))
#define LIB_UTILITY_MAX(a, b) ((a) > (b) ? (a) : (b))

/*********************************************************************
 * Macros
 **********************************************************************/

/**********************************************************************
 * Typedefs
 **********************************************************************/

/**********************************************************************
 * Public Function Definitions
 **********************************************************************/
uint8_t lib_utility_CRC8(uint8_t *addr, uint16_t len);

/**
 * Signed (a * b) / c with a 32x32 -> 64 intermediate, returned as int32.
 *
 * On the Propeller 2 (FlexC) this lowers to the CORDIC: QMUL produces the
 * 64-bit unsigned product (QX/QY), then SETQ+QDIV does a 64/32 unsigned
 * divide. Sign handling is done in C. On native/SIL builds the same math
 * is performed using host int64 arithmetic.
 *
 * Returns 0 if c == 0 (no exception is raised).
 */
int32_t lib_utility_muldiv64_signed(int32_t a, int32_t b, int32_t c);

/**
 * Rollover-safe elapsed-time comparison for uint32 clocks.
 *
 * Returns true when `(now - start) > period`. Prefer this over
 * `(now - period) > start`, which underflows when `now < period` and can
 * report a spurious expiry (see IO_protocol receive timeout, 86b657ec).
 * Unsigned wrap of `now` past UINT32_MAX is handled correctly by the
 * modular subtraction.
 */
bool lib_utility_elapsed_gt(uint32_t now, uint32_t start, uint32_t period);
/**********************************************************************
 * End of File
 **********************************************************************/
#endif /* IO_CRC_H */
