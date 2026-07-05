#include <unity.h>

#include "protoemb.h"
#include "app_control.h"
#include "app_motion.h"
#include "app_notification.h"

/*
 * Compile-time assertions guard each cast site in the firmware:
 *   app_messageSlave.c  – (ProtoEmb_FaultedReason_E)app_control_getFault()
 *   app_messageSlave.c  – (ProtoEmb_RestrictedReason_E)app_control_getRestriction()
 *   app_notification.c  – (ProtoEmb_NotificationType_E)type
 *   app_messageSlave.c  – (uint8_t)src->g  [fillMove, G0-G4 only]
 *
 * Any drift between the firmware and protocol enums breaks the build here
 * before it can silently corrupt wire traffic.
 */

/* Fault codes -------------------------------------------------------- */
_Static_assert(APP_CONTROL_FAULT_NONE                      == PROTOEMB_FAULTEDREASON_NONE,                      "fault mismatch: NONE");
_Static_assert(APP_CONTROL_FAULT_COG                       == PROTOEMB_FAULTEDREASON_COG,                       "fault mismatch: COG");
_Static_assert(APP_CONTROL_FAULT_WATCHDOG                  == PROTOEMB_FAULTEDREASON_WATCHDOG,                  "fault mismatch: WATCHDOG");
_Static_assert(APP_CONTROL_FAULT_ESD_POWER                 == PROTOEMB_FAULTEDREASON_ESD_POWER,                 "fault mismatch: ESD_POWER");
_Static_assert(APP_CONTROL_FAULT_ESD_SWITCH                == PROTOEMB_FAULTEDREASON_ESD_SWITCH,                "fault mismatch: ESD_SWITCH");
_Static_assert(APP_CONTROL_FAULT_ESD_UPPER                 == PROTOEMB_FAULTEDREASON_ESD_UPPER,                 "fault mismatch: ESD_UPPER");
_Static_assert(APP_CONTROL_FAULT_ESD_LOWER                 == PROTOEMB_FAULTEDREASON_ESD_LOWER,                 "fault mismatch: ESD_LOWER");
_Static_assert(APP_CONTROL_FAULT_SERVO_COMMUNICATION       == PROTOEMB_FAULTEDREASON_SERVO_COMMUNICATION,       "fault mismatch: SERVO_COMMUNICATION");
_Static_assert(APP_CONTROL_FAULT_FORCE_GAUGE_COMMUNICATION == PROTOEMB_FAULTEDREASON_FORCE_GAUGE_COMMUNICATION, "fault mismatch: FORCE_GAUGE_COMMUNICATION");
_Static_assert(APP_CONTROL_FAULT_COUNT                     == PROTOEMB_FAULTEDREASON_COUNT,                     "fault mismatch: COUNT");

/* Restriction codes -------------------------------------------------- */
_Static_assert(APP_CONTROL_RESTRICTION_NONE            == PROTOEMB_RESTRICTEDREASON_NONE,            "restriction mismatch: NONE");
_Static_assert(APP_CONTROL_RESTRICTION_SAMPLE_LENGTH   == PROTOEMB_RESTRICTEDREASON_SAMPLE_LENGTH,   "restriction mismatch: SAMPLE_LENGTH");
_Static_assert(APP_CONTROL_RESTRICTION_SAMPLE_TENSION  == PROTOEMB_RESTRICTEDREASON_SAMPLE_TENSION,  "restriction mismatch: SAMPLE_TENSION");
_Static_assert(APP_CONTROL_RESTRICTION_MACHINE_TENSION == PROTOEMB_RESTRICTEDREASON_MACHINE_TENSION, "restriction mismatch: MACHINE_TENSION");
_Static_assert(APP_CONTROL_RESTRICTION_UPPER_ENDSTOP   == PROTOEMB_RESTRICTEDREASON_UPPER_ENDSTOP,   "restriction mismatch: UPPER_ENDSTOP");
_Static_assert(APP_CONTROL_RESTRICTION_LOWER_ENDSTOP   == PROTOEMB_RESTRICTEDREASON_LOWER_ENDSTOP,   "restriction mismatch: LOWER_ENDSTOP");
_Static_assert(APP_CONTROL_RESTRICTION_DOOR            == PROTOEMB_RESTRICTEDREASON_DOOR,            "restriction mismatch: DOOR");
_Static_assert(APP_CONTROL_RESTRICTION_COUNT           == PROTOEMB_RESTRICTEDREASON_COUNT,           "restriction mismatch: COUNT");

