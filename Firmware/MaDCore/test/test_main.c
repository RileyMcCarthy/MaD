#include <unity.h>
#include <propeller2.h>
#include <string.h>
#include "watchdog.h"
#include "dev_nvram.h"

extern void test_dev_nvram_loadDefaultMachineProfile(void);
extern void test_dev_nvram_saveMachineProfile(void);
extern void test_dev_nvram_loadMachineProfile(void);
extern void test_watchdog(void);
int _stdio_debug_lock;
extern dev_nvram_config_t dev_nvram_config;

void setUp(void)
{
    // Remove previous run files
    for (dev_nvram_channel_t channel = (dev_nvram_channel_t)0U; channel < DEV_NVRAM_CHANNEL_COUNT; channel++)
    {
        remove(dev_nvram_config.channels[channel].path);
    }

    // set stuff up here
    _stdio_debug_lock = _locknew();
    int lock = _locknew();
    dev_nvram_init(lock);
    watchdog_init(lock);
}

void tearDown(void)
{
    // clean stuff up here
}

void process()
{
    UNITY_BEGIN();
    RUN_TEST(test_dev_nvram_loadDefaultMachineProfile);
    RUN_TEST(test_dev_nvram_saveMachineProfile);
    RUN_TEST(test_dev_nvram_loadMachineProfile);
    RUN_TEST(test_watchdog);
    UNITY_END();
}

int main(int argc, char **argv)
{
    process();
    return 0;
}
