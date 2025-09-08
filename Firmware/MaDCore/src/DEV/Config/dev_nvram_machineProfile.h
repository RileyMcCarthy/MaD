#ifndef DEV_NVRAM_CONFIG_MACHINEPROFILE_H
#define DEV_NVRAM_CONFIG_MACHINEPROFILE_H
#include <stdbool.h>
#include <stdint.h>

#define DEV_NVRAM_MAX_MACHINE_PROFILE_NAME 20
#define DEV_NVRAM_MAX_SAMPLE_PROFILE_NAME 45

typedef struct
{
    char name[DEV_NVRAM_MAX_MACHINE_PROFILE_NAME]; // Name of the machine profile
    int encoderStepsPerMM;                         // Steps per mm of the encoder
    int servoStepsPerMM;                           // Steps per mm of the servo
    int forceGaugeNPerStep;                        // Force gauge N per step
    int forceGaugeZeroOffset;                      // Force gauge zero offset

    int maxPosition;     // Maximum position of the machine (mm)
    int maxVelocity;     // Maximum velocity of the machine (mm/s)
    int maxAcceleration; // Maximum acceleration of the machine (mm/s2)
    int maxForceTensile; // Maximum force tensile of the machine (mN)
    int homingVelocity;  // Velocity for homing routine (mm/s)
    int homingOffset;    // Distance to move off endstop after homing (mm)
    int jawOffset;       // Distance between upper and lower jaw at endstop (mm)
} MachineProfile;

#endif // DEV_NVRAM_CONFIG_MACHINEPROFILE_H
