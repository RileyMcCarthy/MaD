#include <unity.h>
#include <propeller2.h>
#include <string.h>
#include "dev_nvram.h"

extern dev_nvram_config_t dev_nvram_config;
extern MachineProfile dev_nvram_machineProfileDefault;

static const MachineProfile dev_nvram_machineProfileTest1 = {
    "Test1",    // name
    1000,       // encoderStepsPerMM
    1000,       // servoStepsPerMM
    -500,       // forceGaugeNPerStep
    16000000,   // forceGaugeZeroOffset
    80,         // maxPosition
    15,         // maxVelocity
    40,         // maxAcceleration
    4000,       // maxForceTensile
    8,          // homingVelocity
    3,          // homingOffset
};

void test_dev_nvram_loadDefaultMachineProfile(void)
{
    // Ensure default values are correct
    MachineProfile *defaultProfile = (MachineProfile *)dev_nvram_config.channels[DEV_NVRAM_CHANNEL_MACHINE_PROFILE].dataDefault;
    TEST_ASSERT_EQUAL_CHAR_ARRAY(defaultProfile->name, "Default", strlen("Default"));
    TEST_ASSERT_EQUAL_INT(defaultProfile->homingVelocity, 10);
    TEST_ASSERT_EQUAL_INT(defaultProfile->homingOffset, 5);
    TEST_ASSERT_EQUAL_INT(dev_nvram_config.channels[DEV_NVRAM_CHANNEL_MACHINE_PROFILE].size, sizeof(MachineProfile));

    // Ensure that default profile is not yet loaded
    TEST_ASSERT_EQUAL_INT(DEV_NVRAM_INIT, dev_nvram_getState(DEV_NVRAM_CHANNEL_MACHINE_PROFILE));
    dev_nvram_run();

    // Check that loadOnboot is working
    TEST_ASSERT_EQUAL_INT(DEV_NVRAM_BOOT_LOAD, dev_nvram_getState(DEV_NVRAM_CHANNEL_MACHINE_PROFILE));
    dev_nvram_run();

    // Check that we copy the default data
    MachineProfile currentProfile;
    TEST_ASSERT_TRUE(dev_nvram_getChannelData(DEV_NVRAM_CHANNEL_MACHINE_PROFILE, &currentProfile, sizeof(MachineProfile)));
    TEST_ASSERT_EQUAL_INT(DEV_NVRAM_READY, dev_nvram_getState(DEV_NVRAM_CHANNEL_MACHINE_PROFILE));
    TEST_ASSERT_EQUAL_MEMORY(&currentProfile, dev_nvram_config.channels[DEV_NVRAM_CHANNEL_MACHINE_PROFILE].dataDefault, sizeof(MachineProfile));
}

void test_dev_nvram_saveMachineProfile(void)
{
    MachineProfile currentProfile;

    TEST_ASSERT_EQUAL_INT(DEV_NVRAM_INIT, dev_nvram_getState(DEV_NVRAM_CHANNEL_MACHINE_PROFILE));
    dev_nvram_run();
    dev_nvram_run();

    // Check that we are ready and loaded the default machine profile
    TEST_ASSERT_EQUAL_INT(DEV_NVRAM_READY, dev_nvram_getState(DEV_NVRAM_CHANNEL_MACHINE_PROFILE));
    TEST_ASSERT_TRUE(dev_nvram_getChannelData(DEV_NVRAM_CHANNEL_MACHINE_PROFILE, &currentProfile, sizeof(MachineProfile)));
    TEST_ASSERT_EQUAL_MEMORY(&currentProfile, dev_nvram_config.channels[DEV_NVRAM_CHANNEL_MACHINE_PROFILE].dataDefault, sizeof(MachineProfile));

    // request new data
    TEST_ASSERT_TRUE(dev_nvram_updateChannelData(DEV_NVRAM_CHANNEL_MACHINE_PROFILE, (void *)&dev_nvram_machineProfileTest1, sizeof(dev_nvram_machineProfileTest1)));
    dev_nvram_run();

    // Check that we are writing the new data
    TEST_ASSERT_EQUAL_INT(DEV_NVRAM_WRITE, dev_nvram_getState(DEV_NVRAM_CHANNEL_MACHINE_PROFILE));
    dev_nvram_run();

    // Check that we are ready and loaded the new machine profile
    TEST_ASSERT_EQUAL_INT(DEV_NVRAM_READY, dev_nvram_getState(DEV_NVRAM_CHANNEL_MACHINE_PROFILE));
    TEST_ASSERT_TRUE(dev_nvram_getChannelData(DEV_NVRAM_CHANNEL_MACHINE_PROFILE, &currentProfile, sizeof(MachineProfile)));
    TEST_ASSERT_EQUAL_MEMORY(&currentProfile, &dev_nvram_machineProfileTest1, sizeof(MachineProfile));

    // Check that the file was created and contains the new data
    FILE *file = fopen("./test/sd/MachineProfile.json", "r");
    TEST_ASSERT_NOT_NULL(file);
    MachineProfile fileProfile;
    TEST_ASSERT_EQUAL_INT(fread(&fileProfile, sizeof(MachineProfile), 1, file), 1);
    fclose(file);
    TEST_ASSERT_EQUAL_MEMORY(&fileProfile, &dev_nvram_machineProfileTest1, sizeof(MachineProfile));
}

void test_dev_nvram_loadMachineProfile(void)
{
    // create a file with the test profile
    FILE *file = fopen("./test/sd/MachineProfile.json", "w");
    TEST_ASSERT_NOT_NULL(file);
    TEST_ASSERT_EQUAL_INT(fwrite(&dev_nvram_machineProfileTest1, sizeof(MachineProfile), 1, file), 1);
    fclose(file);

    // Ensure that profile is not yet loaded
    TEST_ASSERT_EQUAL_INT(DEV_NVRAM_INIT, dev_nvram_getState(DEV_NVRAM_CHANNEL_MACHINE_PROFILE));
    dev_nvram_run();

    // Check that loadOnboot is working
    TEST_ASSERT_EQUAL_INT(DEV_NVRAM_BOOT_LOAD, dev_nvram_getState(DEV_NVRAM_CHANNEL_MACHINE_PROFILE));
    dev_nvram_run();

    // Check that we copy the default data
    MachineProfile currentProfile;
    TEST_ASSERT_TRUE(dev_nvram_getChannelData(DEV_NVRAM_CHANNEL_MACHINE_PROFILE, &currentProfile, sizeof(MachineProfile)));
    TEST_ASSERT_EQUAL_INT(DEV_NVRAM_READY, dev_nvram_getState(DEV_NVRAM_CHANNEL_MACHINE_PROFILE));
    TEST_ASSERT_EQUAL_MEMORY(&currentProfile, &dev_nvram_machineProfileTest1, sizeof(MachineProfile));
}
