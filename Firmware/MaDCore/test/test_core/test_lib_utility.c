#include <unity.h>
#include <stdint.h>

#include "lib_utility.h"

void test_lib_utility_muldiv64_signed(void)
{
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
