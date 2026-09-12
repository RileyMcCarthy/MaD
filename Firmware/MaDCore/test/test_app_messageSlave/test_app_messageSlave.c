/*
 * Unit tests for app_messageSlave — the ProtoEmb protocol bridge. The generated
 * ProtoEmb runtime/codec is compiled in for real; every app/dev/io collaborator
 * is doubled. Tests call the bridge onRead/onWrite ProtoEmb callbacks directly
 * (the runtime would otherwise invoke them) and assert the app-state to
 * protocol-struct mapping. Wire encode/decode is covered by test_core/test_protoemb.
 *
 * The generated codec + runtime live in a SEPARATE TU (zz_protoemb_gen.c) so their
 * weak default callbacks are overridden at link by app_messageSlave's strong ones
 * (#including both in one TU is a redefinition error).
 */
#include <unity.h>
#include "vibes_behaviour.h"
#include <string.h>
#include "../../src/APP/app_messageSlave.c"

extern void HAL_lock_mock_reset(void);

/* ---- app_gauge ---- */
static int32_t d_force[APP_GAUGE_COORD_COUNT];
static int32_t d_pos[APP_GAUGE_COORD_COUNT];
static int d_setLenCount, d_setForceCount;
int32_t app_gauge_getForce(app_gauge_coord_E c) { return d_force[c]; }
int32_t app_gauge_getPosition(app_gauge_coord_E c) { return d_pos[c]; }
void app_gauge_setGaugeLength(void) { d_setLenCount++; }
void app_gauge_setGaugeForce(void) { d_setForceCount++; }

/* ---- app_motion ---- */
static int32_t d_setpoint;
int32_t app_motion_getSetpoint(void) { return d_setpoint; }

/* ---- app_control ---- */
static app_control_fault_E d_fault;
static app_control_restriction_E d_restriction;
static bool d_motionEnabled, d_trigEnRet, d_trigDisRet;
app_control_fault_E app_control_getFault(void) { return d_fault; }
app_control_restriction_E app_control_getRestriction(void) { return d_restriction; }
bool app_control_motionEnabled(void) { return d_motionEnabled; }
bool app_control_triggerMotionEnabled(void) { return d_trigEnRet; }
bool app_control_triggerMotionDisabled(void) { return d_trigDisRet; }

/* ---- app_testManagement ---- */
static bool d_isRunning, d_isBusy, d_addMoveRet, d_startRet;
/* When true, isBusy reports busy until triggerTestEnd has been called once —
 * models the END-then-wait path of ProtoEmb_onWrite_test_run without spinning. */
static bool d_busyUntilEnd;
static app_motion_move_t d_lastManualMove;
static char d_lastGcodeId[16];
static int d_endCount;
static int d_startCount;
bool app_testManagement_isRunning(void) { return d_isRunning; }
bool app_testManagement_isBusy(void)
{
    if (d_busyUntilEnd)
    {
        return d_endCount == 0;
    }
    return d_isBusy;
}
bool app_testManagement_triggerTestEnd(void) { d_endCount++; return true; }
bool app_testManagement_triggerTestStart(const char *id)
{
    d_startCount++;
    strncpy(d_lastGcodeId, id, sizeof(d_lastGcodeId) - 1);
    return d_startRet;
}
bool app_testManagement_addManualMove(const app_motion_move_t *m) { d_lastManualMove = *m; return d_addMoveRet; }

/* ---- app_monitor ---- */
static app_monitor_sampleProfile_S d_getProfile, d_setProfile;
static bool d_setProfileRet;
static int d_setProfileCount;
static char d_testName[32];
void app_monitor_getSampleProfile(app_monitor_sampleProfile_S *p) { *p = d_getProfile; }
bool app_monitor_setSampleProfile(app_monitor_sampleProfile_S *p) { d_setProfile = *p; d_setProfileCount++; return d_setProfileRet; }
void app_monitor_setTestName(const char *n) { strncpy(d_testName, n, sizeof(d_testName) - 1); }

