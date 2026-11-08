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
static int32_t d_commanded;
int32_t app_motion_getCommandedPosition(void) { return d_commanded; }

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
static IO_SDCard_readDirectStatus_E d_readStatus;
static app_motion_move_t d_lastSdPush;
bool IO_SDCard_push(IO_SDCard_channel_E ch, void *d, uint32_t s) { (void)ch; memcpy(&d_lastSdPush, d, s < sizeof(d_lastSdPush) ? s : sizeof(d_lastSdPush)); return d_sdPushRet; }
bool IO_SDCard_open(IO_SDCard_channel_E ch, const char *n, IO_SDCard_mode_E m) { (void)ch; (void)n; (void)m; return d_sdOpenRet; }
uint32_t IO_SDCard_readDirectEx(IO_SDCard_channel_E ch, const char *fileName, void *buffer, uint32_t index, uint32_t count, IO_SDCard_readDirectStatus_E *outStatus)
{
    (void)ch; (void)fileName; (void)buffer; (void)index; (void)count;
    *outStatus = d_readStatus;
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
    d_readStatus = IO_SDCARD_READDIRECT_STATUS_OK;
    memset(&d_lastSdPush, 0, sizeof(d_lastSdPush));
    memset(&app_message_slave_data, 0, sizeof(app_message_slave_data));
    app_messageSlave_init(s_lock);
}
void tearDown(void) {}

void test_onRead_state_maps_app_control(void)
{
    VIBES_TEST("bridge.state-reports-fault-restriction-test-and-motion",
               "src/APP/app_messageSlave.c#ProtoEmb_onRead_state",
               "a known fault, a known restriction, a test running, and motion enabled");
    VIBES_EXPECT("all-four-returned", "reading the state back returns all four unchanged");
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
    VIBES_TEST("bridge.unversioned-firmware-reports-zero",
               "src/APP/app_messageSlave.c#ProtoEmb_onRead_firmware_version",
               "firmware built without a version stamp");
    VIBES_EXPECT_WHY("version-zero",
                     "the machine reports its version as 0.0.0",
                     "a build without a stamp still answers, so the control app can tell the machine is there");
    ProtoEmb_FirmwareVersion_t out;
    TEST_ASSERT_TRUE(ProtoEmb_onRead_firmware_version(&out));
    TEST_ASSERT_EQUAL_STRING("0.0.0", out.version);
}

void test_onRead_device_info_reports_protocol(void)
{
    VIBES_TEST("bridge.device-info-reports-protocol",
               "src/APP/app_messageSlave.c#ProtoEmb_onRead_device_info",
               "the control app asks the machine which protocol it speaks");
    VIBES_EXPECT_WHY("protocol-number",
                     "the machine answers with the protocol version its message definitions were generated from",
                     "the control app drives only firmware whose protocol version equals its own, and offers a firmware update otherwise");
    ProtoEmb_DeviceInfo_t out;
    TEST_ASSERT_TRUE(ProtoEmb_onRead_device_info(&out));
    TEST_ASSERT_EQUAL_UINT32(PROTOEMB_PROTOCOL_VERSION, out.protocolVersion);
}

void test_onRead_sample_profile_maps_monitor(void)
{
    VIBES_TEST("bridge.sample-profile-read-matches-loaded",
               "src/APP/app_messageSlave.c#ProtoEmb_onRead_sample_profile",
               "a sample profile loaded into the machine");
    VIBES_EXPECT("limits-returned",
                 "reading it back returns the loaded force limit, extension limit and specimen thickness");
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
    VIBES_TEST("bridge.enable-motion-ack-follows-machine",
               "src/APP/app_messageSlave.c#ProtoEmb_onWrite_motion_enable",
               "a request to enable motion, first on a healthy machine, then on a machine holding a fault");
    VIBES_EXPECT("ack-when-taken", "the request is acknowledged when the machine takes it");
    VIBES_EXPECT_WHY("refused-when-declined",
                     "the request is refused, and the refusal names the fault as the reason",
                     "the control app must not show motion as enabled until the machine has taken the request");
    d_trigEnRet = true;
    TEST_ASSERT_EQUAL_INT(PROTOEMB_RUNTIME_WRITE_DISPOSITION_ACK, ProtoEmb_onWrite_motion_enable(true));
    d_trigEnRet = false;
    TEST_ASSERT_EQUAL_INT(PROTOEMB_RUNTIME_WRITE_DISPOSITION_NACK_FAULTED, ProtoEmb_onWrite_motion_enable(true));
}

