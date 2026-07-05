//
// Created by Riley McCarthy on 25/04/24.
//
/*
Clarification and Detailing of Homing, Coordinates and Lengths:
Definitions
- Positive X Direction is from the upper jaw towards the lower jaw, that is in the downward direction.

- Machine Position (NEW) is the distance of the LOWER jaw grip lip relative to the UPPER jaw grip lip.
  Would be useful to display this position.   Note that, in order to protect the force gauge,
  the machine position can never be zero as the limit upper switches are located
  in a positive X position so as to prevent the jaws from colliding.

- Machine Coordinate is relative to the location of the upper jaw grip lip,
  that is the stationary upper jaw grip lip is located at X = 0 in Machine Coordinates.

- Home (NEW) is a button in the ?? section that when clicked by the user will initiate the homing sequence as follows;
    First the machine will move in the negative at a feed rate of 5?? mm*s-1 until the upper inner endstop is activated (opened)
    the machine will then move in a positive direction by 5?? mm at a feed rate of 5 ?? mm*s-1
    then stop and move in the negative direction at a slow feed rate of 0.1?? mm*s-1
    until the inner endstop is activated (opened),
    the machine will then move in the positive direction by the Home Standoff distance at a feed rate of  5?? mm*s-1 and stop.
    Finally a Test Zero "function" (same action when the currently labeled "Zero Length" button) will be called,
    causing the Machine and Test Positions to be equivalent until such time as the user jogs
    the machine and establishes a new Test Zero position (see below).

- Home Standoff is the distance moved in the positive X direction after the second (slow speed)
  negative X direction activation of the inner upper limit switch.
  This move is required to remove any backlash in the tensioning (positive X) direction (as well as to clear the switch of course!).
  Probably should be 5 mm and can be hard coded or set in the machine profile.

 - Home Offset is the distance from the upper jaw grip lip to the lower jaw grip lip AFTER all homing motion is completed.
 This value is MANUALLY MEASURED and ENTERED by the user via a NEW input field to be labeled "Home Offset" on the Settings?? page
 and is part of the Machine Profile??.
 After homing, the position in the Machine Coordinate is the Home Offset which is the sum of  the distance
 between the upper jaw grip lip and the lower jaw grip lip when the inner upper limit switch is activated
 during the second homing negative X move AND the Home Standoff distance.

- Test Coordinate is relative to the Test Zero position.
  It is possible for a position in the Test Coordinate to be negative.
  Test Profile moves are defined and test position values are recorded and displayed in Test Coordinates.

- Test Zero is an arbitrary user-established position set when the user clicks the
  "Test Zero" button (currently labeled "Zero Length") on the Status Page or by the homing sequence.
  Test Profile moves are defined relative to the "Test Zero" position.

- Test Position is the distance (in the positive direction) of the lower jaw grip lip relative to the Test Zero position
  and is currently displayed on the Status page in the "Position" field.
  Other than being renamed as "Test Position" on the display and in the file header, It remains as displayed and recorded.
  The Test Position may be positive or negative.

- Gauge Length is an arbitrary value equivalent to the Machine Position value when the user clicks
  the "Test Zero" (currently labeled "Zero Length") button.
  Currently, the user manually measures and enters the Gauge Length via the "Gauge Length" field and it is passed to the file header.
  Gauge Length may be equal to, less than or greater than the Sample Length.
  While manual measurement and entry of the Gauge Length is workable for now,
  there would be a useful gain in efficiency as well as elimination of the potential for user measurement and entry error
  if the value could be captured from the the Machine Position via a user clickable "Set" button
  beside the current "Gauge Length" value field similar to the Update buttons besides the Test Number and Date fields.

- Sample Length (NEW) is the measured distance between the grip lips of the upper and lower jaws
  when the machine is positioned so that there is zero tension but no slack in the sample
  (see procedure below to establish Sample Length).
  Once established this value could be manually entered by the user or auto captured
  in a NEW "Sample Length" field on the Status page.
  This value will be displayed in the Test Setup section on the Status page and will be passed to the file header.
  When measured/captured, the value of the Sample Length is the same value as the Machine Position.
  While manual measurement and entry of the Sample Length would be workable for now,
  there would be a useful gain in efficiency as well as elimination of the potential for user measurement
  and entry error if the value could be captured from the the Machine Position via a user clickable
  "Set" button beside the NEW "Sample Length" value field similar to the Update buttons
  beside the Test Number and Date fields.
  */
