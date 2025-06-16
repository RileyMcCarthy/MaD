//
// Created by Riley McCarthy on 25/04/24.
//
/**********************************************************************
 * Includes
 **********************************************************************/
#include "dev_stepper.h"

#include "HAL_pulseOut.h"
#include <propeller2.h>
#include <smartpins.h>
#include "IO_Debug.h"
#include <string.h>
/**********************************************************************
 * Constants
 **********************************************************************/

/*********************************************************************
 * Macros
 **********************************************************************/
#define SM_LOCK_REQ() _locktry(dev_stepper_data.lock)
#define SM_LOCK_REQ_BLOCK()        \
    while (SM_LOCK_REQ() == false) \
        ;
#define SM_LOCK_REL() _lockrel(dev_stepper_data.lock)

// Hardware uses 16 bit value for clockcycles per half pulse cycle
#define DEV_STEPPER_MIN_HARDWARE_SPEED (65535U * 2U)
/**********************************************************************
 * Typedefs
 **********************************************************************/

typedef struct
{
    int32_t targetSteps;
    uint32_t stepsPerSecond;
} dev_stepper_move_S;

typedef struct
{
    dev_stepper_move_S move;
    bool enabled;
} dev_stepper_channelInput_S;

typedef struct
{
    bool zeroPosition;
    bool stop;
} dev_stepper_channelRequest_S;

typedef struct
{
    bool ready;
} dev_stepper_channelOutput_S;

typedef struct
{
    dev_stepper_channelRequest_S request;
    dev_stepper_channelInput_S input;
    dev_stepper_channelInput_S stagedInput;
    dev_stepper_channelOutput_S output;
    dev_stepper_channelOutput_S stagedOutput;

    dev_stepper_state_E state;

    dev_stepper_move_S currentMove;
    int32_t currentSteps;

    uint32_t startx;
    int32_t startSteps;
    int32_t totalSteps;
    bool moveComplete;
    bool directionCW;
} dev_stepper_channelData_S;

typedef struct
{
    dev_stepper_channelData_S channels[DEV_STEPPER_CHANNEL_COUNT];
    int lock;
} dev_stepper_data_S;
/**********************************************************************
 * External Variables
 **********************************************************************/
extern dev_stepper_channelConfig_S dev_stepper_channelConfig[DEV_STEPPER_CHANNEL_COUNT];
/**********************************************************************
 * Private Variable Definitions
 **********************************************************************/
static dev_stepper_data_S dev_stepper_data;
/**********************************************************************
 * Private Function Prototypes
 **********************************************************************/

/**********************************************************************
 * Private Function Definitions
 **********************************************************************/

static void dev_stepper_private_processRequests(dev_stepper_channel_E ch)
{
    SM_LOCK_REQ_BLOCK();
    if (dev_stepper_data.channels[ch].request.zeroPosition)
    {
        dev_stepper_data.channels[ch].request.zeroPosition = false;
        dev_stepper_data.channels[ch].currentSteps = 0;
    }
    if (dev_stepper_data.channels[ch].request.stop)
    {
        dev_stepper_data.channels[ch].request.stop = false;
        dev_stepper_data.channels[ch].moveComplete = true;
    }
    SM_LOCK_REL();
}

static void dev_stepper_private_processInputs(dev_stepper_channel_E ch)
{
    SM_LOCK_REQ_BLOCK();
    memcpy(&dev_stepper_data.channels[ch].input, &dev_stepper_data.channels[ch].stagedInput, sizeof(dev_stepper_channelInput_S));
    SM_LOCK_REL();
}

static void dev_stepper_private_stageOutput(dev_stepper_channel_E ch)
{
    SM_LOCK_REQ_BLOCK();
    dev_stepper_data.channels[ch].stagedOutput = dev_stepper_data.channels[ch].output;
    SM_LOCK_REL();
}

