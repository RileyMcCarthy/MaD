#include <unity.h>
#include <propeller2.h>
#include <string.h>
#include "dev_nvram.h"

extern dev_nvram_config_t dev_nvram_config;
extern MachineProfile dev_nvram_machineProfileDefault;

static const MachineProfile dev_nvram_machineProfileTest1 = {
    "Test1", // name
    {
        "DYN4Test",    // motorType
        0,             // maxMotorTorque
        0,             // maxMotorRPM
        0,             // gearDiameter
        0,             // gearPitch
        0,             // systemIntertia
        0,             // staticTorque
        0,             // load
        "EncoderTest", // positionEncoderType
        0,             // encoderStepsPermm
        0,             // servoStepPermm
        "DS2Test",     // forceGauge
        0,             // forceGaugeGain
        0,             // forceGaugeOffset
    },
    {
        0, // minPosition
        0, // maxPosition
        0, // maxVelocity
        0, // maxAcceleration
        0, // maxForceTensile
        0, // maxForceCompression
        0, // forceGaugeNeutralOffset
    },
};

void test_dev_nvram_loadDefaultMachineProfile(void)
{
    // Ensure default values are correct
    MachineProfile *defaultProfile = (MachineProfile *)dev_nvram_config.channels[DEV_NVRAM_CHANNEL_MACHINE_PROFILE].dataDefault;
    TEST_ASSERT_EQUAL_CHAR_ARRAY(defaultProfile->name, "Default", strlen("Default"));
    TEST_ASSERT_EQUAL_INT(defaultProfile->configuration.maxMotorRPM, 0);
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
