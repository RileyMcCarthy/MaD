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
#include <propeller2.h>
#include <string.h>
#include "app_monitor.h"
#include "app_motion.h"
#include "app_control.h"

#include "dev_nvram.h"
#include "IO_logger.h"
#include "dev_forceGauge.h"
#include "IO_positionFeedback.h"
#include "IO_Debug.h"

#include "lib_utility.h"
/**********************************************************************
 * Constants
 **********************************************************************/

/*********************************************************************
 * Macros
 **********************************************************************/

#define APP_MONITOR_LOCK_REQ() _locktry(app_monitor_data.lock)
#define APP_MONITOR_LOCK_REQ_BLOCK()        \
    while (APP_MONITOR_LOCK_REQ() == false) \
        ;
#define APP_MONITOR_LOCK_REL() _lockrel(app_monitor_data.lock)

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
    bool setGaugeLength;
    bool setGaugeForce;
    bool zeroPositionFeedback;
} app_monitor_requestData_t;

typedef struct
{
    app_monitor_sample_t sample;
    int32_t force;
    int32_t position;
    int32_t gaugeLength;
    int32_t gaugeForce;
} app_monitor_output_S;

typedef struct
{
    app_monitor_requestData_t request;
    app_monitor_inputData_t input;

    int lock;
    uint32_t gaugeLength;
    uint32_t gaugeForce;
    uint32_t startTime;
    app_monitor_loggingState_E loggingState;
    char testName[DEV_NVRAM_MAX_SAMPLE_PROFILE_NAME];

    app_monitor_sample_t sample;
    app_monitor_output_S out;
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
    app_monitor_data.input.force = dev_forceGauge_getForce(DEV_FORCEGAUGE_CHANNEL_MAIN);
    uint32_t newIndex = dev_forceGauge_getIndex(DEV_FORCEGAUGE_CHANNEL_MAIN);
    app_monitor_data.input.updatedIndex = (newIndex != app_monitor_data.input.forceIndex);
    app_monitor_data.input.forceIndex = newIndex;
    app_monitor_data.input.position = IO_positionFeedback_getValue(IO_POSITION_FEEDBACK_CHANNEL_SERVO_FEEDBACK);
    app_monitor_data.input.setpoint = app_motion_getSetpoint();
    app_monitor_data.input.time = _getus();
    app_monitor_data.input.testRunning = app_control_testRunning();
}

void app_monitor_private_processRequests()
{
    APP_MONITOR_LOCK_REQ_BLOCK();
    if (app_monitor_data.request.setGaugeLength)
    {
        app_monitor_data.gaugeLength = app_monitor_data.input.position;
        app_monitor_data.request.setGaugeLength = false;
    }
    if (app_monitor_data.request.setGaugeForce)
    {
        app_monitor_data.gaugeForce = app_monitor_data.input.force;
        app_monitor_data.request.setGaugeForce = false;
    }
    if (app_monitor_data.request.zeroPositionFeedback)
    {
        IO_positionFeedback_setValue(IO_POSITION_FEEDBACK_CHANNEL_SERVO_FEEDBACK, 0);
        app_monitor_data.request.zeroPositionFeedback = false;
    }
    APP_MONITOR_LOCK_REL();
}

void app_monitor_private_processSample()
{
    app_monitor_data.sample.force = app_monitor_data.input.force - app_monitor_data.gaugeForce;
    app_monitor_data.sample.position = app_monitor_data.input.position - app_monitor_data.gaugeLength;
    app_monitor_data.sample.time = app_monitor_data.input.time - app_monitor_data.startTime;
    app_monitor_data.sample.index = app_monitor_data.input.forceIndex;
    app_monitor_data.sample.setpoint = app_monitor_data.input.setpoint;
}

