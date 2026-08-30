/**
 * @file protoemb_runtime.c
 * @brief Auto-generated ProtoEmb C runtime callbacks + framing — DO NOT EDIT
 */

#include "protoemb_runtime.h"

#include <string.h>

#define PROTOEMB_FRAME_SYNC (0x55U)
#define PROTOEMB_FRAME_TYPE_READ_OR_NACK (0x00U)
#define PROTOEMB_FRAME_TYPE_WRITE_OR_ACK (0x01U)
#define PROTOEMB_FRAME_TYPE_DATA (0x02U)
#define PROTOEMB_FRAME_TYPE_NOTIFICATION (0x03U)

static uint8_t ProtoEmb_Runtime_crc8(const uint8_t *data, uint16_t len)
{
    uint8_t crc = 0U;
    for (uint16_t i = 0U; i < len; i++)
    {
        uint8_t inbyte = data[i];
        for (uint8_t j = 0U; j < 8U; j++)
        {
            const uint8_t mix = (uint8_t)((crc ^ inbyte) & 0x01U);
            crc >>= 1U;
            if (mix != 0U)
            {
                crc ^= 0x8CU;
            }
            inbyte >>= 1U;
        }
    }
    return crc;
}

static void ProtoEmb_Runtime_reset(ProtoEmb_Runtime_t *runtime)
{
    runtime->state = PROTOEMB_RUNTIME_STATE_SYNC;
    runtime->payloadLength = 0U;
    runtime->payloadIndex = 0U;
}

static bool ProtoEmb_Runtime_sendFrame(ProtoEmb_Runtime_t *runtime,
                                           uint8_t frameType,
                                           uint8_t command,
                                           const uint8_t *payload,
                                           uint16_t payloadSize)
{
    if (runtime == NULL)
    {
        return false;
    }

    if ((payloadSize > 0U) && (payload == NULL))
    {
        return false;
    }

    if (payloadSize > PROTOEMB_RUNTIME_MAX_PAYLOAD)
    {
        return false;
    }

    if ((frameType == PROTOEMB_FRAME_TYPE_READ_OR_NACK) || (frameType == PROTOEMB_FRAME_TYPE_WRITE_OR_ACK))
    {
        const uint8_t frame[3] = { PROTOEMB_FRAME_SYNC, frameType, command };
        return ProtoEmb_sendBytes(frame, 3U);
    }

    {
        const uint8_t header[5] = {
            PROTOEMB_FRAME_SYNC,
            frameType,
            command,
            (uint8_t)(payloadSize & 0xFFU),
            (uint8_t)((payloadSize >> 8U) & 0xFFU),
        };
        const uint8_t crc = ProtoEmb_Runtime_crc8(payload, payloadSize);
        bool ok = ProtoEmb_sendBytes(header, 5U);
        if (ok && (payloadSize > 0U))
        {
            ok = ProtoEmb_sendBytes(payload, payloadSize);
        }
        if (ok)
        {
            ok = ProtoEmb_sendBytes(&crc, 1U);
        }
        return ok;
    }
}

static bool ProtoEmb_Runtime_sendAck(ProtoEmb_Runtime_t *runtime, uint8_t command)
{
    return ProtoEmb_Runtime_sendFrame(runtime, PROTOEMB_FRAME_TYPE_WRITE_OR_ACK, command, NULL, 0U);
}

static bool ProtoEmb_Runtime_sendNack(ProtoEmb_Runtime_t *runtime, uint8_t command)
{
    return ProtoEmb_Runtime_sendFrame(runtime, PROTOEMB_FRAME_TYPE_READ_OR_NACK, command, NULL, 0U);
}

static bool ProtoEmb_Runtime_sendData(ProtoEmb_Runtime_t *runtime, uint8_t command, const uint8_t *payload, uint16_t payloadSize)
{
    return ProtoEmb_Runtime_sendFrame(runtime, PROTOEMB_FRAME_TYPE_DATA, command, payload, payloadSize);
}

/* Handler implementations are intentionally NOT generated here. The header
 * declares every onRead/onWrite/onQuery/fill_notification callback; each consumer (app,
 * SIL, tests) MUST provide the definitions. No weak defaults — the P2 toolchain
 * (FlexC) does not resolve weak overrides, and forcing definitions makes an
 * unhandled protocol message a link error rather than a silent NACK. */

