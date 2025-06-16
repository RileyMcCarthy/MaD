//
// Created by Riley McCarthy on 25/04/24.
//
/**********************************************************************
 * Includes
 **********************************************************************/
#include "dev_forceGauge.h"
#include "dev_nvram.h"
#include "IO_Debug.h"
#include <string.h>
/**********************************************************************
 * Constants
 **********************************************************************/

/*********************************************************************
 * Macros
 **********************************************************************/
#define DEV_FORCEGAUGE_LOCK_REQ() _locktry(dev_forceGauge_data.lock)
#define DEV_FORCEGAUGE_REQ_BLOCK()             \
    while (DEV_FORCEGAUGE_LOCK_REQ() == false) \
    {                                          \
    }
#define DEV_FORCEGAUGE_LOCK_REL() _lockrel(dev_forceGauge_data.lock)
/**********************************************************************
 * Typedefs
 **********************************************************************/

typedef enum
{
    DEV_FORCEGAUGE_STATE_INIT,
    DEV_FORCEGAUGE_STATE_RUNNING,
    DEV_FORCEGAUGE_STATE_ERROR,
    DEV_FORCEGAUGE_STATE_COUNT,
} dev_forceGauge_state_E;

typedef struct
{
    int32_t zeroForceCount; // adc at zero force
    int32_t countPerForce;  // adc count per force
} dev_forceGauge_channelNVRAM_S;

typedef struct
{
    uint32_t rawADC; // should really be voltage
    uint32_t responding;
} dev_forceGauge_channelInput_S;

typedef struct
{
    int32_t force;
    uint32_t index;
    bool ready;
} dev_forceGauge_channelOutput_S;

typedef struct
{
    dev_forceGauge_channelInput_S input;
    dev_forceGauge_channelNVRAM_S nvram;
    dev_forceGauge_channelOutput_S output;
    dev_forceGauge_channelOutput_S stagedOutput;

    uint32_t retryCount;

    dev_forceGauge_state_E state;
} dev_forceGauge_channelData_S;

typedef struct 
{
    dev_forceGauge_channelData_S channel[DEV_FORCEGAUGE_CHANNEL_COUNT];
    int32_t lock;
} dev_forceGauge_data_S;
/**********************************************************************
 * External Variables
 **********************************************************************/
extern const dev_forceGauge_channelConfig_S dev_forceGauge_channelConfig[DEV_FORCEGAUGE_CHANNEL_COUNT];
/**********************************************************************
 * Private Variable Definitions
 **********************************************************************/
static dev_forceGauge_data_S dev_forceGauge_data;
/**********************************************************************
 * Private Function Prototypes
 **********************************************************************/

/**********************************************************************
 * Private Function Definitions
 **********************************************************************/

static dev_forceGauge_state_E dev_forceGauge_private_getState(dev_forceGauge_channel_E channel)
{
    dev_forceGauge_state_E desiredState = dev_forceGauge_data.channel[channel].state;
    switch (dev_forceGauge_data.channel[channel].state)
    {
    case DEV_FORCEGAUGE_STATE_INIT:
        if (IO_ADS122U04_start(dev_forceGauge_channelConfig[channel].adcChannel))
        {
            desiredState = DEV_FORCEGAUGE_STATE_RUNNING;
        }
        break;
    case DEV_FORCEGAUGE_STATE_RUNNING:
        if (dev_forceGauge_data.channel[channel].input.responding == false)
        {
            desiredState = DEV_FORCEGAUGE_STATE_ERROR;
        }
        break;
    case DEV_FORCEGAUGE_STATE_ERROR:
        if (dev_forceGauge_data.channel[channel].input.responding)
        {
            desiredState = DEV_FORCEGAUGE_STATE_RUNNING;
        }
        else if (dev_forceGauge_data.channel[channel].retryCount > 3U)
        {
            desiredState = DEV_FORCEGAUGE_STATE_INIT;
            IO_ADS122U04_stop(dev_forceGauge_channelConfig[channel].adcChannel);
        }
        else
        {
            dev_forceGauge_data.channel[channel].retryCount++;
        }
        break;
    default:
        break;
    }
    return desiredState;
}