static dev_stepper_state_E dev_stepper_private_getDesiredState(dev_stepper_channel_E ch)
{
    dev_stepper_state_E desiredState = dev_stepper_data.channels[ch].state;
    switch (dev_stepper_data.channels[ch].state)
    {
    case DEV_STEPPER_STATE_DISABLED:
        if (dev_stepper_data.channels[ch].input.enabled)
        {
            desiredState = DEV_STEPPER_STATE_STOPPED;
        }
        break;
    case DEV_STEPPER_STATE_STOPPED:
        if (dev_stepper_data.channels[ch].input.enabled == false)
        {
            desiredState = DEV_STEPPER_STATE_DISABLED;
        }
        else if (dev_stepper_data.channels[ch].input.move.targetSteps != dev_stepper_data.channels[ch].currentSteps)
        {
            desiredState = DEV_STEPPER_STATE_MOVING;
        }
        else
        {
            // At target
        }
        break;
    case DEV_STEPPER_STATE_MOVING:
        if (dev_stepper_data.channels[ch].input.enabled == false)
        {
            desiredState = DEV_STEPPER_STATE_DISABLED;
        }
        else if (dev_stepper_data.channels[ch].moveComplete)
        {
            desiredState = DEV_STEPPER_STATE_STOPPED;
        }
        break;
    case DEV_STEPPER_STATE_COUNT:
    default:
        break;
    }
    return desiredState;
}

static void dev_stepper_private_exitAction(dev_stepper_channel_E ch)
{
    switch (dev_stepper_data.channels[ch].state)
    {
    case DEV_STEPPER_STATE_DISABLED:
        break;
    case DEV_STEPPER_STATE_STOPPED:
        break;
    case DEV_STEPPER_STATE_MOVING:
        dev_stepper_data.channels[ch].moveComplete = true;
        HAL_pulseOut_stop(dev_stepper_channelConfig[ch].pulseChannel);
        break;
    case DEV_STEPPER_STATE_COUNT:
    default:
        break;
    }
}

static void dev_stepper_private_entryAction(dev_stepper_channel_E ch)
{
    switch (dev_stepper_data.channels[ch].state)
    {
    case DEV_STEPPER_STATE_DISABLED:
        break;
    case DEV_STEPPER_STATE_STOPPED:
        break;
    case DEV_STEPPER_STATE_MOVING:
        dev_stepper_data.channels[ch].moveComplete = false;
        dev_stepper_data.channels[ch].currentMove = dev_stepper_data.channels[ch].input.move;
        dev_stepper_data.channels[ch].startSteps = dev_stepper_data.channels[ch].currentSteps;
        if (dev_stepper_data.channels[ch].input.move.targetSteps > dev_stepper_data.channels[ch].currentSteps)
        {
            // CW
            dev_stepper_data.channels[ch].directionCW = true;
            _pinl(dev_stepper_channelConfig[ch].pinDirection);
            HAL_pulseOut_start(dev_stepper_channelConfig[ch].pulseChannel, (dev_stepper_data.channels[ch].input.move.targetSteps - dev_stepper_data.channels[ch].currentSteps), dev_stepper_data.channels[ch].currentMove.stepsPerSecond);
        }
        else
        {
            // CCW
            dev_stepper_data.channels[ch].directionCW = false;
            _pinh(dev_stepper_channelConfig[ch].pinDirection);
            HAL_pulseOut_start(dev_stepper_channelConfig[ch].pulseChannel, (dev_stepper_data.channels[ch].currentSteps - dev_stepper_data.channels[ch].input.move.targetSteps), dev_stepper_data.channels[ch].currentMove.stepsPerSecond);
        }
        break;
    case DEV_STEPPER_STATE_COUNT:
    default:
        break;
    }
}

static void dev_stepper_private_runAction(dev_stepper_channel_E ch)
{
    switch (dev_stepper_data.channels[ch].state)
    {
    case DEV_STEPPER_STATE_DISABLED:
        dev_stepper_data.channels[ch].output.ready = true;
        break;
    case DEV_STEPPER_STATE_STOPPED:
        dev_stepper_data.channels[ch].output.ready = true;
        break;
    case DEV_STEPPER_STATE_MOVING:
    {
        uint32_t deltaSteps = 0U;
        dev_stepper_data.channels[ch].moveComplete = HAL_pulseOut_run(dev_stepper_channelConfig[ch].pulseChannel, &deltaSteps);
        if (dev_stepper_data.channels[ch].directionCW == false)
        {
            deltaSteps = -deltaSteps;
        }
        dev_stepper_data.channels[ch].currentSteps = dev_stepper_data.channels[ch].startSteps + deltaSteps;
        dev_stepper_data.channels[ch].output.ready = true;
    }
    break;
    case DEV_STEPPER_STATE_COUNT:
    default:
        dev_stepper_data.channels[ch].output.ready = false;
        break;
    }
}

