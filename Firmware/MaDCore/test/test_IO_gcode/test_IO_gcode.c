#include <unity.h>
#include <stdint.h>
#include <string.h>
#include "vibes_behaviour.h"

/* Module under test, pulled in by source so we exercise the real C.
 * IO_gcode.c only depends on app_motion.h (for the move struct) and the
 * DEBUG_* macros from IO_Debug.h; it calls no peer-module functions. */
#include "../../src/IO/IO_gcode.c"

/* IO_gcode emits DEBUG_INFO (ENABLE_DEBUG_SERIAL=1 in native_test), which
 * acquires this lock via the mock HAL. Created fresh in setUp(). */
extern int _stdio_debug_lock; /* shared in mock_propeller2.c */

extern void HAL_lock_mock_reset(void);

void setUp(void)
{
    HAL_lock_mock_reset();
    _stdio_debug_lock = HAL_lock_create();
}

void tearDown(void) {}

/* ----------------------------------------------------------------------
 * IO_gcode_decodeMove
 * -------------------------------------------------------------------- */

/* NULL gcode pointer is rejected without touching anything. */
void test_decodeMove_nullGcode_returnsFalse(void)
{
    VIBES_BEHAVIOUR("fw-gcode.missing-command-refused",
                    "src/IO/IO_gcode.c#IO_gcode_decodeMove",
                    "no command text at all",
                    "a missing command is refused");
    app_motion_move_t move;
    TEST_ASSERT_FALSE(IO_gcode_decodeMove(NULL, &move));
}

/* NULL move pointer is rejected. */
void test_decodeMove_nullMove_returnsFalse(void)
{
    /* undeclared: same claim as fw-gcode.missing-command-refused */
    TEST_ASSERT_FALSE(IO_gcode_decodeMove("G1 X1.0", NULL));
}

/* A full command parses every field and applies the mm->um (x1000) scale. */
void test_decodeMove_fullCommand_parsesAndScales(void)
{
    VIBES_BEHAVIOUR_WHY("fw-gcode.millimetres-become-micrometres",
                        "src/IO/IO_gcode.c#IO_gcode_decodeMove",
                        "a linear move of 10.5 millimetres at 2 millimetres per second, with a 100 millisecond pause",
                        "a linear move of 10.5 millimetres becomes 10500 micrometres of travel at 2000 micrometres per second, with a 100 millisecond pause",
                        "motion runs in micrometres; a millimetre left unscaled would be a thousand times too small");
    app_motion_move_t move;
    TEST_ASSERT_TRUE(IO_gcode_decodeMove("G1 X10.5 F2.0 P100", &move));
    TEST_ASSERT_EQUAL_UINT8(1, move.g);
    TEST_ASSERT_EQUAL_INT32(10500, move.x); /* 10.5 mm  -> 10500 um   */
    TEST_ASSERT_EQUAL_INT32(2000, move.f);  /* 2.0 mm/s -> 2000 um/s  */
    TEST_ASSERT_EQUAL_UINT32(100, move.p);
}

/* Fields that are absent default to zero (struct is reset at the top). */
void test_decodeMove_missingFields_defaultToZero(void)
{
    VIBES_BEHAVIOUR("fw-gcode.omitted-fields-are-zero",
                    "src/IO/IO_gcode.c#IO_gcode_decodeMove",
                    "a home command with no position, speed, or pause",
                    "a home command with no position, speed, or pause is stored as home, with position, speed, and pause at zero");
    app_motion_move_t move;
    TEST_ASSERT_TRUE(IO_gcode_decodeMove("G28", &move));
    TEST_ASSERT_EQUAL_UINT8(28, move.g);
    TEST_ASSERT_EQUAL_INT32(0, move.x);
    TEST_ASSERT_EQUAL_INT32(0, move.f);
    TEST_ASSERT_EQUAL_UINT32(0, move.p);
}

/* Pre-dirtied move is fully reinitialised even for fields not present in
 * the command (guards against stale data leaking through). */
