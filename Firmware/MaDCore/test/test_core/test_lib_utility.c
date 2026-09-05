#include <unity.h>
#include <stdint.h>

#include "lib_utility.h"
#include "vibes_behaviour.h"

void test_lib_utility_muldiv64_signed(void)
{
    VIBES_BEHAVIOUR_WHY("firmware.muldiv64-signed",
                        "src/Library/lib_utility.c#lib_utility_muldiv64_signed",
                        "a multiply-then-divide whose intermediate exceeds 32 bits",
                        "the result is exact, and negative inputs give the correctly signed result",
                        "the P2 has no 64-bit divide; a 32-bit intermediate would silently wrap");

    /* Trivial cases */
    TEST_ASSERT_EQUAL_INT32(0, lib_utility_muldiv64_signed(0, 100, 5));
    TEST_ASSERT_EQUAL_INT32(0, lib_utility_muldiv64_signed(123, 0, 5));

    /* Divide-by-zero returns 0 (no exception). */
    TEST_ASSERT_EQUAL_INT32(0, lib_utility_muldiv64_signed(42, 17, 0));

    /* Basic identities */
    TEST_ASSERT_EQUAL_INT32(50, lib_utility_muldiv64_signed(100, 1, 2));
    TEST_ASSERT_EQUAL_INT32(200, lib_utility_muldiv64_signed(100, 4, 2));

    /* Sign permutations: any odd count of negative operands flips the sign. */
    TEST_ASSERT_EQUAL_INT32(-50, lib_utility_muldiv64_signed(-100, 1, 2));
    TEST_ASSERT_EQUAL_INT32(-50, lib_utility_muldiv64_signed(100, -1, 2));
    TEST_ASSERT_EQUAL_INT32(-50, lib_utility_muldiv64_signed(100, 1, -2));
    TEST_ASSERT_EQUAL_INT32(50, lib_utility_muldiv64_signed(-100, -1, 2));
    TEST_ASSERT_EQUAL_INT32(50, lib_utility_muldiv64_signed(-100, 1, -2));
    TEST_ASSERT_EQUAL_INT32(-50, lib_utility_muldiv64_signed(-100, -1, -2));

    /* Real call-site: encoderSteps * 1000 / stepPerMM matches the firmware
     * position math. Pick numbers whose intermediate exceeds 32 bits. */
    /* 1_000_000 * 1000 = 1e9, fits in int32; quotient 1e9 / 2000 = 500_000. */
    TEST_ASSERT_EQUAL_INT32(500000, lib_utility_muldiv64_signed(1000000, 1000, 2000));
    /* 100_000 * 1000 = 1e8 still in int32, but verify negative side. */
    TEST_ASSERT_EQUAL_INT32(-50000, lib_utility_muldiv64_signed(-100000, 1000, 2000));

    /* Force intermediate above 2^31: 2_000_000 * 1500 = 3e9 > INT32_MAX. */
    TEST_ASSERT_EQUAL_INT32(1500000,
        lib_utility_muldiv64_signed(2000000, 1500, 2000));

    /* INT32_MAX * 2 / 4 should be ~INT32_MAX/2. Intermediate is ~2^32. */
    const int32_t intMax = (int32_t)0x7FFFFFFF;
    TEST_ASSERT_EQUAL_INT32(intMax / 2,
        lib_utility_muldiv64_signed(intMax, 2, 4));

    /* INT32_MIN: -2^31. (INT32_MIN * 2) / 2 == INT32_MIN.
     * Note: -INT32_MIN itself overflows int32, which is why the helper
     * uses int64 in the sign-flip cast. */
    const int32_t intMin = (int32_t)0x80000000;
    TEST_ASSERT_EQUAL_INT32(intMin,
        lib_utility_muldiv64_signed(intMin, 2, 2));
}

void test_lib_utility_elapsed_gt_boundaries(void)
{
    VIBES_BEHAVIOUR("firmware.elapsed-gt-boundaries",
                    "src/Library/lib_utility.c#lib_utility_elapsed_gt",
                    "a timer checked exactly at its deadline, and again one tick before it",
                    "the deadline itself counts as elapsed; one tick before it does not");

    /* Strict greater-than: equal elapsed is NOT expired. */
    TEST_ASSERT_FALSE(lib_utility_elapsed_gt(100U, 0U, 100U));
    TEST_ASSERT_TRUE(lib_utility_elapsed_gt(101U, 0U, 100U));

    /* Near-zero now with small period: the BAD form (now - period) > start
     * would underflow and spuriously report expired when now < period. */
    TEST_ASSERT_FALSE(lib_utility_elapsed_gt(50U, 0U, 100U));
    TEST_ASSERT_FALSE(lib_utility_elapsed_gt(99U, 0U, 100U));
    TEST_ASSERT_TRUE(lib_utility_elapsed_gt(150U, 0U, 100U));

    /* Mid-range elapsed from a non-zero start. */
    TEST_ASSERT_FALSE(lib_utility_elapsed_gt(1050U, 1000U, 100U));
    TEST_ASSERT_TRUE(lib_utility_elapsed_gt(1101U, 1000U, 100U));
}

void test_lib_utility_elapsed_gt_uint32_wrap(void)
{
    /* start near UINT32_MAX, now just past wrap — modular (now - start) is small. */
    const uint32_t start = UINT32_MAX - 10U;
    TEST_ASSERT_FALSE(lib_utility_elapsed_gt(5U, start, 20U));  /* elapsed = 16 */
    TEST_ASSERT_TRUE(lib_utility_elapsed_gt(15U, start, 20U));   /* elapsed = 26 */

    /* Full wrap of exactly period is not yet expired (strict >). */
    TEST_ASSERT_FALSE(lib_utility_elapsed_gt(start + 50U, start, 50U));
    TEST_ASSERT_TRUE(lib_utility_elapsed_gt(start + 51U, start, 50U));
}
