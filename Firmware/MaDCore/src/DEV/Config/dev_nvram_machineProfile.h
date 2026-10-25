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
    /* Servo loop gains, in thousandths: cmd += (servoKp/1000)*err (1/s) +
     * (servoKi/1000)*integral(err) (1/s^2). APPEND-ONLY from here: a profile
     * saved before a field existed is read up to its own length and the rest
     * comes from the defaults (dev_nvram BOOT_LOAD). */
    int servoKp; // Proportional gain, 1/s x 1000 (0 or less = built-in default)
    int servoKi; // Integral gain, 1/s^2 x 1000 (0 = integral off)
} MachineProfile;

/* This struct is written to and read from the SD card as raw bytes, and it
 * carries no version, no length and no magic -- so a card written by one build
 * is read by any other build as whatever the current layout says, silently.
 * Appending a field is therefore a format change, and this assertion is what
 * makes it a deliberate one: it fails the build rather than the machine, and
 * whoever updates the number has to decide what happens to existing cards.
 *
 * The decision for an APPENDED field: an older card is a prefix of the new
 * record, and dev_nvram reads it over the defaults, so its saved fields are
 * kept and the new ones take their defaults. Inserting, removing or retyping
 * a field is still a break -- old cards would be read at the wrong offsets.
 *
 * 20 bytes of name, padded to the 4-byte alignment of the ints that follow,
 * then 15 ints (servoKp and servoKi appended to the original 13). */
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
    [(sizeof(MachineProfile) == (DEV_NVRAM_MAX_MACHINE_PROFILE_NAME + (15 * sizeof(int)))) ? 1 : -1];

#endif // DEV_NVRAM_CONFIG_MACHINEPROFILE_H
