#include <unity.h>
#include "HAL_lock.h"
#include <string.h>
#include "watchdog.h"
#include "dev_nvram.h"

extern void test_dev_nvram_loadDefaultMachineProfile(void);
extern void test_dev_nvram_saveMachineProfile(void);
extern void test_dev_nvram_loadMachineProfile(void);
extern void test_watchdog(void);
extern void test_protoemb_stored_sample_roundtrip(void);
extern void test_protoemb_runtime_send_notification_frame(void);
extern void test_lib_utility_muldiv64_signed(void);
extern void HAL_lock_mock_reset(void);
int _stdio_debug_lock;
extern dev_nvram_config_t dev_nvram_config;

void setUp(void)
{
    HAL_lock_mock_reset();

    // Remove previous run files
    for (dev_nvram_channel_t channel = (dev_nvram_channel_t)0U; channel < DEV_NVRAM_CHANNEL_COUNT; channel++)
    {
        remove(dev_nvram_config.channels[channel].path);
    }

    // set stuff up here
    _stdio_debug_lock = HAL_lock_create();
    int lock = HAL_lock_create();
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
    RUN_TEST(test_protoemb_stored_sample_roundtrip);
    RUN_TEST(test_protoemb_runtime_send_notification_frame);
    RUN_TEST(test_lib_utility_muldiv64_signed);
    UNITY_END();
}

int main(int argc, char **argv)
{
    process();
    return 0;
}
