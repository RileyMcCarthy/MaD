//
// Created by Riley McCarthy on 25/04/24.
//
/**********************************************************************
 * Includes
 **********************************************************************/
#include "dev_stepper.h"

#include "HAL_pulseOut.h"
#include "HAL_lock.h"
#include "HAL_GPIO.h"
#include "IO_Debug.h"
#include <string.h>
#include "emulation_helpers.h"
/**********************************************************************
 * Constants
 **********************************************************************/

/*********************************************************************
 * Macros
 **********************************************************************/
#define SM_LOCK_REQ() HAL_lock_try(dev_stepper_data.lock)
#define SM_LOCK_REQ_BLOCK() while (SM_LOCK_REQ() == false) EMULATION_YIELD_LOCK();
#define SM_LOCK_REL() HAL_lock_release(dev_stepper_data.lock)

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
    bool velocityActive;     /* true → continuous-velocity (NCO) mode */
    int32_t velocityStepsPerSecond; /* signed rate; sign selects direction */
} dev_stepper_channelInput_S;

typedef struct
{
    bool stop;
    bool setPosition;
    int32_t setPositionValue;
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
    if (dev_stepper_data.channels[ch].request.setPosition)
    {
        dev_stepper_data.channels[ch].request.setPosition = false;
        dev_stepper_data.channels[ch].currentSteps = dev_stepper_data.channels[ch].request.setPositionValue;
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
        else if (dev_stepper_data.channels[ch].input.velocityActive)
        {
            desiredState = DEV_STEPPER_STATE_VELOCITY;
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
        else if (dev_stepper_data.channels[ch].input.velocityActive)
        {
            desiredState = DEV_STEPPER_STATE_VELOCITY;
        }
        else if (dev_stepper_data.channels[ch].moveComplete)
        {
            desiredState = DEV_STEPPER_STATE_STOPPED;
        }
        break;
    case DEV_STEPPER_STATE_VELOCITY:
        if (dev_stepper_data.channels[ch].input.enabled == false)
        {
            desiredState = DEV_STEPPER_STATE_DISABLED;
        }
        else if (dev_stepper_data.channels[ch].input.velocityActive == false)
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
    case DEV_STEPPER_STATE_VELOCITY:
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
            HAL_GPIO_setActive(dev_stepper_channelConfig[ch].gpioDirection, false);
            HAL_pulseOut_start(dev_stepper_channelConfig[ch].pulseChannel, (dev_stepper_data.channels[ch].input.move.targetSteps - dev_stepper_data.channels[ch].currentSteps), dev_stepper_data.channels[ch].currentMove.stepsPerSecond);
        }
        else
        {
            // CCW
            dev_stepper_data.channels[ch].directionCW = false;
            HAL_GPIO_setActive(dev_stepper_channelConfig[ch].gpioDirection, true);
            HAL_pulseOut_start(dev_stepper_channelConfig[ch].pulseChannel, (dev_stepper_data.channels[ch].currentSteps - dev_stepper_data.channels[ch].input.move.targetSteps), dev_stepper_data.channels[ch].currentMove.stepsPerSecond);
        }
        break;
    case DEV_STEPPER_STATE_VELOCITY:
    {
        const int32_t vel = dev_stepper_data.channels[ch].input.velocityStepsPerSecond;
        const bool cw = (vel >= 0);
        const uint32_t mag = (uint32_t)(cw ? vel : -vel);
        dev_stepper_data.channels[ch].moveComplete = false;
        dev_stepper_data.channels[ch].startSteps = dev_stepper_data.channels[ch].currentSteps;
        dev_stepper_data.channels[ch].directionCW = cw;
        /* SERVO_DIR active=false → CW → increasing step count. */
        HAL_GPIO_setActive(dev_stepper_channelConfig[ch].gpioDirection, !cw);
        HAL_pulseOut_startVelocity(dev_stepper_channelConfig[ch].pulseChannel, mag);
        break;
    }
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
    case DEV_STEPPER_STATE_VELOCITY:
    {
        /* Integrate the emitted pulse count into position (signed by direction),
         * then retarget the rate for this tick. On a direction reversal we
         * re-baseline (emitted resets, fresh direction snapshot) so position
         * stays continuous through the zero-velocity turning point. */
        uint32_t emitted = 0U;
        (void)HAL_pulseOut_run(dev_stepper_channelConfig[ch].pulseChannel, &emitted);
        int32_t delta = (int32_t)emitted;
        if (dev_stepper_data.channels[ch].directionCW == false)
        {
            delta = -delta;
        }
        dev_stepper_data.channels[ch].currentSteps = dev_stepper_data.channels[ch].startSteps + delta;

        const int32_t vel = dev_stepper_data.channels[ch].input.velocityStepsPerSecond;
        const bool cw = (vel >= 0);
        const uint32_t mag = (uint32_t)(cw ? vel : -vel);
        if (cw != dev_stepper_data.channels[ch].directionCW)
        {
            dev_stepper_data.channels[ch].directionCW = cw;
            dev_stepper_data.channels[ch].startSteps = dev_stepper_data.channels[ch].currentSteps;
            HAL_GPIO_setActive(dev_stepper_channelConfig[ch].gpioDirection, !cw);
            HAL_pulseOut_startVelocity(dev_stepper_channelConfig[ch].pulseChannel, mag);
        }
        else
        {
            HAL_pulseOut_setFrequency(dev_stepper_channelConfig[ch].pulseChannel, mag);
        }
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
    dev_stepper_data.channels[ch].stagedInput.velocityActive = false; /* leave velocity mode */
    SM_LOCK_REL();
    return true;
}

void dev_stepper_setVelocity(dev_stepper_channel_E ch, int32_t signedStepsPerSecond)
{
    SM_LOCK_REQ_BLOCK();
    dev_stepper_data.channels[ch].stagedInput.velocityActive = true;
    dev_stepper_data.channels[ch].stagedInput.velocityStepsPerSecond = signedStepsPerSecond;
    SM_LOCK_REL();
}

void dev_stepper_stop(dev_stepper_channel_E ch)
{
    SM_LOCK_REQ_BLOCK();
    dev_stepper_data.channels[ch].stagedInput.move.targetSteps = dev_stepper_data.channels[ch].currentSteps;
    dev_stepper_data.channels[ch].stagedInput.velocityActive = false; /* leave velocity mode */
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
    dev_stepper_data.channels[ch].request.setPosition = true;
    dev_stepper_data.channels[ch].request.setPositionValue = 0;
    SM_LOCK_REL();
}

void dev_stepper_setPosition(dev_stepper_channel_E ch, int32_t positionSteps)
{
    SM_LOCK_REQ_BLOCK();
    dev_stepper_data.channels[ch].request.setPosition = true;
    dev_stepper_data.channels[ch].request.setPositionValue = positionSteps;
    SM_LOCK_REL();
}

/**********************************************************************
 * End of File
 **********************************************************************/
