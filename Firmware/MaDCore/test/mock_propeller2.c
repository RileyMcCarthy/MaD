#include <unity.h>
#include <propeller2.h>
#include <stdlib.h>

static int lockIndex = 0;
static bool locks[8] = {0};

uint32_t global_timeus;
uint32_t _getms(void) { return global_timeus * 1000; }
uint32_t _getus(void) { return global_timeus; }
int _locktry(int lock)
{
    if (locks[lock] == 0)
    {
        locks[lock] = 1;
        return 1;
    }
    TEST_FAIL();
    return 0;
}
int _lockrel(int lock)
{
    if (locks[lock] == 0)
    {
        TEST_FAIL();
        return -1;
    }
    locks[lock] = 0;
    return 0;
}
int _locknew(void) { return lockIndex++; }

void *_vfs_open_sdcard()
{
    return NULL;
}