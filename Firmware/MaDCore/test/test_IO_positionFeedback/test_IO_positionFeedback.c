/*
 * Unit tests for IO_positionFeedback — converts encoder steps <-> micrometres
 * via lib_utility_muldiv64_signed (real, compiled globally). Encoder access is
 * replaced by local HAL_encoder doubles. NOTE the param is steps-per-MM despite
 * the header naming it stepPerUM.
 */
#include <unity.h>
#include "vibes_behaviour.h"
#include "../../src/IO/IO_positionFeedback.c"

extern void HAL_lock_mock_reset(void);

/* ---- HAL_encoder doubles ---- */
static int32_t d_encoderValue;
static int32_t d_lastSetSteps;
static HAL_encoder_channel_E d_startedCh, d_lastSetCh, d_lastValueCh;
static int d_startCount;

void HAL_encoder_start(HAL_encoder_channel_E ch) { d_startCount++; d_startedCh = ch; }
int32_t HAL_encoder_value(HAL_encoder_channel_E ch) { d_lastValueCh = ch; return d_encoderValue; }
void HAL_encoder_set(HAL_encoder_channel_E ch, int32_t v) { d_lastSetCh = ch; d_lastSetSteps = v; }

void setUp(void)
{
    HAL_lock_mock_reset();
    d_encoderValue = 0;
    d_lastSetSteps = 0;
    d_startCount = 0;
}
void tearDown(void) {}

void test_init_starts_encoder_on_servo_channel(void)
{
    VIBES_BEHAVIOUR("encoder.init-starts-servo",
                    "src/IO/IO_positionFeedback.c#IO_positionFeedback_init",
                    "start-up of the servo position encoder",
                    "start-up of the servo position encoder starts the servo encoder hardware");
    IO_positionFeedback_init(IO_POSITION_FEEDBACK_CHANNEL_SERVO_FEEDBACK, 0, 200);
    TEST_ASSERT_EQUAL_INT(1, d_startCount);
    TEST_ASSERT_EQUAL_INT(HAL_ENCODER_CHANNEL_SERVO, d_startedCh);
}

void test_init_out_of_range_channel_is_noop(void)
{
    VIBES_BEHAVIOUR("encoder.init-unknown-channel-is-noop",
                    "src/IO/IO_positionFeedback.c#IO_positionFeedback_init",
                    "start-up of a position encoder channel that does not exist",
                    "start-up of an unknown position encoder channel starts no encoder hardware");
    IO_positionFeedback_init(IO_POSITION_FEEDBACK_CHANNEL_COUNT, 0, 200);
    TEST_ASSERT_EQUAL_INT(0, d_startCount); /* did not start any encoder */
}

void test_getValue_scales_steps_to_um(void)
{
    VIBES_BEHAVIOUR("encoder.get-scales-steps-to-um",
                    "src/IO/IO_positionFeedback.c#IO_positionFeedback_getValue",
                    "a servo encoder of 400 steps at 200 steps per millimetre",
                    "encoder position is reported in micrometres, so 400 steps at 200 steps per millimetre is 2000 micrometres");
    IO_positionFeedback_init(IO_POSITION_FEEDBACK_CHANNEL_SERVO_FEEDBACK, 0, 200);
    d_encoderValue = 400; /* 400 steps / 200 steps-per-mm = 2 mm = 2000 um */
    TEST_ASSERT_EQUAL_INT32(2000, IO_positionFeedback_getValue(IO_POSITION_FEEDBACK_CHANNEL_SERVO_FEEDBACK));
    TEST_ASSERT_EQUAL_INT(HAL_ENCODER_CHANNEL_SERVO, d_lastValueCh);
}

void test_getValue_negative_steps(void)
{
    VIBES_BEHAVIOUR("encoder.get-negative-steps",
                    "src/IO/IO_positionFeedback.c#IO_positionFeedback_getValue",
                    "a servo encoder of minus 400 steps at 200 steps per millimetre",
                    "a negative encoder step count is reported as a negative position in micrometres");
    IO_positionFeedback_init(IO_POSITION_FEEDBACK_CHANNEL_SERVO_FEEDBACK, 0, 200);
    d_encoderValue = -400;
    TEST_ASSERT_EQUAL_INT32(-2000, IO_positionFeedback_getValue(IO_POSITION_FEEDBACK_CHANNEL_SERVO_FEEDBACK));
}

