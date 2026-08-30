//
// Created by Riley McCarthy on 25/04/24.
//
/**********************************************************************
 * Includes
 **********************************************************************/
#include <string.h>

#include "app_messageSlave.h"
#include "app_control.h"
#include "app_gauge.h"
#include "app_monitor.h"
#include "app_motion.h"
#include "app_notification.h"
#include "app_testManagement.h"

#include "dev_forceGauge.h"
#include "dev_nvram.h"

#include "HAL_lock.h"
#include "HAL_time.h"

#include "IO_Debug.h"
#include "IO_SDCard.h"
#include "IO_fullDuplexSerial.h"

#include "lib_utility.h"
#include "protoemb_runtime.h"

#ifdef FIRMWARE_VERSION
static const char *APP_MESSAGE_SLAVE_VERSION = FIRMWARE_VERSION;
#else
static const char *APP_MESSAGE_SLAVE_VERSION = "0.0.0";
#endif

#define APP_MESSAGESLAVE_LOCK_REQ() HAL_lock_try(app_message_slave_data.lock)
#define APP_MESSAGESLAVE_LOCK_REQ_BLOCK()        \
    while (APP_MESSAGESLAVE_LOCK_REQ() == false) \
    {                                            \
    }
#define APP_MESSAGESLAVE_LOCK_REL() HAL_lock_release(app_message_slave_data.lock)

typedef struct
{
    MachineProfile machineProfile;
    int lock;
    ProtoEmb_Runtime_t runtime;
    app_monitor_sample_t sampleReadBuffer[APP_MESSAGE_SLAVE_TX_BUFFER_SIZE / sizeof(app_monitor_sample_t)];
} app_message_slave_data_S;

static app_message_slave_data_S app_message_slave_data;

/* ProtoEmb runtime transport/time hooks — direct linkage (the runtime calls
 * these by name; FlexC mis-dispatches indirect function pointers from inside
 * the generated runtime, so no callback registration). */
bool ProtoEmb_sendBytes(const uint8_t *data, uint16_t size)
{
    return IO_fullDuplexSerial_send(IO_FULLDUPLEXSERIAL_CHANNEL_MAIN, data, size);
}

uint32_t ProtoEmb_getTimeMs(void)
{
    return HAL_time_getMs();
}

static void app_message_slave_copyMachineProfile(MachineProfile *dst)
{
    APP_MESSAGESLAVE_LOCK_REQ_BLOCK();
    memcpy(dst, &app_message_slave_data.machineProfile, sizeof(MachineProfile));
    APP_MESSAGESLAVE_LOCK_REL();
}

static void app_message_slave_setMachineProfile(const MachineProfile *src)
{
    APP_MESSAGESLAVE_LOCK_REQ_BLOCK();
    memcpy(&app_message_slave_data.machineProfile, src, sizeof(MachineProfile));
    APP_MESSAGESLAVE_LOCK_REL();
}

static void app_message_slave_fillMove(app_motion_move_t *dst, const ProtoEmb_Move_t *src)
{
    dst->g = (uint8_t)src->g;
    dst->x = src->x;
    dst->f = src->f;
    dst->p = src->p;
}

bool ProtoEmb_onRead_sample(ProtoEmb_Sample_t *out)
{
    (void)memset(out, 0, sizeof(*out));

    ProtoEmb_Sample_setMachineForce_raw(out, app_gauge_getForce(APP_GAUGE_COORD_MACHINE));
    ProtoEmb_Sample_setMachinePosition_raw(out, app_gauge_getPosition(APP_GAUGE_COORD_MACHINE));
    ProtoEmb_Sample_setMachineSetpoint_raw(out, app_motion_getSetpoint());
    ProtoEmb_Sample_setSampleForce_raw(out, app_gauge_getForce(APP_GAUGE_COORD_SAMPLE));
    ProtoEmb_Sample_setSamplePosition_raw(out, app_gauge_getPosition(APP_GAUGE_COORD_SAMPLE));

    return true;
}

bool ProtoEmb_onRead_state(ProtoEmb_MachineState_t *out)
{
    out->faultedReason = (ProtoEmb_FaultedReason_E)app_control_getFault();
    out->restrictedReason = (ProtoEmb_RestrictedReason_E)app_control_getRestriction();
    out->testRunning = app_testManagement_isRunning();
    out->motionEnabled = app_control_motionEnabled();
    return true;
}

