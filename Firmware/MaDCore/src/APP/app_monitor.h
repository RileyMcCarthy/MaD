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

/* Note on sample identification: the firmware no longer carries a per-sample index in this
 * struct or in the wire protocol (ProtoEmb_Sample / ProtoEmb_StoredSample). Rows are
 * implicitly ordered by `time`, and the host treats each row as one logging tick. As a
 * consequence the host UI cannot detect dropped/duplicated samples — live charts use
 * wall-clock pacing (renderer Graph.tsx) and stored CSVs use row offset as id. If you
 * need drop detection again, add `index` back here AND to MaDProtocol.yaml + regenerate. */
typedef struct __attribute__((packed))
{
    int32_t force;    // mN (sample frame)
    int32_t position; // nm (sample frame)
    uint32_t time;    // us since test start
    /* What the trajectory commanded at this instant, minus the gauge length
     * (sample coords). NOT the move's destination: see app_motion. */
    int32_t setpoint; // nm (sample frame)
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

void app_monitor_zeroPosition(void);
void app_monitor_setPosition(int32_t positionUM);
void app_monitor_setTestName(const char *testName);
void app_monitor_getTestName(char *outName, uint32_t size);

bool app_monitor_setSampleProfile(app_monitor_sampleProfile_S *profile);
void app_monitor_getSampleProfile(app_monitor_sampleProfile_S *profile);
bool app_monitor_isSampleProfileLoaded(void);

bool app_monitor_isForceExceeded(void);
bool app_monitor_isVelocityExceeded(void);
bool app_monitor_isDisplacementExceeded(void);

/* Samples the SD queue refused during the current (or most recent) recording.
 *
 * Non-zero means the recorded file has holes. Nothing in the record itself can
 * reveal them -- samples carry no index and the timestamps stay monotonic
 * across a gap -- so this counter is the only way to know the file is
 * incomplete. Reset when a recording starts. */
uint32_t app_monitor_getDroppedSamples(void);
/**********************************************************************
 * End of File
 **********************************************************************/
#endif /* APP_MONITOR_H */
