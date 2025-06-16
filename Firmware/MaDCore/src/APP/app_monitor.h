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

typedef struct
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

void app_monitor_zeroGaugeLength(void);
void app_monitor_zeroGaugeForce(void);
void app_monitor_zeroPosition(void);
void app_monitor_setTestName(const char *testName);
/**********************************************************************
 * End of File
 **********************************************************************/
#endif /* APP_MONITOR_H */
