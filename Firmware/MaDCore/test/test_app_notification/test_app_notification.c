/*
 * Unit tests for app_notification — a single-consumer notification pump over a
 * real multi-producer-guarded lib_staticQueue, draining one notification at a
 * time through app_messageSlave_sendNotification (doubled).
 *
 * The module exposes no state getter, so the SENDING state is observed via the
 * doubled sink: while a notification is in flight, runAction calls
 * sendNotification every cycle until it reports completion (returns true), then
 * the machine returns to READY (stops calling). lib_staticQueue is the real,
 * globally-compiled implementation.
 */
#include <unity.h>
#include "../../src/APP/app_notification.c"

extern void HAL_lock_mock_reset(void);

/* ---- app_messageSlave sink double ---- */
static int d_sendCount;
static bool d_sendReturn;
static ProtoEmb_Notification_t d_lastSent;

bool app_messageSlave_sendNotification(const ProtoEmb_Notification_t *n)
{
    d_sendCount++;
    d_lastSent = *n;
    return d_sendReturn;
}

static int s_lock;

void setUp(void)
{
    HAL_lock_mock_reset();
    _stdio_debug_lock = HAL_lock_create(); /* run() emits DEBUG_INFO on transitions */
    s_lock = HAL_lock_create();
    d_sendCount = 0;
    d_sendReturn = true;
    memset(&d_lastSent, 0, sizeof(d_lastSent));
    app_notification_init(s_lock);
}
void tearDown(void) {}

/* Advance INIT -> READY (idle pump, nothing queued). */
static void prime_ready(void)
{
    app_notification_run();
    TEST_ASSERT_EQUAL_INT(0, d_sendCount); /* nothing to send yet */
}

void test_idle_pump_sends_nothing(void)
{
    prime_ready();
    app_notification_run();
    app_notification_run();
    TEST_ASSERT_EQUAL_INT(0, d_sendCount);
}

void test_send_then_run_forwards_payload(void)
{
    prime_ready();
    app_notification_send(APP_NOTIFICATION_TYPE_WARNING, "hello %d", 5);
    app_notification_run(); /* stage from queue -> SENDING -> runAction calls sink */
    TEST_ASSERT_EQUAL_INT(1, d_sendCount);
    TEST_ASSERT_EQUAL_INT(PROTOEMB_NOTIFICATIONTYPE_WARNING, d_lastSent.type);
    TEST_ASSERT_EQUAL_STRING("hello 5", d_lastSent.message);
}

void test_sending_retries_until_complete(void)
{
    prime_ready();
    d_sendReturn = false; /* sink never completes */
    app_notification_send(APP_NOTIFICATION_TYPE_INFO, "x");
    app_notification_run();
    app_notification_run();
    app_notification_run();
    TEST_ASSERT_TRUE(d_sendCount >= 3); /* keeps retrying while in SENDING */

    d_sendReturn = true;            /* now it completes */
    app_notification_run();         /* this run reports complete */
    const int afterComplete = d_sendCount;
    app_notification_run();         /* back to READY: no further sends */
    app_notification_run();
    TEST_ASSERT_EQUAL_INT(afterComplete, d_sendCount);
}

void test_multiple_notifications_drain_in_fifo_order(void)
{
    prime_ready();
    app_notification_send(APP_NOTIFICATION_TYPE_INFO, "first");
    app_notification_send(APP_NOTIFICATION_TYPE_ERROR, "second");

    /* Drain: each notification needs a couple of run cycles to send + recycle. */
    char firstMsg[APP_NOTIFICATION_MAX_MESSAGE_SIZE] = {0};
    char secondMsg[APP_NOTIFICATION_MAX_MESSAGE_SIZE] = {0};
    int seen = 0;
    int lastCount = 0;
    for (int i = 0; i < 8 && seen < 2; i++)
    {
        app_notification_run();
        if (d_sendCount > lastCount)
        {
            lastCount = d_sendCount;
            if (seen == 0) strncpy(firstMsg, d_lastSent.message, sizeof(firstMsg) - 1);
            else strncpy(secondMsg, d_lastSent.message, sizeof(secondMsg) - 1);
            seen++;
        }
    }
    TEST_ASSERT_EQUAL_STRING("first", firstMsg);
    TEST_ASSERT_EQUAL_STRING("second", secondMsg);
}

void test_each_type_maps_to_protocol_enum(void)
{
    const app_notification_type_E types[] = {
        APP_NOTIFICATION_TYPE_MESSAGE, APP_NOTIFICATION_TYPE_INFO,
        APP_NOTIFICATION_TYPE_WARNING, APP_NOTIFICATION_TYPE_ERROR,
        APP_NOTIFICATION_TYPE_SUCCESS,
    };
    for (unsigned i = 0; i < sizeof(types) / sizeof(types[0]); i++)
    {
        HAL_lock_mock_reset();
        _stdio_debug_lock = HAL_lock_create();
        s_lock = HAL_lock_create();
        app_notification_init(s_lock);
        d_sendReturn = true;
        d_sendCount = 0;
        prime_ready();
        app_notification_send(types[i], "m");
        app_notification_run();
        TEST_ASSERT_EQUAL_INT((ProtoEmb_NotificationType_E)types[i], d_lastSent.type);
    }
}

void test_long_message_is_truncated_to_buffer(void)
{
    prime_ready();
    char big[300];
    memset(big, 'A', sizeof(big) - 1);
    big[sizeof(big) - 1] = '\0';
    app_notification_send(APP_NOTIFICATION_TYPE_INFO, "%s", big);
    app_notification_run();
    TEST_ASSERT_TRUE(strlen(d_lastSent.message) < sizeof(d_lastSent.message));
}

int main(void)
{
    UNITY_BEGIN();
    RUN_TEST(test_idle_pump_sends_nothing);
    RUN_TEST(test_send_then_run_forwards_payload);
    RUN_TEST(test_sending_retries_until_complete);
    RUN_TEST(test_multiple_notifications_drain_in_fifo_order);
    RUN_TEST(test_each_type_maps_to_protocol_enum);
    RUN_TEST(test_long_message_is_truncated_to_buffer);
    return UNITY_END();
}
