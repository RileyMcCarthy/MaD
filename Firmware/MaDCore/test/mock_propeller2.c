#include <unity.h>
#include "HAL_lock.h"
#include "HAL_time.h"
#include "HAL_system.h"
#include <stdbool.h>
#include <stdlib.h>
#include <string.h>

static int lockIndex = 0;
static bool locks[8] = {0};

uint32_t global_timeus;

/* Optional direct millisecond override for uint32 wrap / 49-day timer tests.
 * When global_timems_force is true, HAL_time_getMs returns global_timems and
 * ignores global_timeus (us counters cannot represent full ms wrap). */
bool global_timems_force = false;
uint32_t global_timems = 0U;

/* Shared across every suite: Library/ objects (compiled into all suites via
 * build_src_filter) reference _stdio_debug_lock through the DEBUG_* macros, so
 * it must be defined once per suite binary. Defining it here (test root → linked
 * into every suite) covers them all. A suite that exercises DEBUG output should
 * still assign it a real lock id via HAL_lock_create() in setUp. */
int _stdio_debug_lock = 0;

void HAL_lock_mock_reset(void)
{
    lockIndex = 0;
    memset(locks, 0, sizeof(locks));
    global_timems_force = false;
    global_timems = 0U;
}

// HAL time mock implementations
uint32_t HAL_time_getMs(void)
{
    if (global_timems_force)
    {
        return global_timems;
    }
    return global_timeus / 1000U;
}
uint32_t HAL_time_getUs(void) { return global_timeus; }
void HAL_time_waitMs(uint32_t ms) { (void)ms; }
void HAL_time_waitUs(uint32_t us) { (void)us; }
uint32_t HAL_time_getCycles(void) { return global_timeus; }
uint32_t HAL_time_getClockFreq(void) { return 200000000; }

// HAL lock mock implementations
bool HAL_lock_try(int32_t lock)
{
    if (lock < 0 || lock >= (int32_t)(sizeof(locks) / sizeof(locks[0])))
    {
        TEST_FAIL();
        return false;
    }

    if (locks[lock] == 0)
    {
        locks[lock] = 1;
        return true;
    }
    TEST_FAIL();
    return false;
}
void HAL_lock_release(int32_t lock)
{
    if (lock < 0 || lock >= (int32_t)(sizeof(locks) / sizeof(locks[0])))
    {
        TEST_FAIL();
        return;
    }

    if (locks[lock] == 0)
    {
        TEST_FAIL();
        return;
    }
    locks[lock] = 0;
}
int32_t HAL_lock_create(void)
{
    if (lockIndex >= (int32_t)(sizeof(locks) / sizeof(locks[0])))
    {
        TEST_FAIL();
        return -1;
    }
    return lockIndex++;
}

// HAL system mock implementations
void HAL_system_init(void) {}
void HAL_system_reboot(void) {}
int HAL_system_startThread(void (*func)(void *), void *arg, void *stack, uint32_t stackSize)
{
    (void)func; (void)arg; (void)stack; (void)stackSize;
    return 0;
}