/**
 * @file protoemb_runtime.h
 * @brief Auto-generated ProtoEmb C runtime callbacks + framing — DO NOT EDIT
 */
#ifndef PROTOEMB_RUNTIME_H
#define PROTOEMB_RUNTIME_H

#include <stdbool.h>
#include <stdint.h>
#include "protoemb.h"

#ifndef PROTOEMB_RUNTIME_MAX_PAYLOAD
#define PROTOEMB_RUNTIME_MAX_PAYLOAD 4096U
#endif

#ifndef PROTOEMB_RUNTIME_TIMEOUT_MS
#define PROTOEMB_RUNTIME_TIMEOUT_MS 100U
#endif

typedef enum
{
    PROTOEMB_RUNTIME_WRITE_DISPOSITION_NACK = 0,
    PROTOEMB_RUNTIME_WRITE_DISPOSITION_ACK = 1,
} ProtoEmb_RuntimeWriteDisposition_E;

typedef enum
{
    PROTOEMB_RUNTIME_QUERY_DISPOSITION_NACK = 0,
    PROTOEMB_RUNTIME_QUERY_DISPOSITION_DATA = 1,
} ProtoEmb_RuntimeQueryDisposition_E;

typedef enum
{
    PROTOEMB_RUNTIME_STATE_SYNC = 0,
    PROTOEMB_RUNTIME_STATE_TYPE,
    PROTOEMB_RUNTIME_STATE_COMMAND,
    PROTOEMB_RUNTIME_STATE_LENGTH_LO,
    PROTOEMB_RUNTIME_STATE_LENGTH_HI,
    PROTOEMB_RUNTIME_STATE_DATA,
    PROTOEMB_RUNTIME_STATE_CRC,
} ProtoEmb_RuntimeState_E;

typedef struct
{
    ProtoEmb_RuntimeState_E state;
    uint32_t startMs;
    uint8_t frameType;
    uint8_t command;
    uint16_t payloadLength;
    uint16_t payloadIndex;
    uint8_t payload[PROTOEMB_RUNTIME_MAX_PAYLOAD];
} ProtoEmb_Runtime_t;

/**
 * Initialize runtime state machine.
 */
void ProtoEmb_Runtime_init(ProtoEmb_Runtime_t *runtime);

/**
 * Feed one incoming byte from transport into parser/dispatcher.
 */
void ProtoEmb_Runtime_feedByte(ProtoEmb_Runtime_t *runtime, uint8_t byte);

/**
 * Call periodically to enforce parser timeout.
 */
void ProtoEmb_Runtime_tick(ProtoEmb_Runtime_t *runtime);

/**
 * Send async notification payload from a typed struct.
 */
bool ProtoEmb_Runtime_sendNotification(ProtoEmb_Runtime_t *runtime, const ProtoEmb_Notification_t *notification);

/**
 * Send an async notification using user callback fill stub.
 */
bool ProtoEmb_Runtime_sendNotificationFromCallback(ProtoEmb_Runtime_t *runtime);

/* ============================================================
 * User Callback Stubs (override in application)
 *
 * Semantic callbacks:
 *   - onRead_*: READ-frame providers (returns true/false)
 *   - onQuery_*: WRITE-frame queries (returns DATA/NACK)
 *   - onWrite_*: WRITE-frame commands (returns ACK/NACK)
 *
 * Transport + time are provided the same way (declared here, defined by the
 * application). They are plain extern functions, NOT registered function
 * pointers: the P2 FlexC toolchain encodes function pointers as method-table
 * indices and fails to dispatch them indirectly from inside this runtime, so
 * every callback uses direct linkage.
 * ============================================================ */
bool ProtoEmb_sendBytes(const uint8_t *data, uint16_t size);
uint32_t ProtoEmb_getTimeMs(void);

bool ProtoEmb_onRead_sample(ProtoEmb_Sample_t *out);
bool ProtoEmb_onRead_state(ProtoEmb_MachineState_t *out);
bool ProtoEmb_onRead_machine_configuration(ProtoEmb_MachineConfiguration_t *out);
bool ProtoEmb_onRead_firmware_version(ProtoEmb_FirmwareVersion_t *out);
bool ProtoEmb_onRead_sample_profile(ProtoEmb_SampleProfile_t *out);

ProtoEmb_RuntimeWriteDisposition_E ProtoEmb_onWrite_machine_configuration_write(const ProtoEmb_MachineConfiguration_t *in);
ProtoEmb_RuntimeWriteDisposition_E ProtoEmb_onWriteRaw_machine_configuration_write(const uint8_t *payload,
                                                                               uint16_t payloadSize);
ProtoEmb_RuntimeWriteDisposition_E ProtoEmb_onWrite_motion_enable(bool in);
ProtoEmb_RuntimeWriteDisposition_E ProtoEmb_onWrite_test_run(const ProtoEmb_TestRun_t *in);
ProtoEmb_RuntimeWriteDisposition_E ProtoEmb_onWriteRaw_test_run(const uint8_t *payload,
                                                                               uint16_t payloadSize);
ProtoEmb_RuntimeWriteDisposition_E ProtoEmb_onWrite_manual_move(const ProtoEmb_Move_t *in);
ProtoEmb_RuntimeWriteDisposition_E ProtoEmb_onWriteRaw_manual_move(const uint8_t *payload,
                                                                               uint16_t payloadSize);
ProtoEmb_RuntimeWriteDisposition_E ProtoEmb_onWrite_test_move(const ProtoEmb_Move_t *in);
ProtoEmb_RuntimeWriteDisposition_E ProtoEmb_onWriteRaw_test_move(const uint8_t *payload,
                                                                               uint16_t payloadSize);
ProtoEmb_RuntimeWriteDisposition_E ProtoEmb_onWrite_sample_profile_write(const ProtoEmb_SampleProfile_t *in);
ProtoEmb_RuntimeWriteDisposition_E ProtoEmb_onWriteRaw_sample_profile_write(const uint8_t *payload,
                                                                               uint16_t payloadSize);
ProtoEmb_RuntimeWriteDisposition_E ProtoEmb_onWrite_gauge_length(void);
ProtoEmb_RuntimeWriteDisposition_E ProtoEmb_onWrite_gauge_force(void);
ProtoEmb_RuntimeWriteDisposition_E ProtoEmb_onWrite_test_waveform(const ProtoEmb_WaveformMove_t *in);
ProtoEmb_RuntimeWriteDisposition_E ProtoEmb_onWriteRaw_test_waveform(const uint8_t *payload,
                                                                               uint16_t payloadSize);
ProtoEmb_RuntimeQueryDisposition_E ProtoEmb_onQuery_file_download(const uint8_t *payload,
                                                                            uint16_t payloadSize,
                                                                            uint8_t *outPayload,
                                                                            uint16_t *outSize);

bool ProtoEmb_fill_notification(ProtoEmb_Notification_t *out);

#endif /* PROTOEMB_RUNTIME_H */