/**********************************************************************
 * Includes
 **********************************************************************/
#include "HAL_lock.h"
#include "HAL_time.h"
#include <string.h>
#include "app_gauge.h"
#include "app_monitor.h"
#include "app_motion.h"
#include "app_control.h"
#include "app_testManagement.h"
#include "app_notification.h"

#include "dev_cogManager.h"
#include "dev_nvram.h"
#include "IO_SDCard.h"
#include "dev_forceGauge.h"
#include "IO_positionFeedback.h"
#include "IO_Debug.h"
#include "emulation_helpers.h"
#include "lib_utility.h"
#include "lib_timer.h"

/**********************************************************************
 * Constants
 **********************************************************************/

/** After `testRunning` goes false, keep flushing samples before `IO_SDCard_close` (`lib_timer` / HAL ms). */
#define APP_MONITOR_STOP_LOGGING_TAIL_MS (100U)

/*********************************************************************
 * Macros
 **********************************************************************/

#define APP_MONITOR_LOCK_REQ() HAL_lock_try(app_monitor_data.lock)
#define APP_MONITOR_LOCK_REQ_BLOCK() while (APP_MONITOR_LOCK_REQ() == false) EMULATION_YIELD_LOCK();
#define APP_MONITOR_LOCK_REL() HAL_lock_release(app_monitor_data.lock)

/**********************************************************************
 * Typedefs
 **********************************************************************/

typedef struct
{
    int32_t force;
    uint32_t forceIndex;
    int32_t position; // um
    int32_t setpoint; // um
    uint32_t time;    // us
    bool testRunning;
    bool updatedIndex;
} app_monitor_inputData_t;

typedef struct
{
    bool setPositionFeedback;
    int32_t setPositionValue;
    bool setSampleProfile;
    app_monitor_sampleProfile_S sampleProfileValue;
} app_monitor_requestData_t;

typedef struct
{
    app_monitor_sample_t sample;
    int32_t force;
    int32_t position;
    bool forceExceeded;
    bool velocityExceeded;
    bool displacementExceeded;
} app_monitor_output_S;

typedef struct
{
    app_monitor_requestData_t request;
    app_monitor_inputData_t input;

    int lock;
    uint32_t startTime;
    lib_timer_S stopLoggingTail;
    app_monitor_loggingState_E loggingState;
    char testName[DEV_NVRAM_MAX_SAMPLE_PROFILE_NAME];

    app_monitor_sample_t sample;
    app_monitor_output_S out;
    app_monitor_sampleProfile_S sampleProfile;
    bool sampleProfileLoaded;

    /* Latch so each cog's stack-headroom warning is sent once, not every check. */
    bool stackWarned[DEV_COGMANAGER_CHANNEL_COUNT];
} app_monitor_data_t;

/**********************************************************************
 * Private Variable Definitions
 **********************************************************************/

static app_monitor_data_t app_monitor_data;

/**********************************************************************
 * Private Function Prototypes
 **********************************************************************/

/**********************************************************************
 * Private Function Definitions
 **********************************************************************/