bool ProtoEmb_onRead_machine_configuration(ProtoEmb_MachineConfiguration_t *out)
{
    MachineProfile profile;
    app_message_slave_copyMachineProfile(&profile);

    (void)memset(out, 0, sizeof(*out));
    out->encoderStepsPerMM = profile.encoderStepsPerMM;
    out->servoStepsPerMM = profile.servoStepsPerMM;
    out->loadCellCapacity = profile.loadCellCapacity;
    out->loadCellSensitivity = profile.loadCellSensitivity;
    out->loadCellZeroBalance = profile.loadCellZeroBalance;
    out->maxPosition = profile.maxPosition;
    out->maxVelocity = profile.maxVelocity;
    out->maxAcceleration = profile.maxAcceleration;
    out->maxForceTensile = profile.maxForceTensile;
    out->homingVelocity = profile.homingVelocity;
    out->homingOffset = profile.homingOffset;
    out->jawOffset = profile.jawOffset;
    memcpy(out->name, profile.name, DEV_NVRAM_MAX_MACHINE_PROFILE_NAME);
    DEBUG_INFO("%s", "responding with machine profile\n");
    return true;
}

bool ProtoEmb_onRead_firmware_version(ProtoEmb_FirmwareVersion_t *out)
{
    (void)memset(out, 0, sizeof(*out));
    strncpy(out->version, APP_MESSAGE_SLAVE_VERSION, sizeof(out->version) - 1U);
    return true;
}

bool ProtoEmb_onRead_sample_profile(ProtoEmb_SampleProfile_t *out)
{
    app_monitor_sampleProfile_S sampleProfile;
    app_monitor_getSampleProfile(&sampleProfile);

    out->maxForce = sampleProfile.maxForce;
    out->maxVelocity = sampleProfile.maxVelocity;
    out->maxDisplacement = sampleProfile.maxDisplacement;
    out->sampleWidth = sampleProfile.sampleWidth;
    out->sampleThickness = sampleProfile.sampleThickness;
    return true;
}

ProtoEmb_RuntimeWriteDisposition_E ProtoEmb_onWrite_machine_configuration_write(const ProtoEmb_MachineConfiguration_t *in)
{
    MachineProfile newProfile;
    memset(&newProfile, 0, sizeof(newProfile));
    memcpy(newProfile.name, in->name, DEV_NVRAM_MAX_MACHINE_PROFILE_NAME);
    newProfile.encoderStepsPerMM = in->encoderStepsPerMM;
    newProfile.servoStepsPerMM = in->servoStepsPerMM;
    newProfile.loadCellCapacity = in->loadCellCapacity;
    newProfile.loadCellSensitivity = in->loadCellSensitivity;
    newProfile.loadCellZeroBalance = in->loadCellZeroBalance;
    newProfile.maxPosition = in->maxPosition;
    newProfile.maxVelocity = in->maxVelocity;
    newProfile.maxAcceleration = in->maxAcceleration;
    newProfile.maxForceTensile = in->maxForceTensile;
    newProfile.homingVelocity = in->homingVelocity;
    newProfile.homingOffset = in->homingOffset;
    newProfile.jawOffset = in->jawOffset;

    dev_nvram_updateChannelData(DEV_NVRAM_CHANNEL_MACHINE_PROFILE, &newProfile, sizeof(MachineProfile));
    app_message_slave_setMachineProfile(&newProfile);
    app_notification_send(APP_NOTIFICATION_TYPE_SUCCESS, "Machine profile saved to SD Card, please reboot\n");
    return PROTOEMB_RUNTIME_WRITE_DISPOSITION_ACK;
}

ProtoEmb_RuntimeWriteDisposition_E ProtoEmb_onWrite_motion_enable(bool in)
{
    if (in)
    {
        return app_control_triggerMotionEnabled() ? PROTOEMB_RUNTIME_WRITE_DISPOSITION_ACK : PROTOEMB_RUNTIME_WRITE_DISPOSITION_NACK;
    }
    return app_control_triggerMotionDisabled() ? PROTOEMB_RUNTIME_WRITE_DISPOSITION_ACK : PROTOEMB_RUNTIME_WRITE_DISPOSITION_NACK;
}