/* ---- app_notification ---- */
static int d_notifyCount;
void app_notification_send(app_notification_type_E t, const char *f, ...) { (void)t; (void)f; d_notifyCount++; }

/* ---- dev_nvram ---- */
static MachineProfile d_nvramProfile;
static int d_updateCount;
bool dev_nvram_getChannelData(dev_nvram_channel_t c, void *d, size_t s) { (void)c; memcpy(d, &d_nvramProfile, s < sizeof(d_nvramProfile) ? s : sizeof(d_nvramProfile)); return true; }
bool dev_nvram_updateChannelData(dev_nvram_channel_t c, void *d, size_t s) { (void)c; memcpy(&d_nvramProfile, d, s < sizeof(d_nvramProfile) ? s : sizeof(d_nvramProfile)); d_updateCount++; return true; }

/* ---- IO_fullDuplexSerial (run() pump: report empty) ---- */
bool IO_fullDuplexSerial_send(IO_fullDuplexSerial_channel_E ch, const uint8_t *d, uint32_t l) { (void)ch; (void)d; (void)l; return true; }
uint32_t IO_fullDuplexSerial_available(IO_fullDuplexSerial_channel_E ch) { (void)ch; return 0; }
bool IO_fullDuplexSerial_receive(IO_fullDuplexSerial_channel_E ch, uint8_t *d, uint32_t l) { (void)ch; (void)d; (void)l; return false; }

/* ---- IO_SDCard ---- */
static bool d_sdPushRet, d_sdOpenRet;
static app_motion_move_t d_lastSdPush;
bool IO_SDCard_push(IO_SDCard_channel_E ch, void *d, uint32_t s) { (void)ch; memcpy(&d_lastSdPush, d, s < sizeof(d_lastSdPush) ? s : sizeof(d_lastSdPush)); return d_sdPushRet; }
bool IO_SDCard_open(IO_SDCard_channel_E ch, const char *n, IO_SDCard_mode_E m) { (void)ch; (void)n; (void)m; return d_sdOpenRet; }
uint32_t IO_SDCard_readDirectEx(IO_SDCard_channel_E ch, const char *fileName, void *buffer, uint32_t index, uint32_t count, IO_SDCard_readDirectStatus_E *outStatus)
{
    (void)ch; (void)fileName; (void)buffer; (void)index; (void)count;
    *outStatus = IO_SDCARD_READDIRECT_STATUS_OK;
    return 0;
}

static int s_lock;
void setUp(void)
{
    HAL_lock_mock_reset();
    _stdio_debug_lock = HAL_lock_create();
    s_lock = HAL_lock_create();
    memset(d_force, 0, sizeof(d_force));
    memset(d_pos, 0, sizeof(d_pos));
    d_setLenCount = d_setForceCount = 0;
    d_setpoint = 0;
    d_fault = 0; d_restriction = 0; d_motionEnabled = false; d_trigEnRet = d_trigDisRet = false;
    d_isRunning = d_isBusy = d_addMoveRet = d_startRet = false;
    d_busyUntilEnd = false;
    memset(&d_lastManualMove, 0, sizeof(d_lastManualMove));
    memset(d_lastGcodeId, 0, sizeof(d_lastGcodeId));
    d_endCount = 0;
    d_startCount = 0;
    memset(&d_getProfile, 0, sizeof(d_getProfile));
    memset(&d_setProfile, 0, sizeof(d_setProfile));
    d_setProfileRet = false; d_setProfileCount = 0;
    memset(d_testName, 0, sizeof(d_testName));
    d_notifyCount = 0;
    memset(&d_nvramProfile, 0, sizeof(d_nvramProfile));
    d_updateCount = 0;
    d_sdPushRet = d_sdOpenRet = false;
    memset(&d_lastSdPush, 0, sizeof(d_lastSdPush));
    memset(&app_message_slave_data, 0, sizeof(app_message_slave_data));
    app_messageSlave_init(s_lock);
}
void tearDown(void) {}