static void ProtoEmb_Runtime_applyWriteDisposition(ProtoEmb_Runtime_t *runtime,
                                                       uint8_t command,
                                                       ProtoEmb_RuntimeWriteDisposition_E disposition)
{
    switch (disposition)
    {
    case PROTOEMB_RUNTIME_WRITE_DISPOSITION_ACK:
        (void)ProtoEmb_Runtime_sendAck(runtime, command);
        break;
    case PROTOEMB_RUNTIME_WRITE_DISPOSITION_NACK:
    default:
        (void)ProtoEmb_Runtime_sendNack(runtime, command);
        break;
    }
}

static void ProtoEmb_Runtime_applyQueryDisposition(ProtoEmb_Runtime_t *runtime,
                                                       uint8_t command,
                                                       ProtoEmb_RuntimeQueryDisposition_E disposition,
                                                       const uint8_t *outPayload,
                                                       uint16_t outSize)
{
    switch (disposition)
    {
    case PROTOEMB_RUNTIME_QUERY_DISPOSITION_DATA:
        (void)ProtoEmb_Runtime_sendData(runtime, command, outPayload, outSize);
        break;
    case PROTOEMB_RUNTIME_QUERY_DISPOSITION_NACK:
    default:
        (void)ProtoEmb_Runtime_sendNack(runtime, command);
        break;
    }
}

static void ProtoEmb_Runtime_dispatchRead(ProtoEmb_Runtime_t *runtime, uint8_t command)
{
    switch (command)
    {
    case PROTOEMB_MSG_READ_SAMPLE:
    {
        ProtoEmb_Sample_t response;
        uint8_t payload[PROTOEMB_SAMPLE_WIRE_SIZE];
        (void)memset(&response, 0, sizeof(response));
        if (ProtoEmb_onRead_sample(&response))
        {
            ProtoEmb_Sample_encode(payload, &response);
            (void)ProtoEmb_Runtime_sendData(runtime, command, payload, PROTOEMB_SAMPLE_WIRE_SIZE);
        }
        else
        {
            (void)ProtoEmb_Runtime_sendNack(runtime, command);
        }
        break;
    }
    case PROTOEMB_MSG_READ_STATE:
    {
        ProtoEmb_MachineState_t response;
        uint8_t payload[PROTOEMB_MACHINESTATE_WIRE_SIZE];
        (void)memset(&response, 0, sizeof(response));
        if (ProtoEmb_onRead_state(&response))
        {
            ProtoEmb_MachineState_encode(payload, &response);
            (void)ProtoEmb_Runtime_sendData(runtime, command, payload, PROTOEMB_MACHINESTATE_WIRE_SIZE);
        }
        else
        {
            (void)ProtoEmb_Runtime_sendNack(runtime, command);
        }
        break;
    }
    case PROTOEMB_MSG_READ_MACHINE_CONFIGURATION:
    {
        ProtoEmb_MachineConfiguration_t response;
        uint8_t payload[PROTOEMB_MACHINECONFIGURATION_WIRE_SIZE];
        (void)memset(&response, 0, sizeof(response));
        if (ProtoEmb_onRead_machine_configuration(&response))
        {
            ProtoEmb_MachineConfiguration_encode(payload, &response);
            (void)ProtoEmb_Runtime_sendData(runtime, command, payload, PROTOEMB_MACHINECONFIGURATION_WIRE_SIZE);
        }
        else
        {
            (void)ProtoEmb_Runtime_sendNack(runtime, command);
        }
        break;
    }
    case PROTOEMB_MSG_READ_FIRMWARE_VERSION:
    {
        ProtoEmb_FirmwareVersion_t response;
        uint8_t payload[PROTOEMB_FIRMWAREVERSION_WIRE_SIZE];
        (void)memset(&response, 0, sizeof(response));
        if (ProtoEmb_onRead_firmware_version(&response))
        {
            ProtoEmb_FirmwareVersion_encode(payload, &response);
            (void)ProtoEmb_Runtime_sendData(runtime, command, payload, PROTOEMB_FIRMWAREVERSION_WIRE_SIZE);
        }
        else
        {
            (void)ProtoEmb_Runtime_sendNack(runtime, command);
        }
        break;
    }
    case PROTOEMB_MSG_READ_SAMPLE_PROFILE:
    {
        ProtoEmb_SampleProfile_t response;
        uint8_t payload[PROTOEMB_SAMPLEPROFILE_WIRE_SIZE];
        (void)memset(&response, 0, sizeof(response));
        if (ProtoEmb_onRead_sample_profile(&response))
        {
            ProtoEmb_SampleProfile_encode(payload, &response);
            (void)ProtoEmb_Runtime_sendData(runtime, command, payload, PROTOEMB_SAMPLEPROFILE_WIRE_SIZE);
        }
        else
        {
            (void)ProtoEmb_Runtime_sendNack(runtime, command);
        }
        break;
    }
    default:
        (void)ProtoEmb_Runtime_sendNack(runtime, command);
        break;
    }
}

