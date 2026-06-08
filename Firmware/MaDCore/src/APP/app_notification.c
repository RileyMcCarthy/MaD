//
// Created by Riley McCarthy on 25/04/24.
//
/**********************************************************************
 * Includes
 **********************************************************************/
#include <stdarg.h>
#include <string.h>
#include "app_notification.h"
#include "app_messageSlave.h"
#include "protoemb.h"
#include "lib_staticQueue.h"
#include "IO_Debug.h"
/**********************************************************************
 * Constants
 **********************************************************************/

/*********************************************************************
 * Macros
 **********************************************************************/
#define APP_NOTIFICATION_BUFFER_SIZE 10
/**********************************************************************
 * Typedefs
 **********************************************************************/

typedef struct
{
    lib_staticQueue_S notificationQueue;
    ProtoEmb_Notification_t notificationBuffer[APP_NOTIFICATION_BUFFER_SIZE];
    ProtoEmb_Notification_t currentNotification;
    bool notificationReady;
    bool sendComplete;
    uint8_t notificationBinary[PROTOEMB_NOTIFICATION_WIRE_SIZE];

    app_notification_state_E state;
    int32_t lock;
} app_notification_data_S;

/**********************************************************************
 * External Variables
 **********************************************************************/

/**********************************************************************
 * Private Variable Definitions
 **********************************************************************/
static app_notification_data_S app_notification_data;
/**********************************************************************
 * Private Function Prototypes
 **********************************************************************/

/**********************************************************************
 * Private Function Definitions
 **********************************************************************/
void app_notification_stageRequest()
{
    ProtoEmb_Notification_t notification;
    if (app_notification_data.notificationReady == false)
    {
        if (lib_staticQueue_pop(&app_notification_data.notificationQueue, &notification))
        {
            memcpy(&app_notification_data.currentNotification, &notification, sizeof(ProtoEmb_Notification_t));
            app_notification_data.notificationReady = true;
            app_notification_data.sendComplete = false;
        }
    }
}

app_notification_state_E app_notification_getDesiredState()
{
    app_notification_state_E desiredState = app_notification_data.state;
    switch (app_notification_data.state)
    {
    case APP_NOTIFICATION_STATE_INIT:
        desiredState = APP_NOTIFICATION_STATE_READY;
        break;
    case APP_NOTIFICATION_STATE_READY:
        if (app_notification_data.notificationReady)
        {
            desiredState = APP_NOTIFICATION_STATE_SENDING;
        }
        break;
    case APP_NOTIFICATION_STATE_SENDING:
        if (app_notification_data.sendComplete)
        {
            desiredState = APP_NOTIFICATION_STATE_READY;
        }
        break;
    default:
        break;
    }
    return desiredState;
}

void app_notification_runExitAction()
{
    switch (app_notification_data.state)
    {
    case APP_NOTIFICATION_STATE_INIT:
        break;
    case APP_NOTIFICATION_STATE_READY:
        app_notification_data.notificationReady = false;
        break;
    case APP_NOTIFICATION_STATE_SENDING:
        break;
    default:
        break;
    }
}

void app_notification_runEntryAction()
{
    switch (app_notification_data.state)
    {
    case APP_NOTIFICATION_STATE_INIT:
        break;
    case APP_NOTIFICATION_STATE_READY:
        break;
    case APP_NOTIFICATION_STATE_SENDING:
        app_notification_data.sendComplete = false;
        memset(app_notification_data.notificationBinary, 0, sizeof(app_notification_data.notificationBinary));
        break;
    default:
        break;
    }
}

void app_notification_runAction()
{
    switch (app_notification_data.state)
    {
    case APP_NOTIFICATION_STATE_INIT:
        break;
    case APP_NOTIFICATION_STATE_READY:
        break;
    case APP_NOTIFICATION_STATE_SENDING:
        app_notification_data.sendComplete =
            app_messageSlave_sendNotification(&app_notification_data.currentNotification);
        break;
    default:
        break;
    }
}
/**********************************************************************
 * Public Function Definitions
 **********************************************************************/
void app_notification_init(int lock)
{
    app_notification_data.lock = lock;
    app_notification_data.notificationReady = false;
    app_notification_data.state = APP_NOTIFICATION_STATE_INIT;
    memset(app_notification_data.notificationBinary, 0, sizeof(app_notification_data.notificationBinary));
    lib_staticQueue_init(&app_notification_data.notificationQueue, app_notification_data.notificationBuffer, APP_NOTIFICATION_BUFFER_SIZE, sizeof(ProtoEmb_Notification_t), lock);
}

void app_notification_run()
{
    app_notification_stageRequest();
    app_notification_state_E desiredState = app_notification_getDesiredState();
    if (app_notification_data.state != desiredState)
    {
        DEBUG_INFO("Notification State: %d->%d\n", app_notification_data.state, desiredState);
        app_notification_runExitAction();
        app_notification_data.state = desiredState;
        app_notification_runEntryAction();
    }
    app_notification_runAction();
}

void app_notification_send(app_notification_type_E type, const char *format, ...)
{
    va_list args;
    ProtoEmb_Notification_t notification;
    notification.type = (ProtoEmb_NotificationType_E)type;
    memset(notification.message, 0, sizeof(notification.message));
    va_start(args, format);
    vsnprintf(notification.message, sizeof(notification.message), format, args);
    va_end(args);
    lib_staticQueue_push(&app_notification_data.notificationQueue, &notification);
}

/**********************************************************************
 * End of File
 **********************************************************************/