/**********************************************************************
 * Public Function Definitions
 **********************************************************************/
void dev_stepper_init(int lock)
{
    dev_stepper_data.lock = lock;
}

void dev_stepper_run()
{
    for (dev_stepper_channel_E ch = (dev_stepper_channel_E)0U; ch < DEV_STEPPER_CHANNEL_COUNT; ch++)
    {
        dev_stepper_private_processRequests(ch);
        dev_stepper_private_processInputs(ch);
        dev_stepper_state_E desiredState = dev_stepper_private_getDesiredState(ch);
        if (desiredState != dev_stepper_data.channels[ch].state)
        {
            DEBUG_INFO("Transitioning from %d -> %d\n", dev_stepper_data.channels[ch].state, desiredState);
            DEBUG_INFO("Target: %d\n", dev_stepper_data.channels[ch].input.move.targetSteps);
            DEBUG_INFO("Current: %d\n", dev_stepper_data.channels[ch].currentSteps);
            dev_stepper_private_exitAction(ch);
            dev_stepper_data.channels[ch].state = desiredState;
            dev_stepper_private_entryAction(ch);
        }
        dev_stepper_private_runAction(ch);
        dev_stepper_private_stageOutput(ch);
    }
}

bool dev_stepper_move(dev_stepper_channel_E ch, int32_t targetSteps, uint32_t stepsPerSecond)
{
    if (stepsPerSecond == 0U)
    {
        return false;
    }
    SM_LOCK_REQ_BLOCK();
    dev_stepper_data.channels[ch].stagedInput.move.targetSteps = targetSteps;
    dev_stepper_data.channels[ch].stagedInput.move.stepsPerSecond = stepsPerSecond;
    SM_LOCK_REL();
    return true;
}

void dev_stepper_stop(dev_stepper_channel_E ch)
{
    SM_LOCK_REQ_BLOCK();
    dev_stepper_data.channels[ch].stagedInput.move.targetSteps = dev_stepper_data.channels[ch].currentSteps;
    dev_stepper_data.channels[ch].request.stop = true;
    SM_LOCK_REL();
}

void dev_stepper_enable(dev_stepper_channel_E ch, bool enabled)
{
    SM_LOCK_REQ_BLOCK();
    dev_stepper_data.channels[ch].stagedInput.enabled = enabled;
    SM_LOCK_REL();
}

dev_stepper_state_E dev_stepper_getState(dev_stepper_channel_E ch)
{
    return dev_stepper_data.channels[ch].state;
}

int32_t dev_stepper_getSteps(dev_stepper_channel_E ch)
{
    return dev_stepper_data.channels[ch].currentSteps;
}

int32_t dev_stepper_getTarget(dev_stepper_channel_E ch)
{
    return dev_stepper_data.channels[ch].stagedInput.move.targetSteps;
}

bool dev_stepper_atTarget(dev_stepper_channel_E ch)
{
    return dev_stepper_data.channels[ch].stagedInput.move.targetSteps == dev_stepper_data.channels[ch].currentSteps;
}

bool dev_stepper_isReady(dev_stepper_channel_E ch)
{
    bool ready;
    SM_LOCK_REQ_BLOCK();
    ready = dev_stepper_data.channels[ch].stagedOutput.ready;
    SM_LOCK_REL();
    return ready;
}

void dev_stepper_zeroPosition(dev_stepper_channel_E ch)
{
    SM_LOCK_REQ_BLOCK();
    dev_stepper_data.channels[ch].request.zeroPosition = true;
    SM_LOCK_REL();
}

/**********************************************************************
 * End of File
 **********************************************************************/