static void ProtoEmb_Runtime_dispatchWrite(ProtoEmb_Runtime_t *runtime,
                                               uint8_t command,
                                               const uint8_t *payload,
                                               uint16_t payloadSize)
{
    uint8_t outPayload[PROTOEMB_RUNTIME_MAX_PAYLOAD];
    uint16_t outSize = 0U;

    switch (command)
    {
    case PROTOEMB_MSG_WRITE_MACHINE_CONFIGURATION_WRITE:
    {
        if (payloadSize == PROTOEMB_MACHINECONFIGURATION_WIRE_SIZE)
        {
            ProtoEmb_MachineConfiguration_t request;
            (void)memset(&request, 0, sizeof(request));
            ProtoEmb_MachineConfiguration_decode(payload, &request);
            ProtoEmb_Runtime_applyWriteDisposition(runtime,
                                                      command,
                                                      ProtoEmb_onWrite_machine_configuration_write(&request));
            break;
        }
        ProtoEmb_Runtime_applyWriteDisposition(runtime,
                                                  command,
                                                  ProtoEmb_onWriteRaw_machine_configuration_write(payload, payloadSize));
        break;
    }
    case PROTOEMB_MSG_WRITE_MOTION_ENABLE:
    {
        if (payloadSize >= 1U)
        {
            ProtoEmb_Runtime_applyWriteDisposition(runtime,
                                                      command,
                                                      ProtoEmb_onWrite_motion_enable(payload[0] != 0U));
        }
        else
        {
            (void)ProtoEmb_Runtime_sendNack(runtime, command);
        }
        break;
    }
    case PROTOEMB_MSG_WRITE_TEST_RUN:
    {
        if (payloadSize == PROTOEMB_TESTRUN_WIRE_SIZE)
        {
            ProtoEmb_TestRun_t request;
            (void)memset(&request, 0, sizeof(request));
            ProtoEmb_TestRun_decode(payload, &request);
            ProtoEmb_Runtime_applyWriteDisposition(runtime,
                                                      command,
                                                      ProtoEmb_onWrite_test_run(&request));
            break;
        }
        ProtoEmb_Runtime_applyWriteDisposition(runtime,
                                                  command,
                                                  ProtoEmb_onWriteRaw_test_run(payload, payloadSize));
        break;
    }
    case PROTOEMB_MSG_WRITE_MANUAL_MOVE:
    {
        if (payloadSize == PROTOEMB_MOVE_WIRE_SIZE)
        {
            ProtoEmb_Move_t request;
            (void)memset(&request, 0, sizeof(request));
            ProtoEmb_Move_decode(payload, &request);
            ProtoEmb_Runtime_applyWriteDisposition(runtime,
                                                      command,
                                                      ProtoEmb_onWrite_manual_move(&request));
            break;
        }
        ProtoEmb_Runtime_applyWriteDisposition(runtime,
                                                  command,
                                                  ProtoEmb_onWriteRaw_manual_move(payload, payloadSize));
        break;
    }
    case PROTOEMB_MSG_WRITE_TEST_MOVE:
    {
        if (payloadSize == PROTOEMB_MOVE_WIRE_SIZE)
        {
            ProtoEmb_Move_t request;
            (void)memset(&request, 0, sizeof(request));
            ProtoEmb_Move_decode(payload, &request);
            ProtoEmb_Runtime_applyWriteDisposition(runtime,
                                                      command,
                                                      ProtoEmb_onWrite_test_move(&request));
            break;
        }
        ProtoEmb_Runtime_applyWriteDisposition(runtime,
                                                  command,
                                                  ProtoEmb_onWriteRaw_test_move(payload, payloadSize));
        break;
    }
    case PROTOEMB_MSG_WRITE_SAMPLE_PROFILE_WRITE:
    {
        if (payloadSize == PROTOEMB_SAMPLEPROFILE_WIRE_SIZE)
        {
            ProtoEmb_SampleProfile_t request;
            (void)memset(&request, 0, sizeof(request));
            ProtoEmb_SampleProfile_decode(payload, &request);
            ProtoEmb_Runtime_applyWriteDisposition(runtime,
                                                      command,
                                                      ProtoEmb_onWrite_sample_profile_write(&request));
            break;
        }
        ProtoEmb_Runtime_applyWriteDisposition(runtime,
                                                  command,
                                                  ProtoEmb_onWriteRaw_sample_profile_write(payload, payloadSize));
        break;
    }
    case PROTOEMB_MSG_WRITE_GAUGE_LENGTH:
    {
        if (payloadSize == 0U)
        {
            ProtoEmb_Runtime_applyWriteDisposition(runtime,
                                                      command,
                                                      ProtoEmb_onWrite_gauge_length());
        }
        else
        {
            (void)ProtoEmb_Runtime_sendNack(runtime, command);
        }
        break;
    }
    case PROTOEMB_MSG_WRITE_GAUGE_FORCE:
    {
        if (payloadSize == 0U)
        {
            ProtoEmb_Runtime_applyWriteDisposition(runtime,
                                                      command,
                                                      ProtoEmb_onWrite_gauge_force());
        }
        else
        {
            (void)ProtoEmb_Runtime_sendNack(runtime, command);
        }
        break;
    }
    case PROTOEMB_MSG_WRITE_TEST_WAVEFORM:
    {
        if (payloadSize == PROTOEMB_WAVEFORMMOVE_WIRE_SIZE)
        {
            ProtoEmb_WaveformMove_t request;
            (void)memset(&request, 0, sizeof(request));
            ProtoEmb_WaveformMove_decode(payload, &request);
            ProtoEmb_Runtime_applyWriteDisposition(runtime,
                                                      command,
                                                      ProtoEmb_onWrite_test_waveform(&request));
            break;
        }
        ProtoEmb_Runtime_applyWriteDisposition(runtime,
                                                  command,
                                                  ProtoEmb_onWriteRaw_test_waveform(payload, payloadSize));
        break;
    }
    case PROTOEMB_MSG_WRITE_FILE_DOWNLOAD:
    {
    ProtoEmb_Runtime_applyQueryDisposition(runtime,
                          command,
                          ProtoEmb_onQuery_file_download(payload, payloadSize, outPayload, &outSize),
                          outPayload,
                          outSize);
        break;
    }
    default:
        (void)ProtoEmb_Runtime_sendNack(runtime, command);
        break;
    }
}