/* Notification types ------------------------------------------------- */
_Static_assert(APP_NOTIFICATION_TYPE_MESSAGE == PROTOEMB_NOTIFICATIONTYPE_MESSAGE, "notification type mismatch: MESSAGE");
_Static_assert(APP_NOTIFICATION_TYPE_INFO    == PROTOEMB_NOTIFICATIONTYPE_INFO,    "notification type mismatch: INFO");
_Static_assert(APP_NOTIFICATION_TYPE_WARNING == PROTOEMB_NOTIFICATIONTYPE_WARNING, "notification type mismatch: WARNING");
_Static_assert(APP_NOTIFICATION_TYPE_ERROR   == PROTOEMB_NOTIFICATIONTYPE_ERROR,   "notification type mismatch: ERROR");
_Static_assert(APP_NOTIFICATION_TYPE_SUCCESS == PROTOEMB_NOTIFICATIONTYPE_SUCCESS, "notification type mismatch: SUCCESS");
_Static_assert(APP_NOTIFICATION_TYPE_COUNT   == PROTOEMB_NOTIFICATIONTYPE_COUNT,   "notification type mismatch: COUNT");

/* G-code: fillMove does (uint8_t)src->g after ProtoEmb_Move_decode.
 * For GCode variants without remap (G0-G4), the C enum value == real G-code number,
 * so the cast is direct.
 * For remapped variants (G28/G90/G91), the C enum stores a compact index (5/6/7)
 * but ProtoEmb_Move_decode applies WIRE_TO_VALUE so the decoded .g field holds
 * the real G-code number (28/90/91). The runtime test below verifies this. */
_Static_assert(G0_RAPID_MOVE   == PROTOEMB_GCODE_RAPID_MOVE,  "gcode mismatch: G0");
_Static_assert(G1_LINEAR_MOVE  == PROTOEMB_GCODE_LINEAR_MOVE, "gcode mismatch: G1");
_Static_assert(G2_CW_ARC_MOVE  == PROTOEMB_GCODE_CW_ARC,      "gcode mismatch: G2");
_Static_assert(G3_CCW_ARC_MOVE == PROTOEMB_GCODE_CCW_ARC,     "gcode mismatch: G3");
_Static_assert(G4_DWELL        == PROTOEMB_GCODE_DWELL,        "gcode mismatch: G4");

/* -------------------------------------------------------------------- *
 * Runtime tests: same checks surfaced in the Unity test report.        *
 * -------------------------------------------------------------------- */

void test_enum_compat_fault_codes(void)
{
    TEST_ASSERT_EQUAL_INT(PROTOEMB_FAULTEDREASON_NONE,                      APP_CONTROL_FAULT_NONE);
    TEST_ASSERT_EQUAL_INT(PROTOEMB_FAULTEDREASON_COG,                       APP_CONTROL_FAULT_COG);
    TEST_ASSERT_EQUAL_INT(PROTOEMB_FAULTEDREASON_WATCHDOG,                  APP_CONTROL_FAULT_WATCHDOG);
    TEST_ASSERT_EQUAL_INT(PROTOEMB_FAULTEDREASON_ESD_POWER,                 APP_CONTROL_FAULT_ESD_POWER);
    TEST_ASSERT_EQUAL_INT(PROTOEMB_FAULTEDREASON_ESD_SWITCH,                APP_CONTROL_FAULT_ESD_SWITCH);
    TEST_ASSERT_EQUAL_INT(PROTOEMB_FAULTEDREASON_ESD_UPPER,                 APP_CONTROL_FAULT_ESD_UPPER);
    TEST_ASSERT_EQUAL_INT(PROTOEMB_FAULTEDREASON_ESD_LOWER,                 APP_CONTROL_FAULT_ESD_LOWER);
    TEST_ASSERT_EQUAL_INT(PROTOEMB_FAULTEDREASON_SERVO_COMMUNICATION,       APP_CONTROL_FAULT_SERVO_COMMUNICATION);
    TEST_ASSERT_EQUAL_INT(PROTOEMB_FAULTEDREASON_FORCE_GAUGE_COMMUNICATION, APP_CONTROL_FAULT_FORCE_GAUGE_COMMUNICATION);
    TEST_ASSERT_EQUAL_INT(PROTOEMB_FAULTEDREASON_COUNT,                     APP_CONTROL_FAULT_COUNT);
}