void test_decodeMove_resetsDirtyStruct(void)
{
    VIBES_BEHAVIOUR_WHY("fw-gcode.leftover-fields-discarded",
                        "src/IO/IO_gcode.c#IO_gcode_decodeMove",
                        "a command that names only a new target position, after leftover command, position, speed, and pause from a previous line",
                        "a command that names only a new target position discards leftover command, speed, and pause from a previous line, and stores the new position",
                        "leftover values from a previous line would send the crosshead to the wrong place or at the wrong speed");
    app_motion_move_t move;
    move.g = 99;
    move.x = 123456;
    move.f = 654321;
    move.p = 777;

    TEST_ASSERT_TRUE(IO_gcode_decodeMove("X1.0", &move));
    TEST_ASSERT_EQUAL_UINT8(0, move.g); /* no G token -> reset to 0   */
    TEST_ASSERT_EQUAL_INT32(1000, move.x);
    TEST_ASSERT_EQUAL_INT32(0, move.f); /* no F token -> reset to 0   */
    TEST_ASSERT_EQUAL_UINT32(0, move.p);
}

/* Negative position scales and keeps sign. */
void test_decodeMove_negativePosition(void)
{
    VIBES_BEHAVIOUR("fw-gcode.negative-position-keeps-sign",
                    "src/IO/IO_gcode.c#IO_gcode_decodeMove",
                    "a linear move to minus 2.5 millimetres",
                    "a linear move of minus 2.5 millimetres is stored as minus 2500 micrometres");
    app_motion_move_t move;
    TEST_ASSERT_TRUE(IO_gcode_decodeMove("G1 X-2.5", &move));
    TEST_ASSERT_EQUAL_UINT8(1, move.g);
    TEST_ASSERT_EQUAL_INT32(-2500, move.x);
}

/* The (int32_t) cast truncates toward zero rather than rounding. */
void test_decodeMove_truncatesTowardZero(void)
{
    VIBES_BEHAVIOUR("fw-gcode.micrometre-truncates-toward-zero",
                    "src/IO/IO_gcode.c#IO_gcode_decodeMove",
                    "a target position of 5.789 millimetres",
                    "a target position of 5.789 millimetres is stored as 5789 micrometres, dropping any leftover fraction of a micrometre toward zero");
    app_motion_move_t move;
    /* 5.789 mm -> 5789 um exactly enough to land on 5789 after truncation. */
    TEST_ASSERT_TRUE(IO_gcode_decodeMove("X5.789", &move));
    TEST_ASSERT_EQUAL_INT32(5789, move.x);
}

/* Unknown/unsupported tokens (M-codes, axes we don't model) are ignored,
 * but recognised tokens around them still parse. */
void test_decodeMove_unknownTokensIgnored(void)
{
    VIBES_BEHAVIOUR("fw-gcode.unsupported-words-ignored",
                    "src/IO/IO_gcode.c#IO_gcode_decodeMove",
                    "a rapid move to 1 millimetre mixed with unsupported extra-axis words",
                    "a rapid move to 1 millimetre mixed with unsupported extra-axis words is stored as a rapid move to 1 millimetre, with speed and pause at zero");
    app_motion_move_t move;
    TEST_ASSERT_TRUE(IO_gcode_decodeMove("M3 Y5.0 Z2 G0 X1.0", &move));
    TEST_ASSERT_EQUAL_UINT8(0, move.g);
    TEST_ASSERT_EQUAL_INT32(1000, move.x);
    TEST_ASSERT_EQUAL_INT32(0, move.f);
    TEST_ASSERT_EQUAL_UINT32(0, move.p);
}

/* Multi-digit G codes parse fully (e.g. G122 stop). */
void test_decodeMove_multiDigitGcode(void)
{
    VIBES_BEHAVIOUR("fw-gcode.multi-digit-stop-command",
                    "src/IO/IO_gcode.c#IO_gcode_decodeMove",
                    "a stop command whose number has more than one digit",
                    "a stop command whose number has more than one digit is stored as stop");
    app_motion_move_t move;
    TEST_ASSERT_TRUE(IO_gcode_decodeMove("G122", &move));
    TEST_ASSERT_EQUAL_UINT8(122, move.g);
}

