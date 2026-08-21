//
// Created by Riley McCarthy on 25/04/24.
//
/**********************************************************************
 * Includes
 **********************************************************************/
#include <stdlib.h>
#include "dev_nvram.h"
/**********************************************************************
 * Constants
 **********************************************************************/

/*********************************************************************
 * Macros
 **********************************************************************/

/**********************************************************************
 * Typedefs
 **********************************************************************/

/**********************************************************************
 * Variable Definitions
 **********************************************************************/

DEV_NVRAM_CHANNEL_DATA_CREATE(MachineProfile) = {
    "Default", // name
    (4 * 2048),         // encoderStepsPerMM
    (4 * 2048),         // servoStepsPerMM
    /* Load-cell capacity/sensitivity back-calculated from the legacy calibration
     * (cpf -658 counts/N at gain 1, internal 2.048 V reference, 3.3 V excitation:
     * one legacy count = 2.048 V / 2^23 / 3.3 V = 73.98 nV/V), preserving the
     * legacy force slope in intrinsic units. Zero balance defaults to 0: the
     * legacy zero (-48.65 mV/V) encoded the old front-end's amplifier offset,
     * which exceeds the gain-128 input range (±7.8 mV/V) and is meaningless for
     * a bare bridge — tare is installation-specific and set per machine. */
    100000,       // loadCellCapacity (mN) — nominal 100 N reference span
    -4868009,     // loadCellSensitivity (nV/V at capacity) = -658 * 73.98 * 100
    0,            // loadCellZeroBalance (nV/V) — tare on installation
    100,         // maxPosition
    /* Motion envelope. The closed-loop servo (dev_servo) ENFORCES both of these:
     * maxVelocity clamps the commanded velocity and every move feedrate, and
     * maxAcceleration paces the trajectory ramp. The legacy open-loop stepper
     * ignored them, so anything commanded above the envelope used to execute
     * anyway; now it is tracked at the limit and comes out attenuated.
     * Sized for the cyclic waveform (G123) duty the machine is built for: a
     * sine of amplitude A at frequency f demands 2*pi*f*A peak velocity and
     * (2*pi*f)^2*A peak acceleration, so the reference 3 mm @ 2 Hz case needs
     * 37.7 mm/s and 474 mm/s^2. These carry ~30% headroom over that — the
     * waveform must be tracked BELOW the limits, not at them, or the peaks
     * clip and the recorded motion stops matching the commanded f(t). */
    50,         // maxVelocity
    600,        // maxAcceleration
    5000,         // maxForceTensile
    10,         // homingVelocity
    5,          // homingOffset
    25,         // jawOffset - default distance between jaws at endstop (mm)
};

// should rename to have prefix like lib or app or io etc
const dev_nvram_config_t dev_nvram_config = {
    {DEV_NVRAM_CHANNEL_CONFIG_CREATE(MachineProfile, SD_CARD_MOUNT_PATH "/profile.bin", true)},
};

/**********************************************************************
 * Private Function Prototypes
 **********************************************************************/

/**********************************************************************
 * Private Function Definitions
 **********************************************************************/

/**********************************************************************
 * Public Function Definitions
 **********************************************************************/

/**********************************************************************
 * End of File
 **********************************************************************/