void ProtoEmb_Runtime_init(ProtoEmb_Runtime_t *runtime)
{
    if (runtime == NULL)
    {
        return;
    }

    (void)memset(runtime, 0, sizeof(*runtime));
    runtime->state = PROTOEMB_RUNTIME_STATE_SYNC;
    runtime->startMs = ProtoEmb_getTimeMs();
}

void ProtoEmb_Runtime_feedByte(ProtoEmb_Runtime_t *runtime, uint8_t byte)
{
    if (runtime == NULL)
    {
        return;
    }

    switch (runtime->state)
    {
    case PROTOEMB_RUNTIME_STATE_SYNC:
        if (byte == PROTOEMB_FRAME_SYNC)
        {
            runtime->state = PROTOEMB_RUNTIME_STATE_TYPE;
            runtime->startMs = ProtoEmb_getTimeMs();
        }
        break;

    case PROTOEMB_RUNTIME_STATE_TYPE:
        runtime->frameType = byte;
        if ((byte == PROTOEMB_FRAME_TYPE_READ_OR_NACK) || (byte == PROTOEMB_FRAME_TYPE_WRITE_OR_ACK))
        {
            runtime->state = PROTOEMB_RUNTIME_STATE_COMMAND;
        }
        else
        {
            ProtoEmb_Runtime_reset(runtime);
        }
        break;

    case PROTOEMB_RUNTIME_STATE_COMMAND:
        runtime->command = byte;
        if (runtime->frameType == PROTOEMB_FRAME_TYPE_READ_OR_NACK)
        {
            ProtoEmb_Runtime_dispatchRead(runtime, runtime->command);
            ProtoEmb_Runtime_reset(runtime);
        }
        else
        {
            runtime->state = PROTOEMB_RUNTIME_STATE_LENGTH_LO;
        }
        break;

    case PROTOEMB_RUNTIME_STATE_LENGTH_LO:
        runtime->payloadLength = (uint16_t)byte;
        runtime->state = PROTOEMB_RUNTIME_STATE_LENGTH_HI;
        break;

    case PROTOEMB_RUNTIME_STATE_LENGTH_HI:
        runtime->payloadLength = (uint16_t)(runtime->payloadLength | ((uint16_t)byte << 8U));
        runtime->payloadIndex = 0U;
        if (runtime->payloadLength > PROTOEMB_RUNTIME_MAX_PAYLOAD)
        {
            ProtoEmb_Runtime_reset(runtime);
        }
        else if (runtime->payloadLength == 0U)
        {
            runtime->state = PROTOEMB_RUNTIME_STATE_CRC;
        }
        else
        {
            runtime->state = PROTOEMB_RUNTIME_STATE_DATA;
        }
        break;

    case PROTOEMB_RUNTIME_STATE_DATA:
        if (runtime->payloadIndex < PROTOEMB_RUNTIME_MAX_PAYLOAD)
        {
            runtime->payload[runtime->payloadIndex] = byte;
            runtime->payloadIndex++;
            if (runtime->payloadIndex >= runtime->payloadLength)
            {
                runtime->state = PROTOEMB_RUNTIME_STATE_CRC;
            }
        }
        else
        {
            ProtoEmb_Runtime_reset(runtime);
        }
        break;

    case PROTOEMB_RUNTIME_STATE_CRC:
    {
        const uint8_t crc = ProtoEmb_Runtime_crc8(runtime->payload, runtime->payloadLength);
        if (crc == byte)
        {
            ProtoEmb_Runtime_dispatchWrite(runtime, runtime->command, runtime->payload, runtime->payloadLength);
        }
        else
        {
            (void)ProtoEmb_Runtime_sendNack(runtime, runtime->command);
        }
        ProtoEmb_Runtime_reset(runtime);
        break;
    }

    default:
        ProtoEmb_Runtime_reset(runtime);
        break;
    }
}