void test_onWrite_motion_enable_false_uses_disable_trigger(void)
{
    VIBES_TEST("bridge.disable-motion-stops",
               "src/APP/app_messageSlave.c#ProtoEmb_onWrite_motion_enable",
               "a request to disable motion, with the machine ready to stop");
    VIBES_EXPECT_WHY("stop-acknowledged",
                     "motion is stopped and the request is acknowledged",
                     "disable is the operator stop, a different request from enable");
    d_trigDisRet = true;
    TEST_ASSERT_EQUAL_INT(PROTOEMB_RUNTIME_WRITE_DISPOSITION_ACK, ProtoEmb_onWrite_motion_enable(false));
}

void test_onWrite_gauge_length_and_force(void)
{
    VIBES_TEST("bridge.zero-length-and-force-latch-and-ack",
               "src/APP/app_messageSlave.c#ProtoEmb_onWrite_gauge_length",
               "a request to zero gauge length, then a request to zero force");
    VIBES_EXPECT("zero-points-latched", "each zero point is latched exactly once");
    VIBES_EXPECT("each-acknowledged", "each request is acknowledged");
    TEST_ASSERT_EQUAL_INT(PROTOEMB_RUNTIME_WRITE_DISPOSITION_ACK, ProtoEmb_onWrite_gauge_length());
    TEST_ASSERT_EQUAL_INT(1, d_setLenCount);
    TEST_ASSERT_EQUAL_INT(PROTOEMB_RUNTIME_WRITE_DISPOSITION_ACK, ProtoEmb_onWrite_gauge_force());
    TEST_ASSERT_EQUAL_INT(1, d_setForceCount);
}

void test_onWrite_manual_move_fills_and_forwards(void)
{
    VIBES_TEST("bridge.jog-carries-target-speed-pause",
               "src/APP/app_messageSlave.c#ProtoEmb_onWrite_manual_move",
               "a jog with a target, a speed and a pause, first accepted, then turned down with motion on and again with motion off");
    VIBES_EXPECT("values-carried", "the target, speed and pause reach the machine unchanged");
    VIBES_EXPECT("accepted-acknowledged", "the jog is acknowledged when the machine accepts it");
    VIBES_EXPECT("turned-down-refused", "a jog turned down with motion on is refused, naming the machine as busy");
    VIBES_EXPECT("motion-off-refused", "a jog turned down with motion off is refused, naming motion being off as the reason");
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
    d_motionEnabled = true;
    TEST_ASSERT_EQUAL_INT(PROTOEMB_RUNTIME_WRITE_DISPOSITION_NACK_BUSY, ProtoEmb_onWrite_manual_move(&in));
    d_motionEnabled = false;
    TEST_ASSERT_EQUAL_INT(PROTOEMB_RUNTIME_WRITE_DISPOSITION_NACK_MOTION_DISABLED, ProtoEmb_onWrite_manual_move(&in));
}

void test_onWrite_test_move_pushes_to_sd(void)
{
    VIBES_TEST("bridge.test-move-stored-on-card",
               "src/APP/app_messageSlave.c#ProtoEmb_onWrite_test_move",
               "a motion-program move offered twice, first with room on the card, then with the card full");
    VIBES_EXPECT("move-stored", "the first move reaches the card with its target unchanged");
    VIBES_EXPECT("stored-acknowledged", "the stored move is acknowledged");
    VIBES_EXPECT("full-card-refused", "the move offered to the full card is refused, naming the card's full write queue as the reason");
    ProtoEmb_Move_t in;
    memset(&in, 0, sizeof(in));
    in.g = (ProtoEmb_GCode_E)1; in.x = 99;
    d_sdPushRet = true;
    TEST_ASSERT_EQUAL_INT(PROTOEMB_RUNTIME_WRITE_DISPOSITION_ACK, ProtoEmb_onWrite_test_move(&in));
    TEST_ASSERT_EQUAL_INT32(99, d_lastSdPush.x);
    d_sdPushRet = false;
    TEST_ASSERT_EQUAL_INT(PROTOEMB_RUNTIME_WRITE_DISPOSITION_NACK_SD_QUEUE_FULL, ProtoEmb_onWrite_test_move(&in));
}

