#ifndef app_message_slave_RX_H
#define app_message_slave_RX_H
//
// Created by Riley McCarthy on 25/04/24.
// @brief Handles the reception of messages from the serial port, can trigger TX messages
//
/**********************************************************************
 * Includes
 **********************************************************************/
#include <stdbool.h>
#include <stdint.h>
#include "protoemb.h"
/**********************************************************************
 * Constants
 **********************************************************************/
#define APP_MESSAGE_SLAVE_RX_BUFFER_SIZE 1023
#define APP_MESSAGE_SLAVE_TX_BUFFER_SIZE 4096
/*********************************************************************
 * Macros
 **********************************************************************/

/**********************************************************************
 * Typedefs
 **********************************************************************/

/**********************************************************************
 * Public Function Definitions
 **********************************************************************/
void app_messageSlave_init(int lock);
void app_messageSlave_run(void);
bool app_messageSlave_sendNotification(const ProtoEmb_Notification_t *notification);

/**********************************************************************
 * End of File
 **********************************************************************/
#endif /* app_message_slave_RX_H */
