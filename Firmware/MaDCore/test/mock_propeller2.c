#include <unity.h>
#include "HAL_lock.h"
#include "HAL_time.h"
#include "HAL_system.h"
#include <stdlib.h>

static int lockIndex = 0;
static bool locks[8] = {0};

uint32_t global_timeus;

// HAL time mock implementations
uint32_t HAL_time_getMs(void) { return global_timeus / 1000; }
uint32_t HAL_time_getUs(void) { return global_timeus; }
void HAL_time_waitMs(uint32_t ms) { (void)ms; }
void HAL_time_waitUs(uint32_t us) { (void)us; }
uint32_t HAL_time_getCycles(void) { return global_timeus; }
uint32_t HAL_time_getClockFreq(void) { return 200000000; }

// HAL lock mock implementations
bool HAL_lock_try(int32_t lock)
{
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
    if (locks[lock] == 0)
    {
        TEST_FAIL();
        return;
    }
    locks[lock] = 0;
}
int32_t HAL_lock_create(void) { return lockIndex++; }

// HAL system mock implementations
void HAL_system_init(void) {}
void HAL_system_reboot(void) {}
int HAL_system_startThread(void (*func)(void *), void *arg, void *stack, uint32_t stackSize)
{
    (void)func; (void)arg; (void)stack; (void)stackSize;
    return 0;
}