void test_onWrite_sample_profile_maps_and_forwards(void)
{
    VIBES_TEST("bridge.sample-profile-write-loads-limits",
               "src/APP/app_messageSlave.c#ProtoEmb_onWrite_sample_profile_write",
               "a sample profile written with force and extension limits");
    VIBES_EXPECT("limits-loaded", "the machine loads those limits exactly once");
    VIBES_EXPECT("write-acknowledged", "the write is acknowledged");
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
    VIBES_TEST("bridge.start-test-while-idle-starts-only",
               "src/APP/app_messageSlave.c#ProtoEmb_onWrite_test_run",
               "a request to start a named test while no test session is under way");
    VIBES_EXPECT_WHY("no-stop",
                     "no stop is issued",
                     "only a session that is actually under way is stopped before a new test starts");
    VIBES_EXPECT("test-started", "the test starts once, under its program and run names");
    VIBES_EXPECT("request-acknowledged", "the request is acknowledged");
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
    VIBES_TEST("bridge.start-test-while-busy-stops-then-starts",
               "src/APP/app_messageSlave.c#ProtoEmb_onWrite_test_run",
               "a request to start a named test while a session is still busy");
    VIBES_EXPECT_WHY("session-stopped",
                     "the busy session is stopped once",
                     "a new test replaces the one already under way, and waits until that one has finished stopping");
    VIBES_EXPECT("new-test-started", "the new test then starts under its program and run names");
    VIBES_EXPECT("request-acknowledged", "the request is acknowledged");
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
    VIBES_TEST("bridge.start-test-refused-when-machine-rejects",
               "src/APP/app_messageSlave.c#ProtoEmb_onWrite_test_run",
               "a request to start a test while idle with motion on, with the machine turning the start down");
    VIBES_EXPECT_WHY("request-refused",
                     "the request is refused, naming the machine as busy",
                     "the control app has to see the refusal so a test is not shown as running");
    VIBES_EXPECT("no-stop", "no stop is issued");
    VIBES_EXPECT("start-offered-once", "the start is put to the machine once");
    d_isBusy = false;
    d_busyUntilEnd = false;
    d_startRet = false; /* firmware rejects the start (e.g. still busy race) */
    d_motionEnabled = true;
    ProtoEmb_TestRun_t in;
    memset(&in, 0, sizeof(in));
    memcpy(in.gcodeId, "gc0003", 6);
    memcpy(in.testDataId, "td0003", 6);
    TEST_ASSERT_EQUAL_INT(PROTOEMB_RUNTIME_WRITE_DISPOSITION_NACK_BUSY, ProtoEmb_onWrite_test_run(&in));
    TEST_ASSERT_EQUAL_INT(0, d_endCount);
    TEST_ASSERT_EQUAL_INT(1, d_startCount);
}

void test_onWrite_test_run_refused_with_motion_off(void)
{
    VIBES_TEST("bridge.start-test-refused-with-motion-off",
               "src/APP/app_messageSlave.c#ProtoEmb_onWrite_test_run",
               "a request to start a test while motion is off");
    VIBES_EXPECT_WHY("motion-off-named",
                     "the request is refused, naming motion being off as the reason",
                     "the operator can act on that reason: turn motion on and start again");
    d_isBusy = false;
    d_busyUntilEnd = false;
    d_startRet = false;
    d_motionEnabled = false;
    ProtoEmb_TestRun_t in;
    memset(&in, 0, sizeof(in));
    memcpy(in.gcodeId, "gc0004", 6);
    memcpy(in.testDataId, "td0004", 6);
    TEST_ASSERT_EQUAL_INT(PROTOEMB_RUNTIME_WRITE_DISPOSITION_NACK_MOTION_DISABLED, ProtoEmb_onWrite_test_run(&in));
}

