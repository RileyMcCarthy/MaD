//
// Created by Riley McCarthy on 25/04/24.
//
/**********************************************************************
 * Includes
 **********************************************************************/
#include <propeller2.h>
#include <stdarg.h>
#include <string.h>
#include "app_notification.h"
#include "IO_protocol.h"
#include "lib_staticQueue.h"
#include "IO_Debug.h"
/**********************************************************************
 * Constants
 **********************************************************************/

/*********************************************************************
 * Macros
 **********************************************************************/
#define APP_NOTIFICATION_BUFFER_SIZE 10
#define APP_NOTIFICATION_MAX_JSON_SIZE 255
/**********************************************************************
 * Typedefs
 **********************************************************************/

typedef struct
{
    lib_staticQueue_S notificationQueue;
    app_notification_message_S notificationBuffer[APP_NOTIFICATION_BUFFER_SIZE];
    app_notification_message_S currentNotification;
    bool notificationReady;
    bool sendComplete;
    char notificationJSON[APP_NOTIFICATION_MAX_JSON_SIZE];

    app_notification_state_E state;
    int32_t lock;
} app_notification_data_S;

/**********************************************************************
 * External Variables
 **********************************************************************/

/**********************************************************************
 * Private Variable Definitions
 **********************************************************************/
static const char *app_notification_private_typeToString[APP_NOTIFICATION_TYPE_COUNT] = {
    "message",
    "info",
    "warning",
    "error",
    "success",
};
static app_notification_data_S app_notification_data;
/**********************************************************************
 * Private Function Prototypes
 **********************************************************************/

/**********************************************************************
 * Private Function Definitions
 **********************************************************************/
void app_notification_stageRequest()
{
    app_notification_message_S notification;
    if (app_notification_data.notificationReady == false)
    {
        if (lib_staticQueue_pop(&app_notification_data.notificationQueue, &notification))
        {
            memcpy(&app_notification_data.currentNotification, &notification, sizeof(app_notification_message_S));
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
        strcpy(app_notification_data.notificationJSON, "");
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
        snprintf(app_notification_data.notificationJSON, APP_NOTIFICATION_MAX_JSON_SIZE,
                 "{\"Type\":\"%s\",\"Message\":\"%s\"}",
                 app_notification_private_typeToString[app_notification_data.currentNotification.type],
                 app_notification_data.currentNotification.message);
        if (strncmp(app_notification_data.notificationJSON, "", APP_NOTIFICATION_MAX_JSON_SIZE) != 0)
        {
            app_notification_data.sendComplete = IO_protocol_sendNotification((uint8_t *)app_notification_data.notificationJSON, strlen(app_notification_data.notificationJSON));
        }
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
    strcpy(app_notification_data.notificationJSON, "");
    lib_staticQueue_init(&app_notification_data.notificationQueue, app_notification_data.notificationBuffer, APP_NOTIFICATION_BUFFER_SIZE, sizeof(app_notification_message_S), lock);
}

void app_notification_run()
{
    app_notification_stageRequest();
    app_notification_message_S notification;
    if (lib_staticQueue_pop(&app_notification_data.notificationQueue, &notification))
    {
        snprintf(app_notification_data.notificationJSON, APP_NOTIFICATION_MAX_JSON_SIZE,
                 "{\"Type\":\"%s\",\"Message\":\"%s\"}",
                 app_notification_private_typeToString[app_notification_data.currentNotification.type],
                 app_notification_data.currentNotification.message);
    }
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
    app_notification_message_S notification;
    notification.type = type;
    va_start(args, format);
    vsnprintf(notification.message, APP_NOTIFICATION_MAX_MESSAGE_SIZE, format, args);
    va_end(args);
    lib_staticQueue_push(&app_notification_data.notificationQueue, &notification);
}

/**********************************************************************
 * End of File
 **********************************************************************/