static void dev_forceGauge_private_runAction(dev_forceGauge_channel_E channel)
{
    switch (dev_forceGauge_data.channel[channel].state)
    {
    case DEV_FORCEGAUGE_STATE_INIT:
        dev_forceGauge_data.channel[channel].output.ready = false;
        break;
    case DEV_FORCEGAUGE_STATE_RUNNING:
        dev_forceGauge_data.channel[channel].input.responding = IO_ADS122U04_receiveConversion(dev_forceGauge_channelConfig[channel].adcChannel, &dev_forceGauge_data.channel[channel].input.rawADC, 100000);
        if (dev_forceGauge_data.channel[channel].input.rawADC > dev_forceGauge_data.channel[channel].nvram.zeroForceCount)
        {
            const int32_t nomalizedCount = dev_forceGauge_data.channel[channel].input.rawADC - dev_forceGauge_data.channel[channel].nvram.zeroForceCount;
            dev_forceGauge_data.channel[channel].output.force = (nomalizedCount) / dev_forceGauge_data.channel[channel].nvram.countPerForce;
        }
        else
        {
            const int32_t nomalizedCount = dev_forceGauge_data.channel[channel].nvram.zeroForceCount - dev_forceGauge_data.channel[channel].input.rawADC;
            dev_forceGauge_data.channel[channel].output.force = -1*(nomalizedCount) / dev_forceGauge_data.channel[channel].nvram.countPerForce;
        }
        //DEBUG_INFO("Force Gauge %d: %d, %d, %d, %d\n", channel, dev_forceGauge_data.channel[channel].output.force, dev_forceGauge_data.channel[channel].input.rawADC, dev_forceGauge_data.channel[channel].nvram.zeroForceCount, dev_forceGauge_data.channel[channel].nvram.countPerForce);
        dev_forceGauge_data.channel[channel].output.index++;
        dev_forceGauge_data.channel[channel].output.ready = true;
        break;
    case DEV_FORCEGAUGE_STATE_ERROR:
        dev_forceGauge_data.channel[channel].input.responding = IO_ADS122U04_receiveConversion(dev_forceGauge_channelConfig[channel].adcChannel, &dev_forceGauge_data.channel[channel].input.rawADC, 100000); // TODO this is huge, needed for sim but maybe not hardware
        dev_forceGauge_data.channel[channel].output.ready = false;
        break;
    default:
        break;
    }
}

static void dev_forceGauge_private_stageOutput(dev_forceGauge_channel_E channel)
{
    DEV_FORCEGAUGE_REQ_BLOCK();
    memcpy(&dev_forceGauge_data.channel[channel].stagedOutput, &dev_forceGauge_data.channel[channel].output, sizeof(dev_forceGauge_channelOutput_S));
    DEV_FORCEGAUGE_LOCK_REL();
}

/**********************************************************************
 * Public Function Definitions
 **********************************************************************/

void dev_forceGauge_init(int lock)
{
    // load nvram
    // @TODO, we should really have 1 channel per nvram paraemeters per module
    // for example: 1 file for force gauge that updated the nvram struct directly
    // for now we will just load the machineCOnfig and parse data
    // in future we will have a separate nvram file for each module (servo etc)
    // then the machine configuration that is added to header can be aggregated
    // but the UI will be able to edit each module separately and wont reciever 1 massive struct
    // this will also allow for easier versioning of the nvram files
    // we could have dev_cogManager pass the nvram into the init and connect the files
    // then we can juse pass the data nvram struct as parameter

    MachineProfile machineProfile;
    dev_nvram_getChannelData(DEV_NVRAM_CHANNEL_MACHINE_PROFILE, &machineProfile, sizeof(MachineProfile));

    for (dev_forceGauge_channel_E channel = (dev_forceGauge_channel_E)0U; channel < DEV_FORCEGAUGE_CHANNEL_COUNT; channel++)
    {
        dev_forceGauge_data.channel[channel].state = DEV_FORCEGAUGE_STATE_INIT;
        dev_forceGauge_data.channel[channel].nvram.zeroForceCount = machineProfile.forceGaugeZeroOffset; // @todo make this voltage :)
        dev_forceGauge_data.channel[channel].nvram.countPerForce = machineProfile.forceGaugeNPerStep;
    }
    dev_forceGauge_data.lock = lock;
}

void dev_forceGauge_run()
{
    for (dev_forceGauge_channel_E channel = (dev_forceGauge_channel_E)0U; channel < DEV_FORCEGAUGE_CHANNEL_COUNT; channel++)
    {
        dev_forceGauge_state_E desiredState = dev_forceGauge_private_getState(channel);
        if (dev_forceGauge_data.channel[channel].state != desiredState)
        {
            DEBUG_INFO("Force Gauge State: %d->%d\n", dev_forceGauge_data.channel[channel].state, desiredState);
            dev_forceGauge_data.channel[channel].state = desiredState;
        }
        dev_forceGauge_private_runAction(channel);
        dev_forceGauge_private_stageOutput(channel);
    }
}

int32_t dev_forceGauge_getForce(dev_forceGauge_channel_E channel)
{
    int32_t force;
    DEV_FORCEGAUGE_REQ_BLOCK();
    force = dev_forceGauge_data.channel[channel].stagedOutput.force;
    DEV_FORCEGAUGE_LOCK_REL();
    return force;
}

uint32_t dev_forceGauge_getIndex(dev_forceGauge_channel_E channel)
{
    uint32_t index;
    DEV_FORCEGAUGE_REQ_BLOCK();
    index = dev_forceGauge_data.channel[channel].stagedOutput.index;
    DEV_FORCEGAUGE_LOCK_REL();
    return index;
}

bool dev_forceGauge_isReady(dev_forceGauge_channel_E channel)
{
    bool ready;
    DEV_FORCEGAUGE_REQ_BLOCK();
    ready = dev_forceGauge_data.channel[channel].stagedOutput.ready;
    DEV_FORCEGAUGE_LOCK_REL();
    return ready;
}

/**********************************************************************
 * End of File
 **********************************************************************/
