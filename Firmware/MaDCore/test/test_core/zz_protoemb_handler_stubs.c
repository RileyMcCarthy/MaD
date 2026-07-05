/* Test-only default handlers for the ProtoEmb runtime.
 *
 * The generated runtime (compiled into this suite via test_protoemb.c) declares
 * every onRead/onWrite/onQuery/fill_notification callback and — by design — ships
 * NO weak defaults; each consumer MUST define them. test_core exercises the codec
 * and runtime framing, not the message handlers, so provide behaviour-neutral
 * defaults (read = no data, write/query = NACK, notification = none) purely so the
 * runtime links. This mirrors what the old weak defaults did.
 */
#include "protoemb.h"
#include "protoemb_runtime.h"

/* onRead: no data available */
bool ProtoEmb_onRead_sample(ProtoEmb_Sample_t *out) { (void)out; return false; }
bool ProtoEmb_onRead_state(ProtoEmb_MachineState_t *out) { (void)out; return false; }
bool ProtoEmb_onRead_machine_configuration(ProtoEmb_MachineConfiguration_t *out) { (void)out; return false; }
bool ProtoEmb_onRead_firmware_version(ProtoEmb_FirmwareVersion_t *out) { (void)out; return false; }
bool ProtoEmb_onRead_sample_profile(ProtoEmb_SampleProfile_t *out) { (void)out; return false; }

/* onWrite / onWriteRaw: reject */
ProtoEmb_RuntimeWriteDisposition_E ProtoEmb_onWrite_machine_configuration_write(const ProtoEmb_MachineConfiguration_t *in) { (void)in; return PROTOEMB_RUNTIME_WRITE_DISPOSITION_NACK; }
ProtoEmb_RuntimeWriteDisposition_E ProtoEmb_onWriteRaw_machine_configuration_write(const uint8_t *payload, uint16_t payloadSize) { (void)payload; (void)payloadSize; return PROTOEMB_RUNTIME_WRITE_DISPOSITION_NACK; }
ProtoEmb_RuntimeWriteDisposition_E ProtoEmb_onWrite_motion_enable(bool in) { (void)in; return PROTOEMB_RUNTIME_WRITE_DISPOSITION_NACK; }
ProtoEmb_RuntimeWriteDisposition_E ProtoEmb_onWrite_test_run(const ProtoEmb_TestRun_t *in) { (void)in; return PROTOEMB_RUNTIME_WRITE_DISPOSITION_NACK; }
ProtoEmb_RuntimeWriteDisposition_E ProtoEmb_onWriteRaw_test_run(const uint8_t *payload, uint16_t payloadSize) { (void)payload; (void)payloadSize; return PROTOEMB_RUNTIME_WRITE_DISPOSITION_NACK; }
ProtoEmb_RuntimeWriteDisposition_E ProtoEmb_onWrite_manual_move(const ProtoEmb_Move_t *in) { (void)in; return PROTOEMB_RUNTIME_WRITE_DISPOSITION_NACK; }
ProtoEmb_RuntimeWriteDisposition_E ProtoEmb_onWriteRaw_manual_move(const uint8_t *payload, uint16_t payloadSize) { (void)payload; (void)payloadSize; return PROTOEMB_RUNTIME_WRITE_DISPOSITION_NACK; }
ProtoEmb_RuntimeWriteDisposition_E ProtoEmb_onWrite_test_move(const ProtoEmb_Move_t *in) { (void)in; return PROTOEMB_RUNTIME_WRITE_DISPOSITION_NACK; }
ProtoEmb_RuntimeWriteDisposition_E ProtoEmb_onWriteRaw_test_move(const uint8_t *payload, uint16_t payloadSize) { (void)payload; (void)payloadSize; return PROTOEMB_RUNTIME_WRITE_DISPOSITION_NACK; }
ProtoEmb_RuntimeWriteDisposition_E ProtoEmb_onWrite_sample_profile_write(const ProtoEmb_SampleProfile_t *in) { (void)in; return PROTOEMB_RUNTIME_WRITE_DISPOSITION_NACK; }
ProtoEmb_RuntimeWriteDisposition_E ProtoEmb_onWriteRaw_sample_profile_write(const uint8_t *payload, uint16_t payloadSize) { (void)payload; (void)payloadSize; return PROTOEMB_RUNTIME_WRITE_DISPOSITION_NACK; }
ProtoEmb_RuntimeWriteDisposition_E ProtoEmb_onWrite_gauge_length(void) { return PROTOEMB_RUNTIME_WRITE_DISPOSITION_NACK; }
ProtoEmb_RuntimeWriteDisposition_E ProtoEmb_onWrite_gauge_force(void) { return PROTOEMB_RUNTIME_WRITE_DISPOSITION_NACK; }
ProtoEmb_RuntimeWriteDisposition_E ProtoEmb_onWrite_test_waveform(const ProtoEmb_WaveformMove_t *in) { (void)in; return PROTOEMB_RUNTIME_WRITE_DISPOSITION_NACK; }
ProtoEmb_RuntimeWriteDisposition_E ProtoEmb_onWriteRaw_test_waveform(const uint8_t *payload, uint16_t payloadSize) { (void)payload; (void)payloadSize; return PROTOEMB_RUNTIME_WRITE_DISPOSITION_NACK; }

/* onQuery: reject */
ProtoEmb_RuntimeQueryDisposition_E ProtoEmb_onQuery_file_download(const uint8_t *payload, uint16_t payloadSize, uint8_t *outPayload, uint16_t *outSize) { (void)payload; (void)payloadSize; (void)outPayload; (void)outSize; return PROTOEMB_RUNTIME_QUERY_DISPOSITION_NACK; }

/* notification: none pending */
bool ProtoEmb_fill_notification(ProtoEmb_Notification_t *out) { (void)out; return false; }
