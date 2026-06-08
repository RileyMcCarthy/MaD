//
// Created by Riley McCarthy on 25/04/24.
//
/**********************************************************************
 * Includes
 **********************************************************************/
#include <string.h>

#include "HAL_lock.h"

#include "app_testManagement.h"
#include "app_motion.h"
#include "app_control.h"
#include "app_notification.h"

#include "IO_SDCard.h"
#include "IO_Debug.h"

#include "emulation_helpers.h"
/**********************************************************************
 * Constants
 **********************************************************************/
#define APP_TESTMANAGEMENT_STAGED_BUFFER_SIZE 32U
#define APP_TESTMANAGEMENT_GCODE_ID_SIZE 7U
/*********************************************************************
 * Macros
 **********************************************************************/
#define APP_TESTMANAGEMENT_LOCK_REQ() HAL_lock_try(app_testManagement_data.lock)
#define APP_TESTMANAGEMENT_LOCK_REQ_BLOCK()        \
    while (APP_TESTMANAGEMENT_LOCK_REQ() == false) \
    {                                              \
        EMULATION_YIELD_LOCK();                    \
    }
#define APP_TESTMANAGEMENT_LOCK_REL() HAL_lock_release(app_testManagement_data.lock)
/**********************************************************************
 * Typedefs
 **********************************************************************/
typedef enum
{
    APP_TESTMANAGEMENT_END_NONE,
    APP_TESTMANAGEMENT_END_USER,
    APP_TESTMANAGEMENT_END_OPEN_FAILED,
    APP_TESTMANAGEMENT_END_COMPLETE,
    APP_TESTMANAGEMENT_END_MOTION_DISABLED,
} app_testManagement_endReason_E;

typedef struct
{
    bool motionEnabled;
    bool sdGcodeClosed;
    bool sdGcodeLastOpenFailed;
    bool sdGcodeReadDone;
} app_testManagement_inputs_t;

typedef struct
{
    bool triggerTestStart;
    bool triggerTestEnd;
    char pendingGcodeId[APP_TESTMANAGEMENT_GCODE_ID_SIZE];
} app_testManagement_request_t;

typedef struct
{
    bool isRunning;
    bool isBusy;
} app_testManagement_output_t;

typedef struct
{
    app_testManagement_inputs_t inputs;
    app_testManagement_request_t request;
    app_testManagement_output_t output;

    app_testManagement_state_E state;
    app_testManagement_endReason_E endReason;

    char gcodeId[APP_TESTMANAGEMENT_GCODE_ID_SIZE];
    bool openFailureHandled;

    app_motion_move_t stagedMoves[APP_TESTMANAGEMENT_STAGED_BUFFER_SIZE];
    uint32_t stagedCount;
    uint32_t stagedIndex;

    int lock;
} app_testManagement_data_t;
/**********************************************************************
 * Variable Definitions
 **********************************************************************/
static app_testManagement_data_t app_testManagement_data;
/**********************************************************************
 * Private Function Prototypes
 **********************************************************************/
static void app_testManagement_private_processInputs(void);
static void app_testManagement_private_processRequests(void);
static void app_testManagement_private_runState(void);
static void app_testManagement_private_processOutputs(void);
static void app_testManagement_private_enterEnding(app_testManagement_endReason_E reason);
static void app_testManagement_private_feedMotionQueue(void);
/**********************************************************************
 * Private Functions
 **********************************************************************/

static void app_testManagement_private_processInputs(void)
{
    app_testManagement_data.inputs.motionEnabled = app_control_motionEnabled();
    app_testManagement_data.inputs.sdGcodeClosed = IO_SDCard_isClosed(IO_SDCARD_CHANNEL_GCODE);
    app_testManagement_data.inputs.sdGcodeLastOpenFailed = IO_SDCard_lastOpenFailed(IO_SDCARD_CHANNEL_GCODE);
    app_testManagement_data.inputs.sdGcodeReadDone = IO_SDCard_isReadDone(IO_SDCARD_CHANNEL_GCODE);
}

static void app_testManagement_private_processRequests(void)
{
    APP_TESTMANAGEMENT_LOCK_REQ_BLOCK();
    if (app_testManagement_data.request.triggerTestStart &&
        (app_testManagement_data.state == APP_TESTMANAGEMENT_STATE_IDLE) &&
        app_testManagement_data.inputs.motionEnabled)
    {
        memcpy(app_testManagement_data.gcodeId,
               app_testManagement_data.request.pendingGcodeId,
               sizeof(app_testManagement_data.gcodeId));
        app_testManagement_data.openFailureHandled = false;
        app_testManagement_data.stagedCount = 0U;
        app_testManagement_data.stagedIndex = 0U;
        IO_SDCard_clearLastOpenFailed(IO_SDCARD_CHANNEL_GCODE);
        app_testManagement_data.state = APP_TESTMANAGEMENT_STATE_STARTING;
    }
    app_testManagement_data.request.triggerTestStart = false;

    /* triggerTestEnd is consumed by the state machine to allow it to drive
     * the ENDING transition; clear here so it's edge-triggered. */
    APP_TESTMANAGEMENT_LOCK_REL();
}

