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
extern void test_lib_utility_elapsed_gt_boundaries(void);
extern void test_lib_utility_elapsed_gt_uint32_wrap(void);
extern void test_lib_staticQueue(void);
extern void test_enum_compat_fault_codes(void);
extern void test_enum_compat_restriction_codes(void);
extern void test_enum_compat_notification_types(void);
extern void test_enum_compat_gcode_proto_path(void);
extern void test_app_testManagement_doubleStartRejected(void);
extern void test_app_testManagement_startNotDroppedWhenMotionLags(void);
extern void test_app_testManagement_manualMoveGatedWhileBusy(void);
extern void test_app_testManagement_manualMoveSlotsBounded(void);
extern void test_app_testManagement_happyPathLifecycle(void);
extern void test_app_testManagement_g122TerminatesFeed(void);
extern void test_app_testManagement_userEndStopsRun(void);
extern void test_app_testManagement_motionDisabledAbortsRun(void);
extern void test_app_testManagement_sampleLimitAbortsRun(void);
extern void test_app_testManagement_openFailureEndsStart(void);
extern void test_m5_lifecycle_start_manual_matrix(void);
extern void test_m5_restart_reaches_running_after_each_terminal(void);
extern void HAL_lock_mock_reset(void);
extern int _stdio_debug_lock; /* defined in shared test/mock_propeller2.c */
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
    RUN_TEST(test_lib_utility_elapsed_gt_boundaries);
    RUN_TEST(test_lib_utility_elapsed_gt_uint32_wrap);
    RUN_TEST(test_lib_staticQueue);
    RUN_TEST(test_enum_compat_fault_codes);
    RUN_TEST(test_enum_compat_restriction_codes);
    RUN_TEST(test_enum_compat_notification_types);
    RUN_TEST(test_enum_compat_gcode_proto_path);
    RUN_TEST(test_app_testManagement_doubleStartRejected);
    RUN_TEST(test_app_testManagement_startNotDroppedWhenMotionLags);
    RUN_TEST(test_app_testManagement_manualMoveGatedWhileBusy);
    RUN_TEST(test_app_testManagement_manualMoveSlotsBounded);
    RUN_TEST(test_app_testManagement_happyPathLifecycle);
    RUN_TEST(test_app_testManagement_g122TerminatesFeed);
    RUN_TEST(test_app_testManagement_userEndStopsRun);
    RUN_TEST(test_app_testManagement_motionDisabledAbortsRun);
    RUN_TEST(test_app_testManagement_sampleLimitAbortsRun);
    RUN_TEST(test_app_testManagement_openFailureEndsStart);
    RUN_TEST(test_m5_lifecycle_start_manual_matrix);
    RUN_TEST(test_m5_restart_reaches_running_after_each_terminal);
    UNITY_END();
}

int main(int argc, char **argv)
{
    process();
    return 0;
}
