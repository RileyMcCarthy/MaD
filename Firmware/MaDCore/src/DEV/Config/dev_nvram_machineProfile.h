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
    int loadCellCapacity;                          // Load cell rated capacity (mN)
    int loadCellSensitivity;                       // Load cell rated output at capacity (nV/V, signed: sign encodes polarity)
    int loadCellZeroBalance;                       // Bridge signal at zero force / tare (nV/V)

    int maxPosition;     // Maximum position of the machine (mm)
    int maxVelocity;     // Maximum velocity of the machine (mm/s)
    int maxAcceleration; // Maximum acceleration of the machine (mm/s2)
    int maxForceTensile; // Maximum force tensile of the machine (mN)
    int homingVelocity;  // Velocity for homing routine (mm/s)
    int homingOffset;    // Distance to move off endstop after homing (mm)
    int jawOffset;       // Distance between upper and lower jaw at endstop (mm)
    int restrictedVelocity; // Speed cap while the machine is RESTRICTED (mm/s)
} MachineProfile;

/* This struct is written to and read from the SD card as raw bytes, and it
 * carries no version, no length and no magic -- so a card written by one build
 * is read by any other build as whatever the current layout says, silently.
 * Appending a field is therefore a format change, and this assertion is what
 * makes it a deliberate one: it fails the build rather than the machine, and
 * whoever updates the number has to decide what happens to existing cards.
 *
 * 20 bytes of name, padded to the 4-byte alignment of the ints that follow,
 * then 13 ints. */
/* A negative-size array rather than _Static_assert, and enforced by clang
 * rather than by the compiler that ships.
 *
 * flexcc rejects _Static_assert outright ("syntax error, unexpected sizeof")
 * and accepts a negative-size array without complaint, so it has no working
 * compile-time size check of any kind. What catches a layout change is the
 * native_test build -- clang compiles this header for every Unity suite, and
 * firmware-unit-tests gates in CI -- so the guard holds for anything that
 * reaches a pull request, and holds for nothing built only with flexcc.
 *
 * The message lives in the identifier, because that is all a negative-size
 * array can carry: the error reads "'MachineProfile_is_persisted_raw_to_SD_so_
 * its_size_is_frozen' declared as an array with a negative size". */
typedef char MachineProfile_is_persisted_raw_to_SD_so_its_size_is_frozen
    [(sizeof(MachineProfile) == (DEV_NVRAM_MAX_MACHINE_PROFILE_NAME + (13 * sizeof(int)))) ? 1 : -1];

#endif // DEV_NVRAM_CONFIG_MACHINEPROFILE_H