void test_onRead_state_maps_app_control(void)
{
    VIBES_BEHAVIOUR("bridge.state-reports-fault-restriction-test-and-motion",
                    "src/APP/app_messageSlave.c#ProtoEmb_onRead_state",
                    "a known fault, a known restriction, a test running, and motion enabled",
                    "the machine reports its state as the current fault reason, restriction reason, whether a test is running, and whether motion is enabled");
    d_fault = 3; d_restriction = 2; d_isRunning = true; d_motionEnabled = true;
    ProtoEmb_MachineState_t out;
    TEST_ASSERT_TRUE(ProtoEmb_onRead_state(&out));
    TEST_ASSERT_EQUAL_INT(3, out.faultedReason);
    TEST_ASSERT_EQUAL_INT(2, out.restrictedReason);
    TEST_ASSERT_TRUE(out.testRunning);
    TEST_ASSERT_TRUE(out.motionEnabled);
}

void test_onRead_firmware_version_default(void)
{
    VIBES_BEHAVIOUR_WHY("bridge.unversioned-firmware-reports-zero",
                        "src/APP/app_messageSlave.c#ProtoEmb_onRead_firmware_version",
                        "firmware built without a version stamp",
                        "firmware built without a version stamp reports its version as 0.0.0",
                        "a build without a stamp still answers, so the control app can tell the machine is there");
    ProtoEmb_FirmwareVersion_t out;
    TEST_ASSERT_TRUE(ProtoEmb_onRead_firmware_version(&out));
    TEST_ASSERT_EQUAL_STRING("0.0.0", out.version);
}

void test_onRead_sample_profile_maps_monitor(void)
{
    VIBES_BEHAVIOUR("bridge.sample-profile-read-matches-loaded",
                    "src/APP/app_messageSlave.c#ProtoEmb_onRead_sample_profile",
                    "a sample profile already loaded, with force, displacement and thickness set",
                    "reading the sample profile returns the loaded force limit, extension limit and specimen thickness");
    d_getProfile.maxForce = 75; d_getProfile.maxVelocity = 30; d_getProfile.maxDisplacement = 150;
    d_getProfile.sampleWidth = 12; d_getProfile.sampleThickness = 3;
    ProtoEmb_SampleProfile_t out;
    TEST_ASSERT_TRUE(ProtoEmb_onRead_sample_profile(&out));
    TEST_ASSERT_EQUAL_INT(75, out.maxForce);
    TEST_ASSERT_EQUAL_INT(150, out.maxDisplacement);
    TEST_ASSERT_EQUAL_INT(3, out.sampleThickness);
}

void test_onWrite_motion_enable_true_acks_on_trigger(void)
{
    VIBES_BEHAVIOUR_WHY("bridge.enable-motion-ack-follows-machine",
                        "src/APP/app_messageSlave.c#ProtoEmb_onWrite_motion_enable",
                        "a request to enable motion, first when the machine accepts it, then when the machine refuses",
                        "a request to enable motion is acknowledged when the machine accepts the request, and refused when the machine turns the request down",
                        "the control app must not show motion as enabled until the machine has taken the request");
    d_trigEnRet = true;
    TEST_ASSERT_EQUAL_INT(PROTOEMB_RUNTIME_WRITE_DISPOSITION_ACK, ProtoEmb_onWrite_motion_enable(true));
    d_trigEnRet = false;
    TEST_ASSERT_EQUAL_INT(PROTOEMB_RUNTIME_WRITE_DISPOSITION_NACK, ProtoEmb_onWrite_motion_enable(true));
}

void test_onWrite_motion_enable_false_uses_disable_trigger(void)
{
    VIBES_BEHAVIOUR_WHY("bridge.disable-motion-stops",
                        "src/APP/app_messageSlave.c#ProtoEmb_onWrite_motion_enable",
                        "a request to disable motion, with the machine ready to stop",
                        "a request to disable motion is acknowledged by stopping motion",
                        "disable is the operator stop, a different request from enable");
    d_trigDisRet = true;
    TEST_ASSERT_EQUAL_INT(PROTOEMB_RUNTIME_WRITE_DISPOSITION_ACK, ProtoEmb_onWrite_motion_enable(false));
}