void app_monitor_private_processInputs()
{
    app_monitor_data.input.force = app_gauge_getForce(APP_GAUGE_COORD_MACHINE);
    uint32_t newIndex = dev_forceGauge_getIndex(DEV_FORCEGAUGE_CHANNEL_MAIN);
    app_monitor_data.input.updatedIndex = (newIndex != app_monitor_data.input.forceIndex);
    app_monitor_data.input.forceIndex = newIndex;
    app_monitor_data.input.position = app_gauge_getPosition(APP_GAUGE_COORD_MACHINE);
    app_monitor_data.input.setpoint = app_motion_getSetpoint();
    app_monitor_data.input.time = HAL_time_getUs();
    app_monitor_data.input.testRunning = app_testManagement_isRunning();
}

void app_monitor_private_processRequests()
{
    APP_MONITOR_LOCK_REQ_BLOCK();
    if (app_monitor_data.request.setPositionFeedback)
    {
        IO_positionFeedback_setValue(IO_POSITION_FEEDBACK_CHANNEL_SERVO_FEEDBACK, app_monitor_data.request.setPositionValue);
        app_monitor_data.request.setPositionFeedback = false;
    }
    if (app_monitor_data.request.setSampleProfile)
    {
        memcpy(&app_monitor_data.sampleProfile, &app_monitor_data.request.sampleProfileValue, sizeof(app_monitor_sampleProfile_S));
        app_monitor_data.sampleProfileLoaded = true;
        app_monitor_data.request.setSampleProfile = false;
    }
    APP_MONITOR_LOCK_REL();
}

void app_monitor_private_processSample()
{
    /* Derive sample-frame values from the snapshot captured in processInputs so all four
     * fields in one row come from a single ADC/encoder read. Re-reading app_gauge here
     * would race processInputs and produce rows whose force/position don't match time. */
    const int32_t gaugeForce_mN = app_gauge_getGaugeForce_mN();
    const int32_t gaugeLength_um = app_gauge_getGaugeLength_um();
    app_monitor_data.sample.force = app_monitor_data.input.force - gaugeForce_mN;
    app_monitor_data.sample.position = app_monitor_data.input.position - gaugeLength_um;
    app_monitor_data.sample.time = app_monitor_data.input.time - app_monitor_data.startTime;
    app_monitor_data.sample.setpoint = app_monitor_data.input.setpoint - gaugeLength_um;
}

void app_monitor_private_setOutput(void)
{
    APP_MONITOR_LOCK_REQ_BLOCK();
    app_monitor_data.out.force = app_monitor_data.input.force;
    app_monitor_data.out.position = app_monitor_data.input.position;
    memcpy(&app_monitor_data.out.sample, &app_monitor_data.sample, sizeof(app_monitor_sample_t));
    
    // Check limits if sample profile is loaded
    if (app_monitor_data.sampleProfileLoaded)
    {
        uint32_t currentForceMN = (uint32_t)abs(app_monitor_data.sample.force);
        app_monitor_data.out.forceExceeded = (currentForceMN > app_monitor_data.sampleProfile.maxForce);

        // Velocity limit check - velocity checking would require derivative calculation
        // For now, set to false as velocity is not directly available in sample data
        app_monitor_data.out.velocityExceeded = false;

        // Displacement limit check (sample position is um, profile limit is mm)
        uint32_t currentDisplacement = (uint32_t)abs(app_monitor_data.sample.position);
        app_monitor_data.out.displacementExceeded =
            (currentDisplacement > LIB_UTILITY_MM_TO_UM(app_monitor_data.sampleProfile.maxDisplacement));
    }
    else
    {
        // No profile loaded, no limits exceeded
        app_monitor_data.out.forceExceeded = false;
        app_monitor_data.out.velocityExceeded = false;
        app_monitor_data.out.displacementExceeded = false;
    }
    
    APP_MONITOR_LOCK_REL();
}

