#ifndef DEV_FORCEGAUGE_H
#define DEV_FORCEGAUGE_H
//
// Created by Riley McCarthy on 25/04/24.
//
/**********************************************************************
 * Includes
 **********************************************************************/
#include "dev_forceGauge_config.h"
#include "IO_ADS122U04.h"

#include <stdint.h>
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
    IO_ADS122U04_channel_E adcChannel;
} dev_forceGauge_channelConfig_S;
/**********************************************************************
 * Public Function Definitions
 **********************************************************************/

void dev_forceGauge_init(int lock);
void dev_forceGauge_run(void);

int32_t dev_forceGauge_getForce(dev_forceGauge_channel_E channel);
uint32_t dev_forceGauge_getIndex(dev_forceGauge_channel_E channel);
bool dev_forceGauge_isReady(dev_forceGauge_channel_E channel);

/**********************************************************************
 * End of File
 **********************************************************************/
#endif /* DEV_FORCEGAUGE_H */
