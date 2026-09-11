#include <unity.h>
#include "vibes_behaviour.h"
#include "HAL_lock.h"

// Module under test (compiled via include of the .c)
#include "../../src/APP/app_gauge.c"

extern void HAL_lock_mock_reset(void);
extern int _stdio_debug_lock; /* shared in mock_propeller2.c */

/**********************************************************************
 * Local test doubles for peer dependencies
 **********************************************************************/
static int32_t g_machinePositionUm;
static int32_t g_machineForceMN;
static IO_positionFeedback_channel_E g_lastPosChannel;
static dev_forceGauge_channel_E g_lastForceChannel;

void set_machinePositionUm(int32_t v) { g_machinePositionUm = v; }
void set_machineForceMN(int32_t v) { g_machineForceMN = v; }

int32_t IO_positionFeedback_getValue(IO_positionFeedback_channel_E ch)
{
    g_lastPosChannel = ch;
    return g_machinePositionUm;
}

int32_t dev_forceGauge_getForce(dev_forceGauge_channel_E channel)
{
    g_lastForceChannel = channel;
    return g_machineForceMN;
}

/**********************************************************************
 * Fixture
 **********************************************************************/
static int s_lock;

void setUp(void)
{
    HAL_lock_mock_reset();
    g_machinePositionUm = 0;
    g_machineForceMN = 0;
    g_lastPosChannel = IO_POSITION_FEEDBACK_CHANNEL_COUNT;
    g_lastForceChannel = (dev_forceGauge_channel_E)0;
    s_lock = HAL_lock_create();
    app_gauge_init(s_lock);
}

void tearDown(void) {}

/**********************************************************************
 * Tests
 **********************************************************************/
void test_init_zeros_offsets(void)
{
    VIBES_BEHAVIOUR("gauge.starts-with-zero-length-and-force",
                    "src/APP/app_gauge.c#app_gauge_init",
                    "the gauge starting up",
                    "gauge length and the force tare both start at zero");
    TEST_ASSERT_EQUAL_INT32(0, app_gauge_getGaugeLength_um());
    TEST_ASSERT_EQUAL_INT32(0, app_gauge_getGaugeForce_mN());
}

void test_getPosition_machine_passthrough(void)
{
    VIBES_BEHAVIOUR("gauge.machine-position-is-encoder",
                    "src/APP/app_gauge.c#app_gauge_getPosition",
                    "the encoder reporting a position",
                    "machine position is the encoder reading");
    set_machinePositionUm(12345);
    TEST_ASSERT_EQUAL_INT32(12345, app_gauge_getPosition(APP_GAUGE_COORD_MACHINE));
    TEST_ASSERT_EQUAL_INT(IO_POSITION_FEEDBACK_CHANNEL_SERVO_FEEDBACK, g_lastPosChannel);
}

void test_getPosition_sample_subtracts_latched_length(void)
{
    VIBES_BEHAVIOUR_WHY("gauge.sample-extension-is-travel-since-zero",
                        "src/APP/app_gauge.c#app_gauge_getPosition",
                        "gauge length zeroed, then the jaws moved further",
                        "sample position is how far the jaws have travelled since gauge length was zeroed",
                        "strain is measured from the specimen's original length");
    set_machinePositionUm(1000);
    app_gauge_setGaugeLength(); // latch 1000
    set_machinePositionUm(1500);
    TEST_ASSERT_EQUAL_INT32(500, app_gauge_getPosition(APP_GAUGE_COORD_SAMPLE));
    TEST_ASSERT_EQUAL_INT32(1500, app_gauge_getPosition(APP_GAUGE_COORD_MACHINE));
}

void test_getPosition_sample_negative_delta(void)
{
    VIBES_BEHAVIOUR_WHY("gauge.sample-extension-negative-when-jaws-close",
                        "src/APP/app_gauge.c#app_gauge_getPosition",
                        "gauge length zeroed, then the jaws closed past that point",
                        "when the jaws close past the zeroed gauge length, sample position is negative",
                        "closing the jaws past the origin is compression of the specimen");
    set_machinePositionUm(2000);
    app_gauge_setGaugeLength();
    set_machinePositionUm(1200);
    TEST_ASSERT_EQUAL_INT32(-800, app_gauge_getPosition(APP_GAUGE_COORD_SAMPLE));
}

void test_getPosition_count_returns_zero(void)
{
    VIBES_BEHAVIOUR("gauge.unknown-coordinate-position-is-zero",
                    "src/APP/app_gauge.c#app_gauge_getPosition",
                    "a request for a coordinate that is neither the machine nor the sample",
                    "a position asked for as neither machine nor sample is reported as zero");
    set_machinePositionUm(999);
    TEST_ASSERT_EQUAL_INT32(0, app_gauge_getPosition(APP_GAUGE_COORD_COUNT));
}