static void app_testManagement_private_enterEnding(app_testManagement_endReason_E reason)
{
    app_testManagement_data.endReason = reason;
    switch (reason)
    {
    case APP_TESTMANAGEMENT_END_COMPLETE:
        app_notification_send(APP_NOTIFICATION_TYPE_INFO, "%s", "Test Complete!");
        break;
    case APP_TESTMANAGEMENT_END_MOTION_DISABLED:
        app_notification_send(APP_NOTIFICATION_TYPE_WARNING, "%s", "Test aborted: motion disabled");
        break;
    case APP_TESTMANAGEMENT_END_OPEN_FAILED:
    case APP_TESTMANAGEMENT_END_USER:
    case APP_TESTMANAGEMENT_END_NONE:
    default:
        break;
    }
    app_motion_abortAndClear();
    IO_SDCard_close(IO_SDCARD_CHANNEL_GCODE);
    app_testManagement_data.stagedCount = 0U;
    app_testManagement_data.stagedIndex = 0U;
    app_testManagement_data.state = APP_TESTMANAGEMENT_STATE_ENDING;
}

static void app_testManagement_private_feedMotionQueue(void)
{
    /* Drain anything still in the staged buffer before reading more from SD. */
    while (app_testManagement_data.stagedIndex < app_testManagement_data.stagedCount)
    {
        const app_motion_move_t *move =
            &app_testManagement_data.stagedMoves[app_testManagement_data.stagedIndex];

        if (move->g == G122_STOP)
        {
            app_testManagement_data.stagedIndex++;
            app_testManagement_private_enterEnding(APP_TESTMANAGEMENT_END_COMPLETE);
            return;
        }

        if (app_motion_addMove(move) == false)
        {
            /* motion queue full — retry next tick */
            return;
        }
        app_testManagement_data.stagedIndex++;
    }

    /* Staged buffer empty: refill in bulk from IO_SDCard queue. */
    app_testManagement_data.stagedIndex = 0U;
    app_testManagement_data.stagedCount = IO_SDCard_popMultiple(
        IO_SDCARD_CHANNEL_GCODE,
        app_testManagement_data.stagedMoves,
        APP_TESTMANAGEMENT_STAGED_BUFFER_SIZE);

    if (app_testManagement_data.stagedCount == 0U)
    {
        if (app_testManagement_data.inputs.sdGcodeReadDone)
        {
            DEBUG_INFO("%s", "GCODE: reader done, ending test\n");
            app_testManagement_private_enterEnding(APP_TESTMANAGEMENT_END_COMPLETE);
        }
    }
}

static void app_testManagement_private_runState(void)
{
    /* triggerTestEnd applies in STARTING and RUNNING; sample then clear under lock. */
    APP_TESTMANAGEMENT_LOCK_REQ_BLOCK();
    const bool endRequested = app_testManagement_data.request.triggerTestEnd;
    app_testManagement_data.request.triggerTestEnd = false;
    APP_TESTMANAGEMENT_LOCK_REL();

    switch (app_testManagement_data.state)
    {
    case APP_TESTMANAGEMENT_STATE_IDLE:
        break;

    case APP_TESTMANAGEMENT_STATE_STARTING:
        if (endRequested)
        {
            app_testManagement_private_enterEnding(APP_TESTMANAGEMENT_END_USER);
        }
        else if (app_testManagement_data.inputs.motionEnabled == false)
        {
            app_testManagement_private_enterEnding(APP_TESTMANAGEMENT_END_MOTION_DISABLED);
        }
        else if (app_testManagement_data.inputs.sdGcodeClosed)
        {
            if (app_testManagement_data.inputs.sdGcodeLastOpenFailed)
            {
                if (app_testManagement_data.openFailureHandled == false)
                {
                    app_testManagement_data.openFailureHandled = true;
                    app_notification_send(APP_NOTIFICATION_TYPE_ERROR,
                                          "Failed to open test gcode '%s'",
                                          app_testManagement_data.gcodeId);
                    app_testManagement_private_enterEnding(APP_TESTMANAGEMENT_END_OPEN_FAILED);
                }
            }
            else
            {
                /* Retry open until it transitions to a non-closed state or fails. */
                IO_SDCard_open(IO_SDCARD_CHANNEL_GCODE,
                               app_testManagement_data.gcodeId,
                               IO_SDCARD_MODE_READ);
            }
        }
        else
        {
            /* File is open. Start feeding moves. */
            app_testManagement_data.state = APP_TESTMANAGEMENT_STATE_RUNNING;
        }
        break;

    case APP_TESTMANAGEMENT_STATE_RUNNING:
        if (endRequested)
        {
            app_testManagement_private_enterEnding(APP_TESTMANAGEMENT_END_USER);
        }
        else if (app_testManagement_data.inputs.motionEnabled == false)
        {
            app_testManagement_private_enterEnding(APP_TESTMANAGEMENT_END_MOTION_DISABLED);
        }
        else
        {
            app_testManagement_private_feedMotionQueue();
        }
        break;

    case APP_TESTMANAGEMENT_STATE_ENDING:
        if (app_testManagement_data.inputs.sdGcodeClosed)
        {
            app_testManagement_data.state = APP_TESTMANAGEMENT_STATE_IDLE;
            app_testManagement_data.endReason = APP_TESTMANAGEMENT_END_NONE;
        }
        break;

    case APP_TESTMANAGEMENT_STATE_COUNT:
    default:
        break;
    }
}

