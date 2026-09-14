#ifndef APP_MOTION_H
#define APP_MOTION_H
//
// Created by Riley McCarthy on 25/04/24.
// @brief Pure motion executor: pops moves from a queue and drives the stepper.
//        Knows nothing about manual vs test sources or the SD card.
//        See app_testManagement for the test session lifecycle.
//
/**********************************************************************
 * Includes
 **********************************************************************/
#include <stdbool.h>
#include <stdint.h>
/**********************************************************************
 * Constants
 **********************************************************************/
/* Actuator selection. 1 = closed-loop dev_servo (encoder = source of truth);
 * 0 = legacy open-loop dev_stepper (commanded step count). The MOTOR cog
 * (dev_cogManager_config.c) inits/runs the matching driver and paces its cog
 * accordingly, so this single switch swaps the whole motion path. A build may
 * predefine it (e.g. the native_test app_motion suite pins 0 to exercise the
 * actuator-agnostic motion logic against its dev_stepper mocks). */
#ifndef APP_MOTION_USE_SERVO
#define APP_MOTION_USE_SERVO 1
#endif

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
    G123_WAVEFORM = 123,
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

/* A G123 waveform, in the units it arrives in. One cycle is four segments in
 * phase order: hold at +A, traverse down, hold at -A, traverse up.
 *
 * Packed, like the record it sits in: these go to the SD card as raw bytes. */
typedef struct __attribute__((packed))
{
    int32_t amplitudeTenthUm; /* peak excursion from the centre, 0.1 um units  */
    uint32_t freqMicroHz;     /* WHOLE-cycle frequency, holds included         */
    uint32_t cycles;
    uint32_t dwellHighMs;     /* hold at the upper peak                        */
    uint32_t dwellLowMs;      /* hold at the lower peak                        */
    uint16_t skewPerMille;    /* share of the traversing time spent descending */
    uint8_t shape;            /* traverse profile: 0 sine, 1 triangle          */
} app_motion_waveform_t;

typedef struct __attribute__((packed))
{
    uint8_t g;  // Gcode command
    int32_t x;  // Position in um
    int32_t f;  // Feedrate in um/s
    uint32_t p; // ms to pause motion
    /* G123 only. A waveform does not fit a general move's position / feedrate /
     * pause slots, and smuggling it through them is how the shape bit came to
     * live in the top byte of the feedrate -- where it was then ignored
     * entirely, so every triangle ever run was a sine. It gets its own fields. */
    app_motion_waveform_t wave;
} app_motion_move_t;

/**********************************************************************
 * Public Function Definitions
 **********************************************************************/
void app_motion_init(int lock);
void app_motion_run(void);

// Push a move onto the queue. Returns false if the queue is full.
bool app_motion_addMove(const app_motion_move_t *move);

// Stop the in-flight move (if any) and empty the queue. Used by
// app_testManagement on test end.
void app_motion_abortAndClear(void);

// True when there is no queued or in-flight move (state WAITING + empty queue).
// Used by app_testManagement to drain the motion before completing a test.
bool app_motion_isIdle(void);

// Getters
int32_t app_motion_getSetpoint(void);
/* Where the trajectory says the machine should be RIGHT NOW, in nanometres --
 * as opposed to getSetpoint(), which is where the move ENDS. A recorded sample
 * carries this one: it is what the specimen was being asked for at that
 * instant, and comparing it against the measured position is the only way a
 * tracking error is visible in the data at all. */
int32_t app_motion_getCommandedPosition(void);
int32_t app_motion_getPosition(void);

/**********************************************************************
 * End of File
 **********************************************************************/
#endif /* APP_MOTION_H */