void app_monitor_private_processLogging()
{
    app_monitor_loggingState_E currentState = app_monitor_data.loggingState;
    switch (currentState)
    {
    case APP_MONITOR_LOGGING_STATE_IDLE:
        if (app_monitor_data.input.testRunning)
        {
            if (IO_SDCard_open(IO_SDCARD_CHANNEL_SAMPLE_DATA, app_monitor_data.testName, IO_SDCARD_MODE_WRITE))
            {
                app_monitor_data.loggingState = APP_MONITOR_LOGGING_STATE_RUNNING;
                app_monitor_data.startTime = app_monitor_data.input.time;
            }
            else
            {
                DEBUG_INFO("%s", "Failed to start logging due to sample data header not existing\n");
            }
        }
        break;
    case APP_MONITOR_LOGGING_STATE_RUNNING:
        if (app_monitor_data.input.testRunning == false)
        {
            lib_timer_start(&app_monitor_data.stopLoggingTail);
            app_monitor_data.loggingState = APP_MONITOR_LOGGING_STATE_STOPPING;
        }
        else if (app_monitor_data.input.updatedIndex)
        {
            //DEBUG_ERROR("%s", "Logging sample data\n");
            IO_SDCard_push(IO_SDCARD_CHANNEL_SAMPLE_DATA, &app_monitor_data.sample, sizeof(app_monitor_sample_t));
        }
        break;
    case APP_MONITOR_LOGGING_STATE_STOPPING:
        if (app_monitor_data.input.updatedIndex)
        {
            IO_SDCard_push(IO_SDCARD_CHANNEL_SAMPLE_DATA, &app_monitor_data.sample, sizeof(app_monitor_sample_t));
        }

        if (lib_timer_expired(&app_monitor_data.stopLoggingTail))
        {
            lib_timer_stop(&app_monitor_data.stopLoggingTail);
            IO_SDCard_close(IO_SDCARD_CHANNEL_SAMPLE_DATA);
            app_monitor_data.loggingState = APP_MONITOR_LOGGING_STATE_IDLE;
        }
        break;
    default:
        break;
    }
}

/**********************************************************************
 * Public Function Definitions
 **********************************************************************/

/* Warn (once per cog) when a cog's stack high-water mark crosses this fraction
 * of its allocation — early notice before the canary-overrun cliff. */
#define APP_MONITOR_STACK_WARN_PCT (80U)
#define APP_MONITOR_STACK_CHECK_PERIOD_US (1000000U) /* 1 s; the latch makes rate non-critical */

/* Watch every cog's stack headroom and emit one WARNING notification the first
 * time a cog crosses the threshold. Runs on the MONITOR cog (low stack use), not
 * the stressed cog, so issuing the notification can't tip the cog it warns
 * about. Peaks come from dev_cogManager's sentinel-fill measurement. */
static void app_monitor_private_checkStacks(void)
{
    static uint32_t lastCheckUs = 0U;
    const uint32_t now = HAL_time_getUs();
    if ((now - lastCheckUs) < APP_MONITOR_STACK_CHECK_PERIOD_US)
    {
        return;
    }
    lastCheckUs = now;

    for (dev_cogManager_channel_E channel = (dev_cogManager_channel_E)0U; channel < DEV_COGMANAGER_CHANNEL_COUNT; channel++)
    {
        if (app_monitor_data.stackWarned[channel])
        {
            continue;
        }
        const uint32_t size = dev_cogManager_getStackSize(channel);
        const uint32_t peak = dev_cogManager_getStackPeak(channel);
        if ((size != 0U) && ((peak * 100U) >= (size * APP_MONITOR_STACK_WARN_PCT)))
        {
            app_monitor_data.stackWarned[channel] = true;
            app_notification_send(APP_NOTIFICATION_TYPE_WARNING,
                                  "%s cog stack %u%% (%u/%u B)",
                                  dev_cogManager_getName(channel),
                                  (peak * 100U) / size, peak, size);
        }
    }
}