static void app_testManagement_private_processOutputs(void)
{
    APP_TESTMANAGEMENT_LOCK_REQ_BLOCK();
    app_testManagement_data.output.isRunning =
        (app_testManagement_data.state == APP_TESTMANAGEMENT_STATE_RUNNING);
    app_testManagement_data.output.isBusy =
        (app_testManagement_data.state != APP_TESTMANAGEMENT_STATE_IDLE) ||
        app_testManagement_data.request.triggerTestStart ||
        app_testManagement_data.request.triggerTestEnd;
    APP_TESTMANAGEMENT_LOCK_REL();
}

/**********************************************************************
 * Function Definitions
 **********************************************************************/

void app_testManagement_init(int lock)
{
    memset(&app_testManagement_data, 0, sizeof(app_testManagement_data));
    app_testManagement_data.lock = lock;
    app_testManagement_data.state = APP_TESTMANAGEMENT_STATE_IDLE;
}

void app_testManagement_run(void)
{
    app_testManagement_private_processInputs();
    app_testManagement_private_processRequests();
    app_testManagement_private_runState();
    app_testManagement_private_processOutputs();
}

bool app_testManagement_isRunning(void)
{
    APP_TESTMANAGEMENT_LOCK_REQ_BLOCK();
    const bool isRunning = app_testManagement_data.output.isRunning;
    APP_TESTMANAGEMENT_LOCK_REL();
    return isRunning;
}

bool app_testManagement_isBusy(void)
{
    APP_TESTMANAGEMENT_LOCK_REQ_BLOCK();
    const bool isBusy =
        (app_testManagement_data.state != APP_TESTMANAGEMENT_STATE_IDLE) ||
        app_testManagement_data.request.triggerTestStart ||
        app_testManagement_data.request.triggerTestEnd;
    APP_TESTMANAGEMENT_LOCK_REL();
    return isBusy;
}

bool app_testManagement_triggerTestStart(const char *gcodeId)
{
    if (gcodeId == NULL)
    {
        return false;
    }
    if (app_control_motionEnabled() == false)
    {
        return false;
    }
    APP_TESTMANAGEMENT_LOCK_REQ_BLOCK();
    const bool isBusy =
        (app_testManagement_data.state != APP_TESTMANAGEMENT_STATE_IDLE) ||
        app_testManagement_data.request.triggerTestStart ||
        app_testManagement_data.request.triggerTestEnd;
    if (isBusy == false)
    {
        strncpy(app_testManagement_data.request.pendingGcodeId, gcodeId,
                sizeof(app_testManagement_data.request.pendingGcodeId) - 1U);
        app_testManagement_data.request.pendingGcodeId[
            sizeof(app_testManagement_data.request.pendingGcodeId) - 1U] = '\0';
        app_testManagement_data.request.triggerTestStart = true;
    }
    APP_TESTMANAGEMENT_LOCK_REL();
    return (isBusy == false);
}

bool app_testManagement_triggerTestEnd(void)
{
    APP_TESTMANAGEMENT_LOCK_REQ_BLOCK();
    app_testManagement_data.request.triggerTestEnd = true;
    APP_TESTMANAGEMENT_LOCK_REL();
    return true;
}

bool app_testManagement_addManualMove(const app_motion_move_t *move)
{
    if (move == NULL)
    {
        return false;
    }

    APP_TESTMANAGEMENT_LOCK_REQ_BLOCK();
    const bool isBusy =
        (app_testManagement_data.state != APP_TESTMANAGEMENT_STATE_IDLE) ||
        app_testManagement_data.request.triggerTestStart ||
        app_testManagement_data.request.triggerTestEnd;
    const bool moveAccepted = (isBusy == false) ? app_motion_addMove(move) : false;
    APP_TESTMANAGEMENT_LOCK_REL();

    return moveAccepted;
}

/**********************************************************************
 * End of File
 **********************************************************************/