void test_onWrite_gauge_length_and_force(void)
{
    VIBES_BEHAVIOUR("bridge.zero-length-and-force-latch-and-ack",
                    "src/APP/app_messageSlave.c#ProtoEmb_onWrite_gauge_length",
                    "a request to zero gauge length, then a request to zero force",
                    "a request to zero gauge length or force latches that origin and is acknowledged");
    TEST_ASSERT_EQUAL_INT(PROTOEMB_RUNTIME_WRITE_DISPOSITION_ACK, ProtoEmb_onWrite_gauge_length());
    TEST_ASSERT_EQUAL_INT(1, d_setLenCount);
    TEST_ASSERT_EQUAL_INT(PROTOEMB_RUNTIME_WRITE_DISPOSITION_ACK, ProtoEmb_onWrite_gauge_force());
    TEST_ASSERT_EQUAL_INT(1, d_setForceCount);
}

void test_onWrite_manual_move_fills_and_forwards(void)
{
    VIBES_BEHAVIOUR("bridge.jog-carries-target-speed-pause",
                    "src/APP/app_messageSlave.c#ProtoEmb_onWrite_manual_move",
                    "a jog with a target, a speed and a pause, first accepted, then turned down",
                    "a jog is acknowledged and carried through with its target, speed and pause, and a jog the machine turns down is refused");
    ProtoEmb_Move_t in;
    memset(&in, 0, sizeof(in));
    in.g = (ProtoEmb_GCode_E)1; in.x = 1234; in.f = 56; in.p = 78;
    d_addMoveRet = true;
    TEST_ASSERT_EQUAL_INT(PROTOEMB_RUNTIME_WRITE_DISPOSITION_ACK, ProtoEmb_onWrite_manual_move(&in));
    TEST_ASSERT_EQUAL_UINT8(1, d_lastManualMove.g);
    TEST_ASSERT_EQUAL_INT32(1234, d_lastManualMove.x);
    TEST_ASSERT_EQUAL_INT32(56, d_lastManualMove.f);
    TEST_ASSERT_EQUAL_UINT32(78, d_lastManualMove.p);

    d_addMoveRet = false;
    TEST_ASSERT_EQUAL_INT(PROTOEMB_RUNTIME_WRITE_DISPOSITION_NACK, ProtoEmb_onWrite_manual_move(&in));
}

void test_onWrite_test_move_pushes_to_sd(void)
{
    VIBES_BEHAVIOUR("bridge.test-move-stored-on-card",
                    "src/APP/app_messageSlave.c#ProtoEmb_onWrite_test_move",
                    "a motion-program move, first with the card accepting it, then with the card full",
                    "a move in the test program is stored on the card and acknowledged, and refused when the card will not take the move");
    ProtoEmb_Move_t in;
    memset(&in, 0, sizeof(in));
    in.g = (ProtoEmb_GCode_E)1; in.x = 99;
    d_sdPushRet = true;
    TEST_ASSERT_EQUAL_INT(PROTOEMB_RUNTIME_WRITE_DISPOSITION_ACK, ProtoEmb_onWrite_test_move(&in));
    TEST_ASSERT_EQUAL_INT32(99, d_lastSdPush.x);
    d_sdPushRet = false;
    TEST_ASSERT_EQUAL_INT(PROTOEMB_RUNTIME_WRITE_DISPOSITION_NACK, ProtoEmb_onWrite_test_move(&in));
}

void test_onWrite_sample_profile_maps_and_forwards(void)
{
    VIBES_BEHAVIOUR("bridge.sample-profile-write-loads-limits",
                    "src/APP/app_messageSlave.c#ProtoEmb_onWrite_sample_profile_write",
                    "a sample profile written with force and extension limits",
                    "writing a sample profile loads its force and extension limits onto the machine and is acknowledged");
    ProtoEmb_SampleProfile_t in;
    memset(&in, 0, sizeof(in));
    in.maxForce = 80; in.maxVelocity = 25; in.maxDisplacement = 120; in.sampleWidth = 10; in.sampleThickness = 2;
    d_setProfileRet = true;
    TEST_ASSERT_EQUAL_INT(PROTOEMB_RUNTIME_WRITE_DISPOSITION_ACK, ProtoEmb_onWrite_sample_profile_write(&in));
    TEST_ASSERT_EQUAL_INT(1, d_setProfileCount);
    TEST_ASSERT_EQUAL_INT(80, d_setProfile.maxForce);
    TEST_ASSERT_EQUAL_INT(120, d_setProfile.maxDisplacement);
}

