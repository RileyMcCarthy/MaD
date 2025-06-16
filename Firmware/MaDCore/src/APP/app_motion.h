#ifndef APP_MOTION_H
#define APP_MOTION_H
//
// Created by Riley McCarthy on 25/04/24.
// @ this is a nested state machine, I think we dont actually need the main one
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
typedef enum
{
    APP_MOTION_DISABLED,
    APP_MOTION_WAITING,
    APP_MOTION_MOVING,
    APP_MOTION_COUNT,
} app_motion_state_E;

typedef enum
{
    G0_RAPID_MOVE = 0,
    G1_LINEAR_MOVE = 1,
    G2_CW_ARC_MOVE = 2,
    G3_CCW_ARC_MOVE = 3,
    G4_DWELL = 4,
    G28_HOME = 28,
    G90_ABSOLUTE = 90,
    G91_INCREMENTAL = 91,
    G122_STOP = 122,
} app_motion_gcode_E;

typedef enum
{
    APP_MOTION_HOME_START,
    APP_MOTION_HOME_MOVING,
    APP_MOTION_HOME_ENDSTOP,
    APP_MOTION_HOME_BACKOFF,
    APP_MOTION_HOME_COMPLETE,
    APP_MOTION_HOME_COUNT,
} app_motion_home_E;

typedef struct
{
    uint8_t g;  // Gcode command
    int32_t x;  // Position in um
    int32_t f;  // Feedrate in um/s
    uint32_t p; // ms to pause motion
} app_motion_move_t;

/**********************************************************************
 * Public Function Definitions
 **********************************************************************/
void app_motion_init(int lock);
void app_motion_run();

// Requests
bool app_motion_addTestMove(app_motion_move_t *move);
bool app_motion_addManualMove(app_motion_move_t *move);
void app_motion_clearMoveQueue(void);
void app_motion_zeroPosition(void);

// Getters
int32_t app_motion_getSetpoint(void);
int32_t app_motion_getPosition(void);

/**********************************************************************
 * End of File
 **********************************************************************/
#endif /* APP_MOTION_H */
