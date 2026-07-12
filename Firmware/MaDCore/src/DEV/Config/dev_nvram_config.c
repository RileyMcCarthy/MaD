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
    20,         // maxVelocity
    50,         // maxAcceleration
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
