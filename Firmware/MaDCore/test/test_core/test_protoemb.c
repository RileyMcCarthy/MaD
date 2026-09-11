#include <unity.h>
#include <string.h>

#include "protoemb.h"
#include "protoemb_runtime.h"
#include "vibes_behaviour.h"

static uint8_t test_tx_buffer[512];
static uint16_t test_tx_size = 0;

/* Direct-linkage runtime hooks (no function-pointer registration). */
bool ProtoEmb_sendBytes(const uint8_t *data, uint16_t size)
{
    if ((test_tx_size + size) > sizeof(test_tx_buffer))
    {
        return false;
    }
    memcpy(&test_tx_buffer[test_tx_size], data, size);
    test_tx_size = (uint16_t)(test_tx_size + size);
    return true;
}

uint32_t ProtoEmb_getTimeMs(void)
{
    return 0U;
}

void test_protoemb_stored_sample_roundtrip(void)
{
    VIBES_BEHAVIOUR_WHY("protoemb.stored-sample-roundtrip",
                        "src/Generated/protoemb.c#ProtoEmb_StoredSample_encode",
                        "a stored sample with force -12345, position 54321, time 123456 and setpoint 1000",
                        "encoding a stored sample and decoding those bytes again keeps the same force, position, time and setpoint",
                        "a recorded sample is what was measured; a field-order slip would plot the wrong curve");
    ProtoEmb_StoredSample_t in;
    ProtoEmb_StoredSample_t out;
    uint8_t wire[PROTOEMB_STOREDSAMPLE_WIRE_SIZE];

    memset(&in, 0, sizeof(in));
    memset(&out, 0, sizeof(out));
    memset(wire, 0, sizeof(wire));

    ProtoEmb_StoredSample_setForce_raw(&in, -12345);
    ProtoEmb_StoredSample_setPosition_raw(&in, 54321);
    in.time = 123456U;
    ProtoEmb_StoredSample_setSetpoint_raw(&in, 1000);

    ProtoEmb_StoredSample_encode(wire, &in);
    ProtoEmb_StoredSample_decode(wire, &out);

    TEST_ASSERT_EQUAL_UINT32(11U, PROTOEMB_STOREDSAMPLE_WIRE_SIZE);
    TEST_ASSERT_EQUAL_INT32(ProtoEmb_StoredSample_getForce_raw(&in), ProtoEmb_StoredSample_getForce_raw(&out));
    TEST_ASSERT_EQUAL_INT32(ProtoEmb_StoredSample_getPosition_raw(&in), ProtoEmb_StoredSample_getPosition_raw(&out));
    TEST_ASSERT_EQUAL_INT32(ProtoEmb_StoredSample_getSetpoint_raw(&in), ProtoEmb_StoredSample_getSetpoint_raw(&out));
    TEST_ASSERT_EQUAL_UINT32(in.time, out.time);
}

void test_protoemb_runtime_send_notification_frame(void)
{
    VIBES_BEHAVIOUR_WHY("protoemb.notification-frame",
                        "src/Generated/protoemb_runtime.c#ProtoEmb_Runtime_sendNotification",
                        "an info notification with the text runtime-test",
                        "sending a notification produces a serial frame that begins with the sync marker, is typed as a notification, and states the payload length",
                        "the UI finds the start of a notification by that marker and type; a wrong header drops the message");
    ProtoEmb_Runtime_t runtime;
    ProtoEmb_Notification_t notification;

    memset(&runtime, 0, sizeof(runtime));
    memset(&notification, 0, sizeof(notification));
    memset(test_tx_buffer, 0, sizeof(test_tx_buffer));
    test_tx_size = 0;

    notification.type = PROTOEMB_NOTIFICATIONTYPE_INFO;
    strncpy(notification.message, "runtime-test", sizeof(notification.message) - 1U);

    ProtoEmb_Runtime_init(&runtime);
    TEST_ASSERT_TRUE(ProtoEmb_Runtime_sendNotification(&runtime, &notification));

    TEST_ASSERT_GREATER_THAN_UINT16(6U, test_tx_size);
    TEST_ASSERT_EQUAL_HEX8(0x55U, test_tx_buffer[0]);
    TEST_ASSERT_EQUAL_HEX8(0x03U, test_tx_buffer[1]);
    TEST_ASSERT_EQUAL_HEX8(0x00U, test_tx_buffer[2]);
    TEST_ASSERT_EQUAL_HEX8((uint8_t)(PROTOEMB_NOTIFICATION_WIRE_SIZE & 0xFFU), test_tx_buffer[3]);
    TEST_ASSERT_EQUAL_HEX8((uint8_t)((PROTOEMB_NOTIFICATION_WIRE_SIZE >> 8U) & 0xFFU), test_tx_buffer[4]);
}

#include "../../src/Generated/protoemb.c"
#include "../../src/Generated/protoemb_runtime.c"
