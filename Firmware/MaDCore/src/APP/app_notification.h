#ifndef APP_NOTIFICATION_H
#define APP_NOTIFICATION_H
//
// Created by Riley McCarthy on 25/04/24.
//
/**********************************************************************
 * Includes
 **********************************************************************/
#define APP_NOTIFICATION_MAX_MESSAGE_SIZE 100
/**********************************************************************
 * Constants
 **********************************************************************/

/*********************************************************************
 * Macros
 **********************************************************************/

/**********************************************************************
 * Typedefs
 **********************************************************************/
typedef enum
{
    APP_NOTIFICATION_STATE_INIT,
    APP_NOTIFICATION_STATE_READY,
    APP_NOTIFICATION_STATE_SENDING,
    APP_NOTIFICATION_STATE_COUNT,
} app_notification_state_E;

typedef enum
{
    APP_NOTIFICATION_TYPE_MESSAGE,
    APP_NOTIFICATION_TYPE_INFO,
    APP_NOTIFICATION_TYPE_WARNING,
    APP_NOTIFICATION_TYPE_ERROR,
    APP_NOTIFICATION_TYPE_SUCCESS,
    APP_NOTIFICATION_TYPE_COUNT,
} app_notification_type_E;

typedef struct
{
    char message[APP_NOTIFICATION_MAX_MESSAGE_SIZE];
    app_notification_type_E type;
} app_notification_message_S;
/**********************************************************************
 * Public Function Definitions
 **********************************************************************/
void app_notification_init(int lock);
void app_notification_run();

void app_notification_send(app_notification_type_E type, const char *format, ...);
/**********************************************************************
 * End of File
 **********************************************************************/
#endif /* APP_NOTIFICATION_H */
