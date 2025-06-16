#ifndef APP_CONTROL_H
#define APP_CONTROL_H
//
// Created by Riley McCarthy on 22/09/24.
// @brief this file will contain the information of the machine state based on UI + machine inputs
//
/**********************************************************************
 * Includes
 **********************************************************************/
#include <stdint.h>
#include <stdbool.h>
#include "JsonDecoder.h"
#include "dev_nvram_machineProfile.h"
/**********************************************************************
 * Constants
 **********************************************************************/

/*********************************************************************
 * Macros
 **********************************************************************/

/**********************************************************************
 * Typedefs
 **********************************************************************/

typedef enum
{
    APP_CONTROL_STATE_DISABLED,
    APP_CONTROL_STATE_RESTRICTED,
    APP_CONTROL_STATE_MANUAL,
    APP_CONTROL_STATE_TEST,
    APP_CONTROL_STATE_COUNT,
} app_control_state_E;

typedef enum
{
    APP_CONTROL_FAULT_NONE,
    APP_CONTROL_FAULT_COG,
    APP_CONTROL_FAULT_WATCHDOG,
    APP_CONTROL_FAULT_ESD_POWER,
    APP_CONTROL_FAULT_ESD_SWITCH,
    APP_CONTROL_FAULT_ESD_UPPER,
    APP_CONTROL_FAULT_ESD_LOWER,
    APP_CONTROL_FAULT_SERVO_COMMUNICATION,
    APP_CONTROL_FAULT_FORCE_GAGUE_COMMUNICATION,
    APP_CONTROL_FAULT_COUNT,
} app_control_fault_E;

typedef enum
{
    APP_CONTROL_RESTRICTION_NONE,
    APP_CONTROL_RESTRICTION_SAMPLE_LENGTH,
    APP_CONTROL_RESTRICTION_SAMPLE_TENSION,
    APP_CONTROL_RESTRICTION_MACHINE_TENSION,
    APP_CONTROL_RESTRICTION_UPPER_ENDSTOP,
    APP_CONTROL_RESTRICTION_LOWER_ENDSTOP,
    APP_CONTROL_RESTRICTION_DOOR,
    APP_CONTROL_RESTRICTION_COUNT,
} app_control_restriction_E;

/**********************************************************************
 * Public Function Definitions
 **********************************************************************/
void app_control_init(int lock);
void app_control_run(void);

app_control_fault_E app_control_getFault(void);
app_control_restriction_E app_control_getRestriction(void);

bool app_control_motionEnabled(void);
bool app_control_speedLimited(void);
bool app_control_testRunning(void);

bool app_control_triggerTestStart(void);
bool app_control_triggerTestEnd(void);
bool app_control_triggerMotionEnabled(void);
bool app_control_triggerMotionDisabled(void);
bool app_control_setSampleProfile(SampleProfile *profile);
/**********************************************************************
 * End of File
 **********************************************************************/
#endif /* APP_CONTROL_H */