ProtoEmb_RuntimeWriteDisposition_E ProtoEmb_onWrite_test_run(const ProtoEmb_TestRun_t *in)
{
    char gcodeId[sizeof(in->gcodeId) + 1U];
    char testDataId[sizeof(in->testDataId) + 1U];
    memset(gcodeId, 0, sizeof(gcodeId));
    memset(testDataId, 0, sizeof(testDataId));
    memcpy(gcodeId, in->gcodeId, sizeof(in->gcodeId));
    memcpy(testDataId, in->testDataId, sizeof(in->testDataId));

    /* Finish any prior test session before launching a new one. Only request END when
     * a session is active/busy; requesting END while IDLE can race a fresh START. */
    if (app_testManagement_isBusy())
    {
        (void)app_testManagement_triggerTestEnd();
    }
    while (app_testManagement_isBusy())
    {
    }

    app_monitor_setTestName(testDataId);
    return app_testManagement_triggerTestStart(gcodeId) ? PROTOEMB_RUNTIME_WRITE_DISPOSITION_ACK : PROTOEMB_RUNTIME_WRITE_DISPOSITION_NACK;
}

ProtoEmb_RuntimeWriteDisposition_E ProtoEmb_onWrite_manual_move(const ProtoEmb_Move_t *in)
{
    app_motion_move_t move;
    app_message_slave_fillMove(&move, in);
    return app_testManagement_addManualMove(&move) ? PROTOEMB_RUNTIME_WRITE_DISPOSITION_ACK : PROTOEMB_RUNTIME_WRITE_DISPOSITION_NACK;
}

ProtoEmb_RuntimeWriteDisposition_E ProtoEmb_onWrite_test_move(const ProtoEmb_Move_t *in)
{
    app_motion_move_t move;
    app_message_slave_fillMove(&move, in);
    return IO_SDCard_push(IO_SDCARD_CHANNEL_GCODE, &move, sizeof(app_motion_move_t)) ? PROTOEMB_RUNTIME_WRITE_DISPOSITION_ACK : PROTOEMB_RUNTIME_WRITE_DISPOSITION_NACK;
}

ProtoEmb_RuntimeWriteDisposition_E ProtoEmb_onWrite_test_waveform(const ProtoEmb_WaveformMove_t *in)
{
    /* A waveform is one G123 record on the GCODE channel, reusing the move
     * fields: x = amplitude (µm), p = cycles, f = (shape << 24) | freq-milli-Hz.
     * Interleaved with test_move records in program order, so the test stays
     * self-contained on SD and runs unattended. */
    app_motion_move_t move;
    move.g = (uint8_t)G123_WAVEFORM;
    move.x = in->amplitude;
    move.f = (int32_t)(((uint32_t)in->shape << 24) | ((uint32_t)in->frequency & 0x00FFFFFFU));
    move.p = in->cycles;
    return IO_SDCard_push(IO_SDCARD_CHANNEL_GCODE, &move, sizeof(app_motion_move_t)) ? PROTOEMB_RUNTIME_WRITE_DISPOSITION_ACK : PROTOEMB_RUNTIME_WRITE_DISPOSITION_NACK;
}

ProtoEmb_RuntimeWriteDisposition_E ProtoEmb_onWriteRaw_test_move(const uint8_t *payload,
                                                                 uint16_t payloadSize)
{
    if ((payloadSize > 0U) && ((payloadSize % PROTOEMB_MOVE_WIRE_SIZE) != 0U))
    {
        char gcodeId[7];
        memset(gcodeId, 0, sizeof(gcodeId));
        memcpy(gcodeId, payload, payloadSize < (sizeof(gcodeId) - 1U) ? payloadSize : (sizeof(gcodeId) - 1U));
        return IO_SDCard_open(IO_SDCARD_CHANNEL_GCODE, gcodeId, IO_SDCARD_MODE_WRITE) ? PROTOEMB_RUNTIME_WRITE_DISPOSITION_ACK : PROTOEMB_RUNTIME_WRITE_DISPOSITION_NACK;
    }

    if ((payloadSize > 0U) && ((payloadSize % PROTOEMB_MOVE_WIRE_SIZE) == 0U))
    {
        const uint32_t moveCount = payloadSize / PROTOEMB_MOVE_WIRE_SIZE;
        for (uint32_t i = 0U; i < moveCount; i++)
        {
            ProtoEmb_Move_t protoMove;
            app_motion_move_t move;
            ProtoEmb_Move_decode(&payload[i * PROTOEMB_MOVE_WIRE_SIZE], &protoMove);
            app_message_slave_fillMove(&move, &protoMove);
            if (!IO_SDCard_push(IO_SDCARD_CHANNEL_GCODE, &move, sizeof(app_motion_move_t)))
            {
                return PROTOEMB_RUNTIME_WRITE_DISPOSITION_NACK;
            }
        }
        return PROTOEMB_RUNTIME_WRITE_DISPOSITION_ACK;
    }

    return PROTOEMB_RUNTIME_WRITE_DISPOSITION_NACK;
}

