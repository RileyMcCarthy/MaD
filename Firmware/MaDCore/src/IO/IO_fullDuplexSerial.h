#ifndef DEV_FULLDUPLEXSERIAL_H
#define DEV_FULLDUPLEXSERIAL_H
//
// Created by Riley McCarthy on 25/04/24.
//
/**********************************************************************
 * Includes
 **********************************************************************/
#include "IO_fullDuplexSerial_config.h"
#include "HAL_serial.h"
/**********************************************************************
 * Constants
 **********************************************************************/

/*********************************************************************
 * Macros
 **********************************************************************/

/**********************************************************************
 * Typedefs
 **********************************************************************/
typedef struct
{
    HAL_serial_channel_E hardwareSerialChannel;
    uint8_t * rxBuffer;
    uint32_t rxBufferSize;
    uint8_t * txBuffer;
    uint32_t txBufferSize;
} IO_fullDuplexSerial_channelConfig_S;

#define IO_FULLDUPLEXSERIAL_CHANNEL_DEFINE(name, rxBufferSize, txBufferSize) \
    static uint8_t name##_rxBuffer[rxBufferSize]; \
    static uint8_t name##_txBuffer[txBufferSize]

#define IO_FULLDUPLEXSERIAL_CHANNEL_CONFIG(name, hwChannel) \
    { hwChannel, name##_rxBuffer, sizeof(name##_rxBuffer), name##_txBuffer, sizeof(name##_txBuffer) }
/**********************************************************************
 * Public Function Definitions
 **********************************************************************/

void IO_fullDuplexSerial_init(int32_t lock);
void IO_fullDuplexSerial_run(void);
bool IO_fullDuplexSerial_send(IO_fullDuplexSerial_channel_E channel, const uint8_t *data, uint32_t length);
bool IO_fullDuplexSerial_receive(IO_fullDuplexSerial_channel_E channel, uint8_t *data, uint32_t maxLength);
uint32_t IO_fullDuplexSerial_available(IO_fullDuplexSerial_channel_E channel);

/**********************************************************************
 * End of File
 **********************************************************************/
#endif /* DEV_FULLDUPLEXSERIAL_H */