void test_onWriteRaw_wrong_size_payloads_name_the_size(void)
{
    VIBES_TEST("bridge.wrong-size-payload-refused-as-bad-size",
               "src/APP/app_messageSlave.c#ProtoEmb_onWriteRaw_test_waveform",
               "a waveform, a configuration, a jog, a sample profile and a test start, each sent with the wrong number of bytes, and a program upload with none");
    VIBES_EXPECT_WHY("each-named-bad-size",
                     "each is refused, naming the payload size as the reason",
                     "a control app built from a different protocol layout sends payloads of the wrong size, and the reason says so");
    const uint8_t bytes[3] = { 1U, 2U, 3U };
    TEST_ASSERT_EQUAL_INT(PROTOEMB_RUNTIME_WRITE_DISPOSITION_NACK_BAD_SIZE, ProtoEmb_onWriteRaw_test_waveform(bytes, sizeof(bytes)));
    TEST_ASSERT_EQUAL_INT(PROTOEMB_RUNTIME_WRITE_DISPOSITION_NACK_BAD_SIZE, ProtoEmb_onWriteRaw_machine_configuration_write(bytes, sizeof(bytes)));
    TEST_ASSERT_EQUAL_INT(PROTOEMB_RUNTIME_WRITE_DISPOSITION_NACK_BAD_SIZE, ProtoEmb_onWriteRaw_manual_move(bytes, sizeof(bytes)));
    TEST_ASSERT_EQUAL_INT(PROTOEMB_RUNTIME_WRITE_DISPOSITION_NACK_BAD_SIZE, ProtoEmb_onWriteRaw_sample_profile_write(bytes, sizeof(bytes)));
    TEST_ASSERT_EQUAL_INT(PROTOEMB_RUNTIME_WRITE_DISPOSITION_NACK_BAD_SIZE, ProtoEmb_onWriteRaw_test_run(bytes, sizeof(bytes)));
    TEST_ASSERT_EQUAL_INT(PROTOEMB_RUNTIME_WRITE_DISPOSITION_NACK_BAD_SIZE, ProtoEmb_onWriteRaw_test_move(bytes, 0U));
}

void test_m5_onWrite_manual_move_nacks_when_busy(void)
{
    /* same as bridge.jog-carries-target-speed-pause: a jog the machine turns down is refused */
    d_addMoveRet = false; /* addManualMove rejects while busy */
    d_motionEnabled = true;
    ProtoEmb_Move_t in;
    memset(&in, 0, sizeof(in));
    in.g = (ProtoEmb_GCode_E)1;
    in.x = 10;
    in.f = 5;
    TEST_ASSERT_EQUAL_INT(PROTOEMB_RUNTIME_WRITE_DISPOSITION_NACK_BUSY, ProtoEmb_onWrite_manual_move(&in));
}

void test_servo_gains_round_trip_through_bridge(void)
{
    VIBES_TEST("bridge.servo-gains-saved-and-read-back",
               "src/APP/app_messageSlave.c#ProtoEmb_onWrite_machine_configuration_write",
               "a machine configuration written with a servo proportional gain of 12.5 per second and an integral gain of 40 per second squared");
    VIBES_EXPECT("gains-read-back", "reading the profile back returns both gains unchanged");
    VIBES_EXPECT("enable-polarity-read-back",
                 "a drive enable polarity of active low written with them reads back unchanged");
    ProtoEmb_MachineConfiguration_t in;
    memset(&in, 0, sizeof(in));
    in.servoStepsPerMM = 200;
    in.servoKp = 12500;
    in.servoKi = 40000;
    in.servoEnableActiveLow = 1;
    TEST_ASSERT_EQUAL_INT(PROTOEMB_RUNTIME_WRITE_DISPOSITION_ACK, ProtoEmb_onWrite_machine_configuration_write(&in));
    ProtoEmb_MachineConfiguration_t out;
    TEST_ASSERT_TRUE(ProtoEmb_onRead_machine_configuration(&out));
    TEST_ASSERT_EQUAL_INT32(12500, out.servoKp);
    TEST_ASSERT_EQUAL_INT32(40000, out.servoKi);
    TEST_ASSERT_EQUAL_INT32(1, out.servoEnableActiveLow);
}