/* Self-cancel regression (c081e6c8): when IDLE, test_run must NOT call
 * triggerTestEnd — an unconditional END races a fresh START on the next tick. */
void test_onWrite_test_run_idle_does_not_end(void)
{
    VIBES_BEHAVIOUR_WHY("bridge.start-test-while-idle-starts-only",
                        "src/APP/app_messageSlave.c#ProtoEmb_onWrite_test_run",
                        "a request to start a named test while no test session is under way",
                        "a request to start a named test while idle starts that test under its program and run names, with no stop of a previous session",
                        "only a session that is actually under way is stopped before a new test starts");
    d_isBusy = false;
    d_busyUntilEnd = false;
    d_startRet = true;
    ProtoEmb_TestRun_t in;
    memset(&in, 0, sizeof(in));
    memcpy(in.gcodeId, "gc0001", 6);
    memcpy(in.testDataId, "td0001", 6);
    TEST_ASSERT_EQUAL_INT(PROTOEMB_RUNTIME_WRITE_DISPOSITION_ACK, ProtoEmb_onWrite_test_run(&in));
    TEST_ASSERT_EQUAL_INT(0, d_endCount);   /* the fix: no END while idle */
    TEST_ASSERT_EQUAL_INT(1, d_startCount);
    TEST_ASSERT_EQUAL_STRING("gc0001", d_lastGcodeId);
    TEST_ASSERT_EQUAL_STRING("td0001", d_testName);
}

/* When a session is busy, test_run must request END once, wait until idle, then START. */
void test_onWrite_test_run_busy_ends_then_starts(void)
{
    VIBES_BEHAVIOUR_WHY("bridge.start-test-while-busy-stops-then-starts",
                        "src/APP/app_messageSlave.c#ProtoEmb_onWrite_test_run",
                        "a request to start a named test while a session is still busy",
                        "a request to start a named test while a session is busy stops that session first, then starts the new one under its program and run names",
                        "a new test replaces the one already under way, and waits until that one has finished stopping");
    d_busyUntilEnd = true; /* isBusy true until END is called */
    d_startRet = true;
    ProtoEmb_TestRun_t in;
    memset(&in, 0, sizeof(in));
    memcpy(in.gcodeId, "gc0002", 6);
    memcpy(in.testDataId, "td0002", 6);
    TEST_ASSERT_EQUAL_INT(PROTOEMB_RUNTIME_WRITE_DISPOSITION_ACK, ProtoEmb_onWrite_test_run(&in));
    TEST_ASSERT_EQUAL_INT(1, d_endCount);
    TEST_ASSERT_EQUAL_INT(1, d_startCount);
    TEST_ASSERT_EQUAL_STRING("gc0002", d_lastGcodeId);
    TEST_ASSERT_EQUAL_STRING("td0002", d_testName);
}

/* M5 bridge matrix: start NACK when triggerTestStart fails; END only when busy. */
void test_m5_onWrite_test_run_start_nack_when_rejected(void)
{
    VIBES_BEHAVIOUR_WHY("bridge.start-test-refused-when-machine-rejects",
                        "src/APP/app_messageSlave.c#ProtoEmb_onWrite_test_run",
                        "a request to start a test while idle, with the machine turning the start down",
                        "a start the machine turns down is refused, with no stop requested first",
                        "the control app has to see the refusal so a test is not shown as running");
    d_isBusy = false;
    d_busyUntilEnd = false;
    d_startRet = false; /* firmware rejects the start (e.g. still busy race) */
    ProtoEmb_TestRun_t in;
    memset(&in, 0, sizeof(in));
    memcpy(in.gcodeId, "gc0003", 6);
    memcpy(in.testDataId, "td0003", 6);
    TEST_ASSERT_EQUAL_INT(PROTOEMB_RUNTIME_WRITE_DISPOSITION_NACK, ProtoEmb_onWrite_test_run(&in));
    TEST_ASSERT_EQUAL_INT(0, d_endCount);
    TEST_ASSERT_EQUAL_INT(1, d_startCount);
}

