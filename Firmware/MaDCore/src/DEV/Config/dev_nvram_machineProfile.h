#ifndef DEV_NVRAM_CONFIG_MACHINEPROFILE_H
#define DEV_NVRAM_CONFIG_MACHINEPROFILE_H
#include <stdbool.h>
#include <stdint.h>

#define DEV_NVRAM_MAX_MACHINE_PROFILE_NAME 20
#define DEV_NVRAM_MAX_SAMPLE_PROFILE_NAME 45

typedef struct
{
    // make V2 and sync with UI
    char name[DEV_NVRAM_MAX_MACHINE_PROFILE_NAME]; // Name of the machine profile
    int encoderStepsPerMM;                         // Steps per mm of the encoder
    int servoStepsPerMM;                           // Steps per mm of the servo
    int forceGaugeNPerStep;                        // Force gauge N per step
    int forceGaugeZeroOffset;                      // Force gauge zero offset

    int maxPosition;     // Maximum position of the machine (mm)
    int maxVelocity;     // Maximum velocity of the machine (mm/s)
    int maxAcceleration; // Maximum acceleration of the machine (mm/s2)
    int maxForceTensile; // Maximum force tensile of the machine (mN)
} MachineProfile;

typedef struct SampleProfile
{
    uint32_t maxForce;        // Maximum force (mN)
    uint32_t maxVelocity;     // Maximum velocity (mm/s)
    uint32_t maxDisplacement; // Maximum displacement (mm)
    uint32_t sampleWidth;     // Sample width (mm)
    uint32_t serialNumber;     // Serial number (0-99999)
} SampleProfile;

#endif // DEV_NVRAM_CONFIG_MACHINEPROFILE_H
