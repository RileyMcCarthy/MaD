#ifndef APP_GAUGE_H
#define APP_GAUGE_H
//
// @brief Machine vs sample (test) frame for jaw position and load.
//        Reads IO_positionFeedback and dev_forceGauge; sample frame subtracts latched offsets.
//
/**********************************************************************
 * Includes
 **********************************************************************/
#include <stdint.h>

/**********************************************************************
 * Typedefs
 **********************************************************************/
typedef enum
{
    APP_GAUGE_COORD_MACHINE = 0,
    APP_GAUGE_COORD_SAMPLE,
    APP_GAUGE_COORD_COUNT,
} app_gauge_coord_E;

/**********************************************************************
 * Public Function Definitions
 **********************************************************************/
void app_gauge_init(int lock);

int32_t app_gauge_getPosition(app_gauge_coord_E coord);
int32_t app_gauge_getForce(app_gauge_coord_E coord);

void app_gauge_setGaugeLength(void);
void app_gauge_setGaugeForce(void);

int32_t app_gauge_getGaugeLength_um(void);
int32_t app_gauge_getGaugeForce_mN(void);

/**********************************************************************
 * End of File
 **********************************************************************/
#endif /* APP_GAUGE_H */