void test_m5_onWrite_manual_move_nacks_when_busy(void)
{
    /* same as bridge.jog-carries-target-speed-pause: a jog the machine turns down is refused */
    d_addMoveRet = false; /* addManualMove rejects while busy */
    ProtoEmb_Move_t in;
    memset(&in, 0, sizeof(in));
    in.g = (ProtoEmb_GCode_E)1;
    in.x = 10;
    in.f = 5;
    TEST_ASSERT_EQUAL_INT(PROTOEMB_RUNTIME_WRITE_DISPOSITION_NACK, ProtoEmb_onWrite_manual_move(&in));
}

void test_machine_configuration_round_trips_through_bridge(void)
{
    VIBES_BEHAVIOUR_WHY("bridge.machine-config-saved-and-read-back",
                        "src/APP/app_messageSlave.c#ProtoEmb_onWrite_machine_configuration_write",
                        "a machine configuration written with steps per millimetre, travel, load-cell sensitivity and a name",
                        "a written machine configuration is saved, the operator is told the profile was saved, and reading the profile back returns the same steps, travel, sensitivity and name",
                        "the saved profile is what the next boot will use");
    ProtoEmb_MachineConfiguration_t in;
    memset(&in, 0, sizeof(in));
    in.servoStepsPerMM = 200; in.maxPosition = 150000; in.maxVelocity = 30000;
    in.loadCellSensitivity = -2000000; strncpy(in.name, "RIG-A", sizeof(in.name) - 1);
    TEST_ASSERT_EQUAL_INT(PROTOEMB_RUNTIME_WRITE_DISPOSITION_ACK, ProtoEmb_onWrite_machine_configuration_write(&in));
    TEST_ASSERT_EQUAL_INT(1, d_updateCount);   /* persisted to nvram */
    TEST_ASSERT_TRUE(d_notifyCount >= 1);       /* user notified */

    ProtoEmb_MachineConfiguration_t out;
    TEST_ASSERT_TRUE(ProtoEmb_onRead_machine_configuration(&out));
    TEST_ASSERT_EQUAL_INT32(200, out.servoStepsPerMM);
    TEST_ASSERT_EQUAL_INT32(150000, out.maxPosition);
    TEST_ASSERT_EQUAL_INT32(-2000000, out.loadCellSensitivity);
    TEST_ASSERT_EQUAL_STRING("RIG-A", out.name);
}

int main(void)
{
    UNITY_BEGIN();
    RUN_TEST(test_onRead_state_maps_app_control);
    RUN_TEST(test_onRead_firmware_version_default);
    RUN_TEST(test_onRead_sample_profile_maps_monitor);
    RUN_TEST(test_onWrite_motion_enable_true_acks_on_trigger);
    RUN_TEST(test_onWrite_motion_enable_false_uses_disable_trigger);
    RUN_TEST(test_onWrite_gauge_length_and_force);
    RUN_TEST(test_onWrite_manual_move_fills_and_forwards);
    RUN_TEST(test_onWrite_test_move_pushes_to_sd);
    RUN_TEST(test_onWrite_sample_profile_maps_and_forwards);
    RUN_TEST(test_onWrite_test_run_idle_does_not_end);
    RUN_TEST(test_onWrite_test_run_busy_ends_then_starts);
    RUN_TEST(test_m5_onWrite_test_run_start_nack_when_rejected);
    RUN_TEST(test_m5_onWrite_manual_move_nacks_when_busy);
    RUN_TEST(test_machine_configuration_round_trips_through_bridge);
    return UNITY_END();
}
