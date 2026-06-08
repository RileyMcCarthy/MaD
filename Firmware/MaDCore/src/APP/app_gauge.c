//
// @brief Machine vs sample frame for position (µm) and force (mN).
//
/**********************************************************************
 * Includes
 **********************************************************************/
#include "app_gauge.h"

#include "HAL_lock.h"
#include "IO_positionFeedback.h"
#include "dev_forceGauge.h"
#include "emulation_helpers.h"

/*********************************************************************
 * Macros
 **********************************************************************/
#define APP_GAUGE_LOCK_REQ() HAL_lock_try(app_gauge_data.lock)
#define APP_GAUGE_LOCK_REQ_BLOCK()        \
    while (APP_GAUGE_LOCK_REQ() == false) \
    {                                     \
        EMULATION_YIELD_LOCK();           \
    }
#define APP_GAUGE_LOCK_REL() HAL_lock_release(app_gauge_data.lock)

/**********************************************************************
 * Typedefs
 **********************************************************************/
typedef struct
{
    int32_t gaugeLength_um;
    int32_t gaugeForce_mN;
    int lock;
} app_gauge_data_t;

/**********************************************************************
 * Private Variable Definitions
 **********************************************************************/
static app_gauge_data_t app_gauge_data;

/**********************************************************************
 * Private Function Definitions
 **********************************************************************/
static int32_t app_gauge_private_getMachinePositionUm(void)
{
    return IO_positionFeedback_getValue(IO_POSITION_FEEDBACK_CHANNEL_SERVO_FEEDBACK);
}

static int32_t app_gauge_private_getMachineForceMN(void)
{
    return dev_forceGauge_getForce(DEV_FORCEGAUGE_CHANNEL_MAIN);
}

/**********************************************************************
 * Public Function Definitions
 **********************************************************************/
void app_gauge_init(int lock)
{
    app_gauge_data.lock = lock;
    app_gauge_data.gaugeLength_um = 0;
    app_gauge_data.gaugeForce_mN = 0;
}

int32_t app_gauge_getPosition(app_gauge_coord_E coord)
{
    const int32_t machine_um = app_gauge_private_getMachinePositionUm();

    switch (coord)
    {
    case APP_GAUGE_COORD_MACHINE:
        return machine_um;
    case APP_GAUGE_COORD_SAMPLE:
    {
        int32_t gaugeLength_um = 0;
        APP_GAUGE_LOCK_REQ_BLOCK();
        gaugeLength_um = app_gauge_data.gaugeLength_um;
        APP_GAUGE_LOCK_REL();
        return machine_um - gaugeLength_um;
    }
    case APP_GAUGE_COORD_COUNT:
    default:
        break;
    }

    return 0;
}

int32_t app_gauge_getForce(app_gauge_coord_E coord)
{
    const int32_t machine_mN = app_gauge_private_getMachineForceMN();

    switch (coord)
    {
    case APP_GAUGE_COORD_MACHINE:
        return machine_mN;
    case APP_GAUGE_COORD_SAMPLE:
    {
        int32_t gaugeForce_mN = 0;
        APP_GAUGE_LOCK_REQ_BLOCK();
        gaugeForce_mN = app_gauge_data.gaugeForce_mN;
        APP_GAUGE_LOCK_REL();
        return machine_mN - gaugeForce_mN;
    }
    case APP_GAUGE_COORD_COUNT:
    default:
        break;
    }

    return 0;
}

void app_gauge_setGaugeLength(void)
{
    const int32_t machine_um = app_gauge_private_getMachinePositionUm();

    APP_GAUGE_LOCK_REQ_BLOCK();
    app_gauge_data.gaugeLength_um = machine_um;
    APP_GAUGE_LOCK_REL();
}

void app_gauge_setGaugeForce(void)
{
    const int32_t machine_mN = app_gauge_private_getMachineForceMN();

    APP_GAUGE_LOCK_REQ_BLOCK();
    app_gauge_data.gaugeForce_mN = machine_mN;
    APP_GAUGE_LOCK_REL();
}

int32_t app_gauge_getGaugeLength_um(void)
{
    int32_t gaugeLength_um = 0;

    APP_GAUGE_LOCK_REQ_BLOCK();
    gaugeLength_um = app_gauge_data.gaugeLength_um;
    APP_GAUGE_LOCK_REL();

    return gaugeLength_um;
}

int32_t app_gauge_getGaugeForce_mN(void)
{
    int32_t gaugeForce_mN = 0;

    APP_GAUGE_LOCK_REQ_BLOCK();
    gaugeForce_mN = app_gauge_data.gaugeForce_mN;
    APP_GAUGE_LOCK_REL();

    return gaugeForce_mN;
}

/**********************************************************************
 * End of File
 **********************************************************************/