void app_monitor_private_setOutput(void)
{
    APP_MONITOR_LOCK_REQ_BLOCK();
    app_monitor_data.out.gaugeForce = app_monitor_data.gaugeForce;
    app_monitor_data.out.gaugeLength = app_monitor_data.gaugeLength;
    app_monitor_data.out.force = app_monitor_data.input.force;
    app_monitor_data.out.position = app_monitor_data.input.position;
    memcpy(&app_monitor_data.out.sample, &app_monitor_data.sample, sizeof(app_monitor_sample_t));
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
            if (IO_logger_open(IO_LOGGER_CHANNEL_SAMPLE_DATA, app_monitor_data.testName))
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
            app_monitor_data.loggingState = APP_MONITOR_LOGGING_STATE_STOPPING;
        }
        else if (app_monitor_data.input.updatedIndex)
        {
            //DEBUG_ERROR("%s", "Logging sample data\n");
            IO_logger_push(IO_LOGGER_CHANNEL_SAMPLE_DATA, &app_monitor_data.sample, sizeof(app_monitor_sample_t));
        }
        break;
    case APP_MONITOR_LOGGING_STATE_STOPPING:
        IO_logger_close(IO_LOGGER_CHANNEL_SAMPLE_DATA);
        app_monitor_data.loggingState = APP_MONITOR_LOGGING_STATE_IDLE;
        break;
    default:
        break;
    }
}

/**********************************************************************
 * Public Function Definitions
 **********************************************************************/

void app_monitor_init(int lock)
{
    app_monitor_data.lock = lock;
    app_monitor_data.gaugeLength = 0;
    app_monitor_data.loggingState = APP_MONITOR_LOGGING_STATE_IDLE;
}

void app_monitor_run()
{
    app_monitor_private_processInputs();
    app_monitor_private_processRequests();
    app_monitor_private_processSample();
    app_monitor_private_processLogging();
    app_monitor_private_setOutput();
}

void app_monitor_getSample(app_monitor_sample_t *sample)
{
    APP_MONITOR_LOCK_REQ_BLOCK();
    memcpy(sample, &app_monitor_data.out.sample, sizeof(app_monitor_sample_t));
    APP_MONITOR_LOCK_REL();
}

int32_t app_monitor_getSampleForce(void)
{
    APP_MONITOR_LOCK_REQ_BLOCK();
    int32_t force = app_monitor_data.out.sample.force;
    APP_MONITOR_LOCK_REL();
    return force;
}

int32_t app_monitor_getSamplePosition(void)
{
    APP_MONITOR_LOCK_REQ_BLOCK();
    int32_t position = app_monitor_data.out.sample.position;
    APP_MONITOR_LOCK_REL();
    return position;
}

int32_t app_monitor_getAbsoluteForce(void)
{
    APP_MONITOR_LOCK_REQ_BLOCK();
    int32_t force = app_monitor_data.out.force;
    APP_MONITOR_LOCK_REL();
    return force;
}

int32_t app_monitor_getAbsolutePosition(void)
{
    APP_MONITOR_LOCK_REQ_BLOCK();
    int32_t position = app_monitor_data.out.position;
    APP_MONITOR_LOCK_REL();
    return position;
}

int32_t app_monitor_getGaugeLength(void)
{
    APP_MONITOR_LOCK_REQ_BLOCK();
    int32_t gaugeLength = app_monitor_data.out.gaugeLength;
    APP_MONITOR_LOCK_REL();
    return gaugeLength;
}

void app_monitor_zeroGaugeLength()
{
    APP_MONITOR_LOCK_REQ_BLOCK();
    app_monitor_data.request.setGaugeLength = true;
    APP_MONITOR_LOCK_REL();
}

void app_monitor_zeroGaugeForce()
{
    APP_MONITOR_LOCK_REQ_BLOCK();
    app_monitor_data.request.setGaugeForce = true;
    APP_MONITOR_LOCK_REL();
}

void app_monitor_zeroPosition()
{
    APP_MONITOR_LOCK_REQ_BLOCK();
    app_monitor_data.request.zeroPositionFeedback = true;
    APP_MONITOR_LOCK_REL();
}

void app_monitor_setTestName(const char *testName)
{
    APP_MONITOR_LOCK_REQ_BLOCK();
    strncpy(app_monitor_data.testName, testName, sizeof(app_monitor_data.testName) - 1);
    app_monitor_data.testName[sizeof(app_monitor_data.testName) - 1] = '\0';
    APP_MONITOR_LOCK_REL();
}

/**********************************************************************
 * End of File
 **********************************************************************/
