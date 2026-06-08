#ifndef APP_TESTMANAGEMENT_H
#define APP_TESTMANAGEMENT_H
//
// Created by Riley McCarthy on 25/04/24.
// @brief Test session lifecycle: opens the gcode SD channel, feeds moves to
//        app_motion, ends the test on EOF / G122 / error / motion-disable.
//        Owns the testRunning bit.
//
/**********************************************************************
 * Includes
 **********************************************************************/
#include <stdbool.h>
#include <stdint.h>

#include "app_motion.h"
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
    APP_TESTMANAGEMENT_STATE_IDLE,
    APP_TESTMANAGEMENT_STATE_STARTING,
    APP_TESTMANAGEMENT_STATE_RUNNING,
    APP_TESTMANAGEMENT_STATE_ENDING,
    APP_TESTMANAGEMENT_STATE_COUNT,
} app_testManagement_state_E;

/**********************************************************************
 * Public Function Definitions
 **********************************************************************/
void app_testManagement_init(int lock);
void app_testManagement_run(void);

// True only while a test is actively executing moves. Read by app_control,
// app_monitor, app_messageSlave (telemetry).
bool app_testManagement_isRunning(void);

// True in any non-IDLE state (starting, running, ending). Used to gate manual
// moves and to wait for a clean state before launching a new test.
bool app_testManagement_isBusy(void);

// Requested by app_messageSlave (TestRun protocol message).
bool app_testManagement_triggerTestStart(const char *gcodeId);
bool app_testManagement_triggerTestEnd(void);

// Manual move gate. Rejects (returns false) while a test is starting,
// running, or ending. Otherwise forwards to app_motion_addMove.
bool app_testManagement_addManualMove(const app_motion_move_t *move);
/**********************************************************************
 * End of File
 **********************************************************************/
#endif /* APP_TESTMANAGEMENT_H */