/* When a token repeats, the last occurrence wins (sequential strtok parse). */
void test_decodeMove_repeatedTokenLastWins(void)
{
    VIBES_BEHAVIOUR_WHY("fw-gcode.repeated-position-last-wins",
                        "src/IO/IO_gcode.c#IO_gcode_decodeMove",
                        "a command that names two target positions",
                        "a command that names two target positions keeps the last position named",
                        "later words on the same line are the author's last word on the target");
    app_motion_move_t move;
    TEST_ASSERT_TRUE(IO_gcode_decodeMove("X1.0 X2.0", &move));
    TEST_ASSERT_EQUAL_INT32(2000, move.x);
}

/* A token whose value fails to parse (no numeric body) leaves that field at
 * its default and does not abort the rest of the parse. */
void test_decodeMove_unparsableValueLeavesDefault(void)
{
    VIBES_BEHAVIOUR("fw-gcode.position-without-number-stays-zero",
                    "src/IO/IO_gcode.c#IO_gcode_decodeMove",
                    "a linear move that names a speed and a position with no number",
                    "a linear move that names a speed and a position with no number stores the linear command and the speed, and leaves the position at zero");
    app_motion_move_t move;
    /* "X" has no number after it -> sscanf fails -> x stays 0; G1 still set. */
    TEST_ASSERT_TRUE(IO_gcode_decodeMove("G1 X F3.0", &move));
    TEST_ASSERT_EQUAL_UINT8(1, move.g);
    TEST_ASSERT_EQUAL_INT32(0, move.x);
    TEST_ASSERT_EQUAL_INT32(3000, move.f);
}

/* Empty string: no tokens, everything stays at default, still succeeds. */
void test_decodeMove_emptyString(void)
{
    VIBES_BEHAVIOUR("fw-gcode.empty-line-is-all-zero",
                    "src/IO/IO_gcode.c#IO_gcode_decodeMove",
                    "an empty command line, after leftover command, position, speed, and pause",
                    "an empty command line is accepted as no command, no position, no speed, and no pause");
    app_motion_move_t move;
    move.g = 5;
    move.x = 5;
    move.f = 5;
    move.p = 5;
    TEST_ASSERT_TRUE(IO_gcode_decodeMove("", &move));
    TEST_ASSERT_EQUAL_UINT8(0, move.g);
    TEST_ASSERT_EQUAL_INT32(0, move.x);
    TEST_ASSERT_EQUAL_INT32(0, move.f);
    TEST_ASSERT_EQUAL_UINT32(0, move.p);
}

/* G-code value wider than uint8 is truncated by the (uint8_t) cast. */
void test_decodeMove_gcodeCastTruncatesToUint8(void)
{
    VIBES_BEHAVIOUR_WHY("fw-gcode.command-number-wraps-at-256",
                        "src/IO/IO_gcode.c#IO_gcode_decodeMove",
                        "command numbers 256 and 257",
                        "a command number of 256 is taken as a rapid move, and a command number of 257 as a linear move",
                        "command numbers are stored in one byte, so 256 and 257 wrap onto the rapid and linear commands");
    app_motion_move_t move;
    /* 256 -> (uint8_t)256 == 0 */
    TEST_ASSERT_TRUE(IO_gcode_decodeMove("G256", &move));
    TEST_ASSERT_EQUAL_UINT8(0, move.g);
    /* 257 -> (uint8_t)257 == 1 */
    TEST_ASSERT_TRUE(IO_gcode_decodeMove("G257", &move));
    TEST_ASSERT_EQUAL_UINT8(1, move.g);
}

/* Large dwell time fits the uint32 P field. */
void test_decodeMove_largePauseValue(void)
{
    VIBES_BEHAVIOUR_WHY("fw-gcode.pause-kept-in-milliseconds",
                        "src/IO/IO_gcode.c#IO_gcode_decodeMove",
                        "a pause of 5000 milliseconds",
                        "a pause of 5000 milliseconds is stored as 5000 milliseconds, with no unit conversion",
                        "the firmware sleeps for the pause duration as written in milliseconds");
    app_motion_move_t move;
    TEST_ASSERT_TRUE(IO_gcode_decodeMove("G4 P5000", &move));
    TEST_ASSERT_EQUAL_UINT8(4, move.g);
    TEST_ASSERT_EQUAL_UINT32(5000, move.p);
}