void test_enum_compat_restriction_codes(void)
{
    TEST_ASSERT_EQUAL_INT(PROTOEMB_RESTRICTEDREASON_NONE,            APP_CONTROL_RESTRICTION_NONE);
    TEST_ASSERT_EQUAL_INT(PROTOEMB_RESTRICTEDREASON_SAMPLE_LENGTH,   APP_CONTROL_RESTRICTION_SAMPLE_LENGTH);
    TEST_ASSERT_EQUAL_INT(PROTOEMB_RESTRICTEDREASON_SAMPLE_TENSION,  APP_CONTROL_RESTRICTION_SAMPLE_TENSION);
    TEST_ASSERT_EQUAL_INT(PROTOEMB_RESTRICTEDREASON_MACHINE_TENSION, APP_CONTROL_RESTRICTION_MACHINE_TENSION);
    TEST_ASSERT_EQUAL_INT(PROTOEMB_RESTRICTEDREASON_UPPER_ENDSTOP,   APP_CONTROL_RESTRICTION_UPPER_ENDSTOP);
    TEST_ASSERT_EQUAL_INT(PROTOEMB_RESTRICTEDREASON_LOWER_ENDSTOP,   APP_CONTROL_RESTRICTION_LOWER_ENDSTOP);
    TEST_ASSERT_EQUAL_INT(PROTOEMB_RESTRICTEDREASON_DOOR,            APP_CONTROL_RESTRICTION_DOOR);
    TEST_ASSERT_EQUAL_INT(PROTOEMB_RESTRICTEDREASON_COUNT,           APP_CONTROL_RESTRICTION_COUNT);
}

void test_enum_compat_notification_types(void)
{
    TEST_ASSERT_EQUAL_INT(PROTOEMB_NOTIFICATIONTYPE_MESSAGE, APP_NOTIFICATION_TYPE_MESSAGE);
    TEST_ASSERT_EQUAL_INT(PROTOEMB_NOTIFICATIONTYPE_INFO,    APP_NOTIFICATION_TYPE_INFO);
    TEST_ASSERT_EQUAL_INT(PROTOEMB_NOTIFICATIONTYPE_WARNING, APP_NOTIFICATION_TYPE_WARNING);
    TEST_ASSERT_EQUAL_INT(PROTOEMB_NOTIFICATIONTYPE_ERROR,   APP_NOTIFICATION_TYPE_ERROR);
    TEST_ASSERT_EQUAL_INT(PROTOEMB_NOTIFICATIONTYPE_SUCCESS, APP_NOTIFICATION_TYPE_SUCCESS);
    TEST_ASSERT_EQUAL_INT(PROTOEMB_NOTIFICATIONTYPE_COUNT,   APP_NOTIFICATION_TYPE_COUNT);
}

void test_enum_compat_gcode_proto_path(void)
{
    /* G0-G4: no remap, enum value == real G-code number */
    TEST_ASSERT_EQUAL_INT(PROTOEMB_GCODE_RAPID_MOVE,  G0_RAPID_MOVE);
    TEST_ASSERT_EQUAL_INT(PROTOEMB_GCODE_LINEAR_MOVE, G1_LINEAR_MOVE);
    TEST_ASSERT_EQUAL_INT(PROTOEMB_GCODE_CW_ARC,      G2_CW_ARC_MOVE);
    TEST_ASSERT_EQUAL_INT(PROTOEMB_GCODE_CCW_ARC,     G3_CCW_ARC_MOVE);
    TEST_ASSERT_EQUAL_INT(PROTOEMB_GCODE_DWELL,       G4_DWELL);
    /* G28/G90/G91/G122: the protocol enum value now equals the real G-code number
     * (the wire form uses a separate compact index via PROTOEMB_GCODE_WIRE_TO_VALUE,
     * but ProtoEmb_Move_decode resolves .g to the real value), so it must match the
     * firmware constant directly. NB: WIRE_TO_VALUE is sized PROTOEMB_GCODE_COUNT and
     * indexed by wire position — indexing it by the enum value (e.g. [28]) is OOB. */
    TEST_ASSERT_EQUAL_INT(PROTOEMB_GCODE_HOME,        G28_HOME);
    TEST_ASSERT_EQUAL_INT(PROTOEMB_GCODE_ABSOLUTE,    G90_ABSOLUTE);
    TEST_ASSERT_EQUAL_INT(PROTOEMB_GCODE_INCREMENTAL, G91_INCREMENTAL);
    TEST_ASSERT_EQUAL_INT(PROTOEMB_GCODE_STOP,        G122_STOP);
    /* The wire remap table is sized to the enum count (indexed by wire position). */
    TEST_ASSERT_EQUAL_INT(PROTOEMB_GCODE_COUNT,
                          (int)(sizeof(PROTOEMB_GCODE_WIRE_TO_VALUE) / sizeof(PROTOEMB_GCODE_WIRE_TO_VALUE[0])));
}