void app_monitor_init(int lock)
{
    app_monitor_data.lock = lock;
    lib_timer_init(&app_monitor_data.stopLoggingTail, APP_MONITOR_STOP_LOGGING_TAIL_MS);
    lib_timer_stop(&app_monitor_data.stopLoggingTail);
    app_monitor_data.loggingState = APP_MONITOR_LOGGING_STATE_IDLE;
    app_monitor_data.sampleProfileLoaded = false;
    for (uint32_t i = 0U; i < DEV_COGMANAGER_CHANNEL_COUNT; i++)
    {
        app_monitor_data.stackWarned[i] = false;
    }
}

void app_monitor_run()
{
    app_monitor_private_processInputs();
    app_monitor_private_processRequests();
    app_monitor_private_processSample();
    app_monitor_private_processLogging();
    app_monitor_private_setOutput();
    app_monitor_private_checkStacks();
}

void app_monitor_zeroPosition()
{
    APP_MONITOR_LOCK_REQ_BLOCK();
    app_monitor_data.request.setPositionFeedback = true;
    app_monitor_data.request.setPositionValue = 0;
    APP_MONITOR_LOCK_REL();
}

void app_monitor_setPosition(int32_t positionUM)
{
    APP_MONITOR_LOCK_REQ_BLOCK();
    app_monitor_data.request.setPositionFeedback = true;
    app_monitor_data.request.setPositionValue = positionUM;
    APP_MONITOR_LOCK_REL();
}

void app_monitor_setTestName(const char *testName)
{
    APP_MONITOR_LOCK_REQ_BLOCK();
    strncpy(app_monitor_data.testName, testName, sizeof(app_monitor_data.testName) - 1);
    app_monitor_data.testName[sizeof(app_monitor_data.testName) - 1] = '\0';
    APP_MONITOR_LOCK_REL();
}

void app_monitor_getTestName(char *outName, uint32_t size)
{
    APP_MONITOR_LOCK_REQ_BLOCK();
    strncpy(outName, app_monitor_data.testName, size - 1);
    outName[size - 1] = '\0';
    APP_MONITOR_LOCK_REL();
}

bool app_monitor_setSampleProfile(app_monitor_sampleProfile_S *profile)
{
    if (profile == NULL)
    {
        return false;
    }
    
    APP_MONITOR_LOCK_REQ_BLOCK();
    memcpy(&app_monitor_data.request.sampleProfileValue, profile, sizeof(app_monitor_sampleProfile_S));
    app_monitor_data.request.setSampleProfile = true;
    APP_MONITOR_LOCK_REL();
    
    return true;
}

void app_monitor_getSampleProfile(app_monitor_sampleProfile_S *profile)
{
    if (profile == NULL)
    {
        return;
    }
    
    APP_MONITOR_LOCK_REQ_BLOCK();
    memcpy(profile, &app_monitor_data.sampleProfile, sizeof(app_monitor_sampleProfile_S));
    APP_MONITOR_LOCK_REL();
}

bool app_monitor_isSampleProfileLoaded(void)
{
    APP_MONITOR_LOCK_REQ_BLOCK();
    bool loaded = app_monitor_data.sampleProfileLoaded;
    APP_MONITOR_LOCK_REL();
    return loaded;
}

bool app_monitor_isForceExceeded(void)
{
    APP_MONITOR_LOCK_REQ_BLOCK();
    bool exceeded = app_monitor_data.out.forceExceeded;
    APP_MONITOR_LOCK_REL();
    return exceeded;
}

bool app_monitor_isVelocityExceeded(void)
{
    APP_MONITOR_LOCK_REQ_BLOCK();
    bool exceeded = app_monitor_data.out.velocityExceeded;
    APP_MONITOR_LOCK_REL();
    return exceeded;
}

bool app_monitor_isDisplacementExceeded(void)
{
    APP_MONITOR_LOCK_REQ_BLOCK();
    bool exceeded = app_monitor_data.out.displacementExceeded;
    APP_MONITOR_LOCK_REL();
    return exceeded;
}

/**********************************************************************
 * End of File
 **********************************************************************/