void test_sample_carries_the_commanded_position(void)
{
    VIBES_TEST("bridge.sample-carries-commanded-position",
               "src/APP/app_messageSlave.c#ProtoEmb_onRead_sample",
               "a move whose trajectory is at 1.5 mm on its way to a 4 mm target");
    VIBES_EXPECT_WHY("commanded-sent",
                     "the live sample carries the 1.5 mm the trajectory is at, beside the 4 mm target",
                     "the gap between where the machine is told to be and where it is, is the servo's following error");
    d_setpoint = 4000000;
    d_commanded = 1500000;
    ProtoEmb_Sample_t s;
    TEST_ASSERT_TRUE(ProtoEmb_onRead_sample(&s));
    TEST_ASSERT_EQUAL_INT32(1500000, s.machineCommanded);
    TEST_ASSERT_EQUAL_INT32(4000000, s.machineSetpoint);
}

void test_machine_configuration_round_trips_through_bridge(void)
{
    VIBES_TEST("bridge.machine-config-saved-and-read-back",
               "src/APP/app_messageSlave.c#ProtoEmb_onWrite_machine_configuration_write",
               "a machine configuration written with steps per millimetre, travel, load-cell sensitivity and a name");
    VIBES_EXPECT_WHY("config-stored",
                     "the configuration is stored once",
                     "the saved profile is what the next boot will use");
    VIBES_EXPECT("operator-notified", "the operator is notified");
    VIBES_EXPECT("read-back-matches",
                 "reading the profile back returns the same steps per millimetre, travel, sensitivity and name");
    VIBES_EXPECT("write-acknowledged", "the write is acknowledged");
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

/* A download request: a 16-byte test name, then the first sample and how many. */
static uint16_t download_request(uint8_t *req)
{
    memset(req, 0, 24U);
    memcpy(req, "td0001", 6U);
    const uint32_t index = 0U;
    const uint32_t count = 4U;
    memcpy(&req[16], &index, sizeof(index));
    memcpy(&req[20], &count, sizeof(count));
    return 24U;
}

void test_onQuery_file_download_short_request_is_bad_size(void)
{
    VIBES_TEST("bridge.download-short-request-refused",
               "src/APP/app_messageSlave.c#ProtoEmb_onQuery_file_download",
               "a request for a test's samples that stops before saying how many samples it wants");
    VIBES_EXPECT("named-bad-size", "the request is refused, naming the payload size as the reason");
    uint8_t req[24];
    uint8_t out[64];
    uint16_t outSize = 0U;
    (void)download_request(req);
    TEST_ASSERT_EQUAL_INT(PROTOEMB_RUNTIME_QUERY_DISPOSITION_NACK_BAD_SIZE, ProtoEmb_onQuery_file_download(req, 20U, out, &outSize));
    TEST_ASSERT_EQUAL_UINT16(0U, outSize);
}

void test_onQuery_file_download_while_file_still_written_is_sd_busy(void)
{
    VIBES_TEST("bridge.download-while-saving-refused-as-busy",
               "src/APP/app_messageSlave.c#ProtoEmb_onQuery_file_download",
               "a request for a test's samples while the test is still writing its data file");
    VIBES_EXPECT_WHY("named-sd-busy",
                     "the request is refused, naming the data file as still being written",
                     "the condition passes on its own, and the control app asks again for exactly this reason");
    uint8_t req[24];
    uint8_t out[64];
    uint16_t outSize = 0U;
    d_readStatus = IO_SDCARD_READDIRECT_STATUS_BUSY;
    TEST_ASSERT_EQUAL_INT(PROTOEMB_RUNTIME_QUERY_DISPOSITION_NACK_SD_BUSY, ProtoEmb_onQuery_file_download(req, download_request(req), out, &outSize));
}

void test_onQuery_file_download_on_card_error_is_sd_read_failed(void)
{
    VIBES_TEST("bridge.download-card-error-refused",
               "src/APP/app_messageSlave.c#ProtoEmb_onQuery_file_download",
               "a request for a test's samples whose data file cannot be opened, and one whose file cannot be read at the asked sample");
    VIBES_EXPECT("named-read-failed", "each request is refused, naming the failed read of the data file as the reason");
    uint8_t req[24];
    uint8_t out[64];
    uint16_t outSize = 0U;
    d_readStatus = IO_SDCARD_READDIRECT_STATUS_FILE_ERROR;
    TEST_ASSERT_EQUAL_INT(PROTOEMB_RUNTIME_QUERY_DISPOSITION_NACK_SD_READ_FAILED, ProtoEmb_onQuery_file_download(req, download_request(req), out, &outSize));
    d_readStatus = IO_SDCARD_READDIRECT_STATUS_SEEK_ERROR;
    TEST_ASSERT_EQUAL_INT(PROTOEMB_RUNTIME_QUERY_DISPOSITION_NACK_SD_READ_FAILED, ProtoEmb_onQuery_file_download(req, download_request(req), out, &outSize));
}

void test_onWriteRaw_test_move_open_refused_is_sd_open_failed(void)
{
    VIBES_TEST("bridge.program-open-refused",
               "src/APP/app_messageSlave.c#ProtoEmb_onWriteRaw_test_move",
               "the start of a program upload, naming the program file, with the card refusing to open it");
    VIBES_EXPECT_WHY("named-open-failed",
                     "the upload is refused, naming the program file that could not be opened as the reason",
                     "opening the file is the first step of every upload, so this reason tells a failed upload apart from a refused move");
    d_sdOpenRet = false;
    TEST_ASSERT_EQUAL_INT(PROTOEMB_RUNTIME_WRITE_DISPOSITION_NACK_SD_OPEN_FAILED, ProtoEmb_onWriteRaw_test_move((const uint8_t *)"gc0001", 6U));
    d_sdOpenRet = true;
    TEST_ASSERT_EQUAL_INT(PROTOEMB_RUNTIME_WRITE_DISPOSITION_ACK, ProtoEmb_onWriteRaw_test_move((const uint8_t *)"gc0001", 6U));
}

void test_program_records_to_full_card_are_sd_queue_full(void)
{
    VIBES_TEST("bridge.program-records-refused-on-full-card",
               "src/APP/app_messageSlave.c#ProtoEmb_onWrite_test_waveform",
               "a waveform and a batch of two moves offered to the card while its write queue is full");
    VIBES_EXPECT("waveform-named-queue-full", "the waveform is refused, naming the card's full write queue as the reason");
    VIBES_EXPECT("batch-named-queue-full", "the batch is refused, naming the card's full write queue as the reason");
    d_sdPushRet = false;
    ProtoEmb_WaveformMove_t wave;
    memset(&wave, 0, sizeof(wave));
    TEST_ASSERT_EQUAL_INT(PROTOEMB_RUNTIME_WRITE_DISPOSITION_NACK_SD_QUEUE_FULL, ProtoEmb_onWrite_test_waveform(&wave));
    uint8_t batch[2U * PROTOEMB_MOVE_WIRE_SIZE];
    memset(batch, 0, sizeof(batch));
    TEST_ASSERT_EQUAL_INT(PROTOEMB_RUNTIME_WRITE_DISPOSITION_NACK_SD_QUEUE_FULL, ProtoEmb_onWriteRaw_test_move(batch, (uint16_t)sizeof(batch)));
}

int main(void)
{
    UNITY_BEGIN();
    RUN_TEST(test_onRead_state_maps_app_control);
    RUN_TEST(test_onRead_firmware_version_default);
    RUN_TEST(test_onRead_device_info_reports_protocol);
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
    RUN_TEST(test_onWrite_test_run_refused_with_motion_off);
    RUN_TEST(test_onWriteRaw_wrong_size_payloads_name_the_size);
    RUN_TEST(test_onQuery_file_download_short_request_is_bad_size);
    RUN_TEST(test_onQuery_file_download_while_file_still_written_is_sd_busy);
    RUN_TEST(test_onQuery_file_download_on_card_error_is_sd_read_failed);
    RUN_TEST(test_onWriteRaw_test_move_open_refused_is_sd_open_failed);
    RUN_TEST(test_program_records_to_full_card_are_sd_queue_full);
    RUN_TEST(test_m5_onWrite_manual_move_nacks_when_busy);
    RUN_TEST(test_machine_configuration_round_trips_through_bridge);
    RUN_TEST(test_servo_gains_round_trip_through_bridge);
    RUN_TEST(test_sample_carries_the_commanded_position);
    return UNITY_END();
}
