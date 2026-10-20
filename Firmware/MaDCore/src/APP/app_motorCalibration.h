#ifndef APP_MOTORCALIBRATION_H
#define APP_MOTORCALIBRATION_H
//
// Created by Riley McCarthy on 18/10/26.
// @brief Open-loop check of the drive/encoder pair before the servo loop is
//        trusted with it.
// @details Drives a fixed number of step pulses forward, lets the carriage
//          settle, reads how far the encoder moved, then does the same in
//          reverse. The servo loop is not involved, so the numbers are what
//          the hardware does, not what a loop closed on the encoder made of it.
//          This module reports RAW numbers (pulses out, counts back, per
//          direction); judging them against the machine profile is the host's
//          job. Gated by the normal motion rules: refused unless motion is
//          enabled, nothing else is moving and no end stop is made; abandoned
//          the moment motion is disabled, a fault appears, an end stop is
//          reached, the encoder overtravels its bound, or a leg overruns.
//
/**********************************************************************
 * Includes
 **********************************************************************/
#include <stdbool.h>
#include <stdint.h>
/**********************************************************************
 * Constants
 **********************************************************************/
/* Hard ceilings, whatever the host asks for. At the shipped 8192 steps/mm the
 * pulse cap is ~24 mm and the rate cap ~2.4 mm/s; on a coarser drive both are
 * proportionally more travel, which the encoder bound and the timeout cover. */
#define APP_MOTORCALIBRATION_MAX_PULSES 200000U
#define APP_MOTORCALIBRATION_MAX_FREQUENCY 20000U
/* How long the carriage is left to come to rest after each leg before the
 * encoder is read. A step/dir servo drive lags its pulse input. */
#define APP_MOTORCALIBRATION_SETTLE_MS 250U
/*********************************************************************
 * Macros
 **********************************************************************/
/**********************************************************************
 * Typedefs
 **********************************************************************/
/* Wire order: matches MotorCalibrationState in MaDProtocol.yaml. Append only. */
typedef enum
{
    APP_MOTORCALIBRATION_STATE_IDLE,
    APP_MOTORCALIBRATION_STATE_STARTING,
    APP_MOTORCALIBRATION_STATE_FORWARD,
    APP_MOTORCALIBRATION_STATE_REVERSE,
    APP_MOTORCALIBRATION_STATE_DONE,
    APP_MOTORCALIBRATION_STATE_REFUSED_MOTION_DISABLED,
    APP_MOTORCALIBRATION_STATE_REFUSED_BUSY,
    APP_MOTORCALIBRATION_STATE_REFUSED_AT_ENDSTOP,
    APP_MOTORCALIBRATION_STATE_ABORTED_MOTION_DISABLED,
    APP_MOTORCALIBRATION_STATE_ABORTED_FAULT,
    APP_MOTORCALIBRATION_STATE_ABORTED_ENDSTOP,
    APP_MOTORCALIBRATION_STATE_ABORTED_TIMEOUT,
    APP_MOTORCALIBRATION_STATE_ABORTED_OVERTRAVEL,
    APP_MOTORCALIBRATION_STATE_REFUSED_RESTRICTED,
    APP_MOTORCALIBRATION_STATE_ABORTED_RESTRICTED,
    APP_MOTORCALIBRATION_STATE_ABORTED_JOG,
    APP_MOTORCALIBRATION_STATE_COUNT,
} app_motorCalibration_state_E;

typedef struct
{
    uint32_t pulses;    /* step pulses per leg (each direction) */
    uint32_t frequency; /* pulses per second */
    uint32_t maxCounts; /* abandon a leg once the encoder has moved further than this */
} app_motorCalibration_request_S;

typedef struct
{
    app_motorCalibration_state_E state;
    int32_t pulsesForward;  /* pulses emitted, signed by commanded direction (+) */
    int32_t countsForward;  /* encoder change over the forward leg */
    int32_t pulsesReverse;  /* pulses emitted, signed by commanded direction (-) */
    int32_t countsReverse;  /* encoder change over the reverse leg */
} app_motorCalibration_result_S;
/**********************************************************************
 * Public Function Definitions
 **********************************************************************/
void app_motorCalibration_init(int lock);
/* CONTROL cog; ticked by app_motion_run after its own work (see the .c). */
void app_motorCalibration_run(void);
/* Any cog. False for a malformed request (zero or over-cap pulses/rate, no
 * encoder bound) or while a run is already in progress; otherwise the run is
 * staged, the result reads STARTING at once, and the gates are judged on the
 * next CONTROL tick (a refusal is reported in the result). */
bool app_motorCalibration_request(const app_motorCalibration_request_S *request);
/* True from an accepted request until the run ends. A test start is refused
 * while this holds, and so is a manual move that is not a jog (Home, a
 * dwell). A jog is still accepted: app_motion caps its speed, and the
 * calibration gives way to it (ABORTED_JOG). */
bool app_motorCalibration_isActive(void);
void app_motorCalibration_getResult(app_motorCalibration_result_S *result);
/**********************************************************************
 * End of File
 **********************************************************************/
#endif /* APP_MOTORCALIBRATION_H */