/* ----------------------------------------------------------------------
 * IO_gcode_isEndTest
 * -------------------------------------------------------------------- */

void test_isEndTest_exactMatch(void)
{
    VIBES_BEHAVIOUR("fw-gcode.end-test-command",
                    "src/IO/IO_gcode.c#IO_gcode_isEndTest",
                    "the end-of-test command",
                    "the end-of-test command is recognised as the end of a test");
    TEST_ASSERT_TRUE(IO_gcode_isEndTest("G144"));
}

void test_isEndTest_null(void)
{
    VIBES_BEHAVIOUR("fw-gcode.missing-line-is-not-end-test",
                    "src/IO/IO_gcode.c#IO_gcode_isEndTest",
                    "a missing command line",
                    "a missing command line is left unrecognised as the end of a test");
    TEST_ASSERT_FALSE(IO_gcode_isEndTest(NULL));
}

void test_isEndTest_nonMatching(void)
{
    VIBES_BEHAVIOUR("fw-gcode.nearby-commands-are-not-end-test",
                    "src/IO/IO_gcode.c#IO_gcode_isEndTest",
                    "a nearby command, a linear move, an empty line, and a lowercase end-of-test command",
                    "a nearby command, a linear move, an empty line, and a lowercase end-of-test command are each left unrecognised as the end of a test");
    TEST_ASSERT_FALSE(IO_gcode_isEndTest("G143"));
    TEST_ASSERT_FALSE(IO_gcode_isEndTest("G1"));
    TEST_ASSERT_FALSE(IO_gcode_isEndTest(""));
    TEST_ASSERT_FALSE(IO_gcode_isEndTest("g144")); /* case-sensitive */
}

/* Exact strcmp: trailing whitespace or extra args is NOT the end command. */
void test_isEndTest_requiresExactString(void)
{
    VIBES_BEHAVIOUR_WHY("fw-gcode.end-test-requires-exact-line",
                        "src/IO/IO_gcode.c#IO_gcode_isEndTest",
                        "the end-of-test command with a leading space, a trailing space, or an extra digit",
                        "the end-of-test command with a leading space, a trailing space, or an extra digit is left unrecognised as the end of a test",
                        "the end of a test is the exact command line; extra spaces or digits mean the line is something else");
    TEST_ASSERT_FALSE(IO_gcode_isEndTest("G144 "));
    TEST_ASSERT_FALSE(IO_gcode_isEndTest("G1440"));
    TEST_ASSERT_FALSE(IO_gcode_isEndTest(" G144"));
}

int main(void)
{
    UNITY_BEGIN();
    RUN_TEST(test_decodeMove_nullGcode_returnsFalse);
    RUN_TEST(test_decodeMove_nullMove_returnsFalse);
    RUN_TEST(test_decodeMove_fullCommand_parsesAndScales);
    RUN_TEST(test_decodeMove_missingFields_defaultToZero);
    RUN_TEST(test_decodeMove_resetsDirtyStruct);
    RUN_TEST(test_decodeMove_negativePosition);
    RUN_TEST(test_decodeMove_truncatesTowardZero);
    RUN_TEST(test_decodeMove_unknownTokensIgnored);
    RUN_TEST(test_decodeMove_multiDigitGcode);
    RUN_TEST(test_decodeMove_repeatedTokenLastWins);
    RUN_TEST(test_decodeMove_unparsableValueLeavesDefault);
    RUN_TEST(test_decodeMove_emptyString);
    RUN_TEST(test_decodeMove_gcodeCastTruncatesToUint8);
    RUN_TEST(test_decodeMove_largePauseValue);
    RUN_TEST(test_isEndTest_exactMatch);
    RUN_TEST(test_isEndTest_null);
    RUN_TEST(test_isEndTest_nonMatching);
    RUN_TEST(test_isEndTest_requiresExactString);
    return UNITY_END();
}