void test_getValue_zero_stepPerMM_defaults_to_one(void)
{
    VIBES_BEHAVIOUR_WHY("encoder.zero-steps-per-mm-defaults-to-one",
                        "src/IO/IO_positionFeedback.c#IO_positionFeedback_init",
                        "a position encoder configured with zero steps per millimetre, reading five steps",
                        "a position encoder configured with zero steps per millimetre treats each step as one millimetre",
                        "the conversion divides by steps per millimetre; a configured zero would stop the encoder from reporting a usable position");
    IO_positionFeedback_init(IO_POSITION_FEEDBACK_CHANNEL_SERVO_FEEDBACK, 0, 0); /* guarded to 1 */
    d_encoderValue = 5;
    TEST_ASSERT_EQUAL_INT32(5000, IO_positionFeedback_getValue(IO_POSITION_FEEDBACK_CHANNEL_SERVO_FEEDBACK));
}

void test_getValue_out_of_range_returns_zero(void)
{
    VIBES_BEHAVIOUR("encoder.get-unknown-channel-is-zero",
                    "src/IO/IO_positionFeedback.c#IO_positionFeedback_getValue",
                    "a position request on an encoder channel that does not exist",
                    "the position of an unknown encoder channel is reported as zero");
    IO_positionFeedback_init(IO_POSITION_FEEDBACK_CHANNEL_SERVO_FEEDBACK, 0, 200);
    TEST_ASSERT_EQUAL_INT32(0, IO_positionFeedback_getValue(IO_POSITION_FEEDBACK_CHANNEL_COUNT));
}

void test_setValue_scales_um_to_steps_and_sets_encoder(void)
{
    VIBES_BEHAVIOUR("encoder.set-scales-um-to-steps",
                    "src/IO/IO_positionFeedback.c#IO_positionFeedback_setValue",
                    "a request to set the servo encoder to 3000 micrometres at 200 steps per millimetre",
                    "setting encoder position to 3000 micrometres at 200 steps per millimetre programs the encoder to 600 steps");
    IO_positionFeedback_init(IO_POSITION_FEEDBACK_CHANNEL_SERVO_FEEDBACK, 0, 200);
    TEST_ASSERT_TRUE(IO_positionFeedback_setValue(IO_POSITION_FEEDBACK_CHANNEL_SERVO_FEEDBACK, 3000));
    TEST_ASSERT_EQUAL_INT32(600, d_lastSetSteps); /* 3000 um * 200 / 1000 = 600 steps */
    TEST_ASSERT_EQUAL_INT(HAL_ENCODER_CHANNEL_SERVO, d_lastSetCh);
}

void test_setValue_out_of_range_returns_false(void)
{
    VIBES_BEHAVIOUR("encoder.set-unknown-channel-refused",
                    "src/IO/IO_positionFeedback.c#IO_positionFeedback_setValue",
                    "a request to set position on an encoder channel that does not exist",
                    "setting the position of an unknown encoder channel is refused");
    IO_positionFeedback_init(IO_POSITION_FEEDBACK_CHANNEL_SERVO_FEEDBACK, 0, 200);
    TEST_ASSERT_FALSE(IO_positionFeedback_setValue(IO_POSITION_FEEDBACK_CHANNEL_COUNT, 100));
}

void test_set_then_get_round_trips(void)
{
    VIBES_BEHAVIOUR("encoder.set-get-round-trip",
                    "src/IO/IO_positionFeedback.c#IO_positionFeedback_getValue",
                    "encoder position set to 1234 micrometres, then read back",
                    "encoder position set to a value in micrometres reads back as that same value");
    IO_positionFeedback_init(IO_POSITION_FEEDBACK_CHANNEL_SERVO_FEEDBACK, 0, 1000);
    IO_positionFeedback_setValue(IO_POSITION_FEEDBACK_CHANNEL_SERVO_FEEDBACK, 1234);
    d_encoderValue = d_lastSetSteps; /* the encoder now reads back what was set */
    TEST_ASSERT_EQUAL_INT32(1234, IO_positionFeedback_getValue(IO_POSITION_FEEDBACK_CHANNEL_SERVO_FEEDBACK));
}

int main(void)
{
    UNITY_BEGIN();
    RUN_TEST(test_init_starts_encoder_on_servo_channel);
    RUN_TEST(test_init_out_of_range_channel_is_noop);
    RUN_TEST(test_getValue_scales_steps_to_um);
    RUN_TEST(test_getValue_negative_steps);
    RUN_TEST(test_getValue_zero_stepPerMM_defaults_to_one);
    RUN_TEST(test_getValue_out_of_range_returns_zero);
    RUN_TEST(test_setValue_scales_um_to_steps_and_sets_encoder);
    RUN_TEST(test_setValue_out_of_range_returns_false);
    RUN_TEST(test_set_then_get_round_trips);
    return UNITY_END();
}