void ProtoEmb_Runtime_tick(ProtoEmb_Runtime_t *runtime)
{
    if (runtime == NULL)
    {
        return;
    }

    if (runtime->state == PROTOEMB_RUNTIME_STATE_SYNC)
    {
        return;
    }

    const uint32_t now = ProtoEmb_getTimeMs();
    if ((now - runtime->startMs) > PROTOEMB_RUNTIME_TIMEOUT_MS)
    {
        ProtoEmb_Runtime_reset(runtime);
    }
}

bool ProtoEmb_Runtime_sendNotification(ProtoEmb_Runtime_t *runtime, const ProtoEmb_Notification_t *notification)
{
    uint8_t payload[PROTOEMB_NOTIFICATION_WIRE_SIZE];
    if ((runtime == NULL) || (notification == NULL))
    {
        return false;
    }

    ProtoEmb_Notification_encode(payload, notification);
    return ProtoEmb_Runtime_sendFrame(runtime,
                                          PROTOEMB_FRAME_TYPE_NOTIFICATION,
                                          0U,
                                          payload,
                                          PROTOEMB_NOTIFICATION_WIRE_SIZE);
}

bool ProtoEmb_Runtime_sendNotificationFromCallback(ProtoEmb_Runtime_t *runtime)
{
    ProtoEmb_Notification_t notification;
    (void)memset(&notification, 0, sizeof(notification));
    if (!ProtoEmb_fill_notification(&notification))
    {
        return false;
    }
    return ProtoEmb_Runtime_sendNotification(runtime, &notification);
}