ProtoEmb_RuntimeWriteDisposition_E ProtoEmb_onWrite_sample_profile_write(const ProtoEmb_SampleProfile_t *in)
{
    app_monitor_sampleProfile_S sampleProfile;
    sampleProfile.maxForce = in->maxForce;
    sampleProfile.maxVelocity = in->maxVelocity;
    sampleProfile.maxDisplacement = in->maxDisplacement;
    sampleProfile.sampleWidth = in->sampleWidth;
    sampleProfile.sampleThickness = in->sampleThickness;
    return app_monitor_setSampleProfile(&sampleProfile) ? PROTOEMB_RUNTIME_WRITE_DISPOSITION_ACK : PROTOEMB_RUNTIME_WRITE_DISPOSITION_NACK;
}

ProtoEmb_RuntimeWriteDisposition_E ProtoEmb_onWrite_gauge_length(void)
{
    app_gauge_setGaugeLength();
    return PROTOEMB_RUNTIME_WRITE_DISPOSITION_ACK;
}

ProtoEmb_RuntimeWriteDisposition_E ProtoEmb_onWrite_gauge_force(void)
{
    app_gauge_setGaugeForce();
    return PROTOEMB_RUNTIME_WRITE_DISPOSITION_ACK;
}

ProtoEmb_RuntimeQueryDisposition_E ProtoEmb_onQuery_file_download(const uint8_t *payload,
                                                                  uint16_t payloadSize,
                                                                  uint8_t *outPayload,
                                                                  uint16_t *outSize)
{
    const uint32_t headerSize = 16U + sizeof(uint32_t) + sizeof(uint32_t);
    *outSize = 0U;

    if (payloadSize < headerSize)
    {
        return PROTOEMB_RUNTIME_QUERY_DISPOSITION_NACK;
    }

    char testName[17];
    uint32_t sampleIndex = 0U;
    uint32_t sampleCount = 0U;
    memcpy(testName, payload, 16U);
    testName[16] = '\0';
    for (int i = 15; i >= 0; i--)
    {
        if ((testName[i] == '\0') || (testName[i] == ' '))
        {
            testName[i] = '\0';
        }
        else
        {
            break;
        }
    }
    memcpy(&sampleIndex, &payload[16], sizeof(uint32_t));
    memcpy(&sampleCount, &payload[20], sizeof(uint32_t));

    const uint32_t maxEncodedSamples = APP_MESSAGE_SLAVE_TX_BUFFER_SIZE / PROTOEMB_STOREDSAMPLE_WIRE_SIZE;
    const uint32_t maxBufferedSamples = sizeof(app_message_slave_data.sampleReadBuffer) / sizeof(app_message_slave_data.sampleReadBuffer[0]);
    const uint32_t readCount = LIB_UTILITY_MIN(sampleCount, LIB_UTILITY_MIN(maxEncodedSamples, maxBufferedSamples));

    IO_SDCard_readDirectStatus_E readStatus = IO_SDCARD_READDIRECT_STATUS_OK;
    const uint32_t itemsRead = IO_SDCard_readDirectEx(IO_SDCARD_CHANNEL_SAMPLE_DATA,
                                                      testName,
                                                      app_message_slave_data.sampleReadBuffer,
                                                      sampleIndex,
                                                      readCount,
                                                      &readStatus);

    if (readStatus != IO_SDCARD_READDIRECT_STATUS_OK)
    {
        return PROTOEMB_RUNTIME_QUERY_DISPOSITION_NACK;
    }

    for (uint32_t i = 0U; i < itemsRead; i++)
    {
        ProtoEmb_StoredSample_t sample;
        (void)memset(&sample, 0, sizeof(sample));
        ProtoEmb_StoredSample_setForce_raw(&sample, app_message_slave_data.sampleReadBuffer[i].force);
        ProtoEmb_StoredSample_setPosition_raw(&sample, app_message_slave_data.sampleReadBuffer[i].position);
        sample.time = app_message_slave_data.sampleReadBuffer[i].time;
        ProtoEmb_StoredSample_setSetpoint_raw(&sample, app_message_slave_data.sampleReadBuffer[i].setpoint);
        ProtoEmb_StoredSample_encode(&outPayload[i * PROTOEMB_STOREDSAMPLE_WIRE_SIZE], &sample);
    }

    *outSize = (uint16_t)(itemsRead * PROTOEMB_STOREDSAMPLE_WIRE_SIZE);
    return PROTOEMB_RUNTIME_QUERY_DISPOSITION_DATA;
}

