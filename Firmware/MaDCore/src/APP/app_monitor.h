#ifndef APP_MONITOR_H
#define APP_MONITOR_H
//
// Created by Riley McCarthy on 25/04/24.
// @brief This module is responsible for aggregating sensor measurements (time, position, force).
// This module is thread-safe.
//
/**********************************************************************
 * Includes
 **********************************************************************/
#include <stdbool.h>
#include <stdint.h>
/**********************************************************************
 * Constants
 **********************************************************************/

/*********************************************************************
 * Macros
 **********************************************************************/

/**********************************************************************
 * Typedefs
 **********************************************************************/

typedef struct __attribute__((packed))
{
    int32_t force;    // mN
    int32_t position; // um
    uint32_t time;    // us
    uint32_t index;   // sample id, should determine overflow at 1000sps
    int32_t setpoint; // um
} app_monitor_sample_t;

typedef enum
{
    APP_MONITOR_LOGGING_STATE_IDLE,
    APP_MONITOR_LOGGING_STATE_RUNNING,
    APP_MONITOR_LOGGING_STATE_STOPPING,
    APP_MONITOR_LOGGING_STATE_COUNT,
} app_monitor_loggingState_E;

typedef struct
{
    uint32_t maxForce;        // Maximum force (mN)
    uint32_t maxVelocity;     // Maximum velocity (mm/s)
    uint32_t maxDisplacement; // Maximum displacement (mm)
    uint32_t sampleWidth;     // Sample width (mm)
    uint32_t sampleThickness; // Sample thickness (mm)
} app_monitor_sampleProfile_S;

/**********************************************************************
 * Public Function Definitions
 **********************************************************************/

void app_monitor_init(int lock);
void app_monitor_run(void);

void app_monitor_getSample(app_monitor_sample_t *sample);
int32_t app_monitor_getSampleForce(void);
int32_t app_monitor_getSamplePosition(void);

int32_t app_monitor_getAbsoluteForce(void);    // force gauge feedback
int32_t app_monitor_getAbsolutePosition(void); // position relative to upper endstop

int32_t app_monitor_getGaugeLength(void);

void app_monitor_zeroSamplePosition(void);
void app_monitor_zeroSampleForce(void);
void app_monitor_zeroPosition(void);
void app_monitor_setPosition(int32_t positionUM);
void app_monitor_setTestName(const char *testName);
bool app_monitor_getNextTestName(char *outName, uint32_t size);
void app_monitor_getTestName(char *outName, uint32_t size);

bool app_monitor_setSampleProfile(app_monitor_sampleProfile_S *profile);
void app_monitor_getSampleProfile(app_monitor_sampleProfile_S *profile);
bool app_monitor_isSampleProfileLoaded(void);

bool app_monitor_isForceExceeded(void);
bool app_monitor_isVelocityExceeded(void);
bool app_monitor_isDisplacementExceeded(void);
/**********************************************************************
 * End of File
 **********************************************************************/
#endif /* APP_MONITOR_H */