void test_getForce_machine_passthrough(void)
{
    VIBES_BEHAVIOUR("gauge.machine-force-is-load-cell",
                    "src/APP/app_gauge.c#app_gauge_getForce",
                    "the load cell reporting a force, including compression",
                    "machine force is the load cell reading, including compression");
    set_machineForceMN(-4200);
    TEST_ASSERT_EQUAL_INT32(-4200, app_gauge_getForce(APP_GAUGE_COORD_MACHINE));
    TEST_ASSERT_EQUAL_INT(DEV_FORCEGAUGE_CHANNEL_MAIN, g_lastForceChannel);
}

void test_getForce_sample_subtracts_latched_force(void)
{
    VIBES_BEHAVIOUR_WHY("gauge.sample-force-is-change-since-zero",
                        "src/APP/app_gauge.c#app_gauge_getForce",
                        "force zeroed at a non-zero load, then the load increased",
                        "sample force is how much the load has changed since force was zeroed",
                        "sample force is the load on the specimen, measured from the zero-force reading");
    set_machineForceMN(300);
    app_gauge_setGaugeForce(); // latch 300 (tare)
    set_machineForceMN(1300);
    TEST_ASSERT_EQUAL_INT32(1000, app_gauge_getForce(APP_GAUGE_COORD_SAMPLE));
}

void test_getForce_count_returns_zero(void)
{
    VIBES_BEHAVIOUR("gauge.unknown-coordinate-force-is-zero",
                    "src/APP/app_gauge.c#app_gauge_getForce",
                    "a request for a force as neither machine nor sample",
                    "a force asked for as neither machine nor sample is reported as zero");
    set_machineForceMN(555);
    TEST_ASSERT_EQUAL_INT32(0, app_gauge_getForce(APP_GAUGE_COORD_COUNT));
}

void test_setGaugeLength_latches_current_machine(void)
{
    VIBES_BEHAVIOUR("gauge.zero-length-stores-machine-position",
                    "src/APP/app_gauge.c#app_gauge_setGaugeLength",
                    "the encoder at a known position, and the operator zeroing length",
                    "zeroing length stores the current machine position as the gauge length");
    set_machinePositionUm(7777);
    app_gauge_setGaugeLength();
    TEST_ASSERT_EQUAL_INT32(7777, app_gauge_getGaugeLength_um());
}

void test_setGaugeForce_latches_current_machine(void)
{
    VIBES_BEHAVIOUR("gauge.zero-force-stores-machine-force",
                    "src/APP/app_gauge.c#app_gauge_setGaugeForce",
                    "the load cell at a known force, including compression, and the operator zeroing force",
                    "zeroing force stores the current machine force as the tare, including compression");
    set_machineForceMN(-321);
    app_gauge_setGaugeForce();
    TEST_ASSERT_EQUAL_INT32(-321, app_gauge_getGaugeForce_mN());
}

void test_offsets_independent(void)
{
    VIBES_BEHAVIOUR_WHY("gauge.length-and-force-origins-independent",
                        "src/APP/app_gauge.c#app_gauge_setGaugeLength",
                        "the operator zeroing length and force in the same session",
                        "zeroing length and zeroing force each store their own origin, independently",
                        "gauge length and the force tare are separate origins for sample coordinates");
    set_machinePositionUm(100);
    set_machineForceMN(200);
    app_gauge_setGaugeLength();
    app_gauge_setGaugeForce();
    TEST_ASSERT_EQUAL_INT32(100, app_gauge_getGaugeLength_um());
    TEST_ASSERT_EQUAL_INT32(200, app_gauge_getGaugeForce_mN());
}

int main(void)
{
    UNITY_BEGIN();
    RUN_TEST(test_init_zeros_offsets);
    RUN_TEST(test_getPosition_machine_passthrough);
    RUN_TEST(test_getPosition_sample_subtracts_latched_length);
    RUN_TEST(test_getPosition_sample_negative_delta);
    RUN_TEST(test_getPosition_count_returns_zero);
    RUN_TEST(test_getForce_machine_passthrough);
    RUN_TEST(test_getForce_sample_subtracts_latched_force);
    RUN_TEST(test_getForce_count_returns_zero);
    RUN_TEST(test_setGaugeLength_latches_current_machine);
    RUN_TEST(test_setGaugeForce_latches_current_machine);
    RUN_TEST(test_offsets_independent);
    return UNITY_END();
}
