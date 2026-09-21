#include <unity.h>
#include "HAL_lock.h"
#include <string.h>
#include <stdint.h>
#include "dev_nvram.h"
#include "vibes_behaviour.h"

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
    VIBES_TEST("nvram.defaults",
               "src/DEV/dev_nvram.c#dev_nvram_run",
               "a machine with no stored profile on the SD card");
    VIBES_EXPECT_WHY("boots-on-default",
                     "the machine boots on the default profile",
                     "every machine must boot with a usable envelope even before a profile has been saved");
    VIBES_EXPECT("default-values",
                 "that profile is named Default, with homing speed 10 and homing offset 5");
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
    VIBES_TEST("nvram.save-machine-profile",
               "src/DEV/dev_nvram.c#dev_nvram_updateChannelData",
               "a machine on the default profile, then updated to a new profile named Test1");
    VIBES_EXPECT("read-back-unchanged",
                 "the machine reads the new profile back unchanged");
    VIBES_EXPECT("written-to-card",
                 "the new profile is written to the SD card");
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
    FILE *file = fopen("./test/sd/profile.bin", "r");
    TEST_ASSERT_NOT_NULL(file);
    MachineProfile fileProfile;
    TEST_ASSERT_EQUAL_INT(fread(&fileProfile, sizeof(MachineProfile), 1, file), 1);
    fclose(file);
    TEST_ASSERT_EQUAL_MEMORY(&fileProfile, &dev_nvram_machineProfileTest1, sizeof(MachineProfile));
}

void test_dev_nvram_loadMachineProfile(void)
{
    VIBES_TEST("nvram.load-machine-profile",
               "src/DEV/dev_nvram.c#dev_nvram_run",
               "an SD card that already holds a saved machine profile");
    VIBES_EXPECT("boot-loads-saved",
                 "on boot the machine loads that profile and runs on it");
    // create a file with the test profile
    FILE *file = fopen("./test/sd/profile.bin", "w");
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

void test_dev_nvram_refusesOutOfRangeChannel(void)
{
    VIBES_TEST("nvram.unknown-channel-refused",
               "src/DEV/dev_nvram.c#dev_nvram_updateChannelData",
               "a write and a read on a storage channel at the channel count, and on a negative channel index");
    VIBES_EXPECT_WHY("update-refused",
                     "each write is refused",
                     "the channel array is indexed by this value, so only an in-range channel may be written");
    VIBES_EXPECT("get-refused", "each read is refused");
    VIBES_EXPECT("profile-unchanged", "the machine still holds its previous profile");
    VIBES_EXPECT("caller-buffer-untouched", "the caller's read buffer is left untouched");

    MachineProfile currentProfile;
    MachineProfile sentinel;
    const dev_nvram_channel_t pastEnd = (dev_nvram_channel_t)DEV_NVRAM_CHANNEL_COUNT;
    const dev_nvram_channel_t negative = (dev_nvram_channel_t)-1;

    /* Bring the machine profile channel to READY on the default. */
    TEST_ASSERT_EQUAL_INT(DEV_NVRAM_INIT, dev_nvram_getState(DEV_NVRAM_CHANNEL_MACHINE_PROFILE));
    dev_nvram_run();
    dev_nvram_run();
    TEST_ASSERT_EQUAL_INT(DEV_NVRAM_READY, dev_nvram_getState(DEV_NVRAM_CHANNEL_MACHINE_PROFILE));
    TEST_ASSERT_TRUE(dev_nvram_getChannelData(DEV_NVRAM_CHANNEL_MACHINE_PROFILE, &currentProfile, sizeof(MachineProfile)));
    TEST_ASSERT_EQUAL_MEMORY(&currentProfile,
                             dev_nvram_config.channels[DEV_NVRAM_CHANNEL_MACHINE_PROFILE].dataDefault,
                             sizeof(MachineProfile));

    /* Out-of-range writes must refuse and leave the in-range channel alone. */
    TEST_ASSERT_FALSE(dev_nvram_updateChannelData(pastEnd,
                                                  (void *)&dev_nvram_machineProfileTest1,
                                                  sizeof(dev_nvram_machineProfileTest1)));
    TEST_ASSERT_FALSE(dev_nvram_updateChannelData(negative,
                                                  (void *)&dev_nvram_machineProfileTest1,
                                                  sizeof(dev_nvram_machineProfileTest1)));
    TEST_ASSERT_EQUAL_INT(DEV_NVRAM_READY, dev_nvram_getState(DEV_NVRAM_CHANNEL_MACHINE_PROFILE));
    TEST_ASSERT_TRUE(dev_nvram_getChannelData(DEV_NVRAM_CHANNEL_MACHINE_PROFILE, &currentProfile, sizeof(MachineProfile)));
    TEST_ASSERT_EQUAL_MEMORY(&currentProfile,
                             dev_nvram_config.channels[DEV_NVRAM_CHANNEL_MACHINE_PROFILE].dataDefault,
                             sizeof(MachineProfile));

    /* Out-of-range reads must refuse and not touch the caller's buffer. */
    memset(&sentinel, 0xA5, sizeof(sentinel));
    TEST_ASSERT_FALSE(dev_nvram_getChannelData(pastEnd, &sentinel, sizeof(sentinel)));
    TEST_ASSERT_EACH_EQUAL_UINT8(0xA5, (uint8_t *)&sentinel, sizeof(sentinel));
    memset(&sentinel, 0x5A, sizeof(sentinel));
    TEST_ASSERT_FALSE(dev_nvram_getChannelData(negative, &sentinel, sizeof(sentinel)));
    TEST_ASSERT_EACH_EQUAL_UINT8(0x5A, (uint8_t *)&sentinel, sizeof(sentinel));
}