/* Raw write fallbacks. The runtime dispatch only invokes onWriteRaw_* when an
 * incoming payload is NOT the message's fixed wire size. test_move uses this for
 * filename-open and batched moves (above); the commands below have no raw/batch
 * form, so a wrong-size payload is malformed → NACK. These were previously the
 * generated weak defaults; the runtime no longer emits defaults, so the app must
 * define every declared handler (a missing one is now a link error, not a silent
 * NACK). */
ProtoEmb_RuntimeWriteDisposition_E ProtoEmb_onWriteRaw_machine_configuration_write(const uint8_t *payload,
                                                                                   uint16_t payloadSize)
{
    (void)payload;
    (void)payloadSize;
    return PROTOEMB_RUNTIME_WRITE_DISPOSITION_NACK;
}

ProtoEmb_RuntimeWriteDisposition_E ProtoEmb_onWriteRaw_manual_move(const uint8_t *payload,
                                                                   uint16_t payloadSize)
{
    (void)payload;
    (void)payloadSize;
    return PROTOEMB_RUNTIME_WRITE_DISPOSITION_NACK;
}

ProtoEmb_RuntimeWriteDisposition_E ProtoEmb_onWriteRaw_sample_profile_write(const uint8_t *payload,
                                                                           uint16_t payloadSize)
{
    (void)payload;
    (void)payloadSize;
    return PROTOEMB_RUNTIME_WRITE_DISPOSITION_NACK;
}

ProtoEmb_RuntimeWriteDisposition_E ProtoEmb_onWriteRaw_test_run(const uint8_t *payload,
                                                               uint16_t payloadSize)
{
    (void)payload;
    (void)payloadSize;
    return PROTOEMB_RUNTIME_WRITE_DISPOSITION_NACK;
}

ProtoEmb_RuntimeWriteDisposition_E ProtoEmb_onWriteRaw_test_waveform(const uint8_t *payload,
                                                                     uint16_t payloadSize)
{
    (void)payload;
    (void)payloadSize;
    return PROTOEMB_RUNTIME_WRITE_DISPOSITION_NACK;
}

/* Pull-style notification fill is unused: the firmware pushes notifications
 * eagerly through app_messageSlave_sendNotification (ProtoEmb_Runtime_sendNotification).
 * Required to satisfy the runtime's handler contract. */
bool ProtoEmb_fill_notification(ProtoEmb_Notification_t *out)
{
    (void)out;
    return false;
}

void app_messageSlave_init(int lock)
{
    app_message_slave_data.lock = lock;
    dev_nvram_getChannelData(DEV_NVRAM_CHANNEL_MACHINE_PROFILE, &app_message_slave_data.machineProfile, sizeof(MachineProfile));
    ProtoEmb_Runtime_init(&app_message_slave_data.runtime);
}

void app_messageSlave_run(void)
{
    uint8_t byte = 0U;
    while (IO_fullDuplexSerial_available(IO_FULLDUPLEXSERIAL_CHANNEL_MAIN) > 0U)
    {
        if (IO_fullDuplexSerial_receive(IO_FULLDUPLEXSERIAL_CHANNEL_MAIN, &byte, 1U))
        {
            ProtoEmb_Runtime_feedByte(&app_message_slave_data.runtime, byte);
        }
    }
    ProtoEmb_Runtime_tick(&app_message_slave_data.runtime);
}

bool app_messageSlave_sendNotification(const ProtoEmb_Notification_t *notification)
{
    return ProtoEmb_Runtime_sendNotification(&app_message_slave_data.runtime, notification);
}
