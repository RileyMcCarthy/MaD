
//
// Created by Riley McCarthy on 25/04/24.
//
/**********************************************************************
 * Includes
 **********************************************************************/
#include "HAL_pulseOut.h"
#include "HAL_pulseOut_private.h"
#include "IO_Debug.h"

#include "propeller2.h"
#include "smartpins.h"
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
    bool enabled;
    uint32_t pulses;
    uint32_t clockCyclesPerPulse;
    uint32_t startx;
    bool usingHardware;
    uint32_t currentPulse;
    /* Continuous-velocity (NCO) mode. emitted = freqClkProduct / clkFreq, where
     * freqClkProduct accumulates Σ(frequency × Δclock) across on-the-fly rate
     * changes so the count stays exact and monotonic. */
    bool velocityMode;
    uint32_t velFreq;
    uint64_t freqClkProduct;
    uint32_t lastCnt;
    uint32_t clkFreq;
} HAL_pulseOut_channelData_S;
/**********************************************************************
 * External Variables
 **********************************************************************/

/**********************************************************************
 * Private Variable Definitions
 **********************************************************************/
#ifdef __FLEXC__
static const HAL_pulseOut_channelConfig_S HAL_pulseOut_channelConfig[HAL_PULSE_OUT_CHANNEL_COUNT] = {
    {
        (65535U * 2U),
        HW_PIN_SERVO_PUL,
    }
};
#else
const HAL_pulseOut_channelConfig_S HAL_pulseOut_channelConfig[HAL_PULSE_OUT_CHANNEL_COUNT] = {
    [HAL_PULSE_OUT_CHANNEL_SERVO] = {
        .pin = HW_PIN_SERVO_PUL,
        .maxHardwareClockCyclePerStep = (65535U * 2U)
    }
};
#endif
static HAL_pulseOut_channelData_S HAL_pulseOut_channelData[HAL_PULSE_OUT_CHANNEL_COUNT];
/**********************************************************************
 * Private Function Prototypes
 **********************************************************************/

/**********************************************************************
 * Private Function Definitions
 **********************************************************************/

// Hardware Pulse

void HAL_pulseOut_private_startHardwarePulse(HAL_pulseOut_channel_E ch, uint32_t pulses, uint32_t clockCyclesPerPulse)
{
    // Clear any previous pulse state
    _pinclear(HAL_pulseOut_channelConfig[ch].pin);
    
    _pinstart(HAL_pulseOut_channelConfig[ch].pin, P_TRANSITION | P_OE, clockCyclesPerPulse >> 1, 0);
    // Transition mode counts transitions, two transitions per full pulse
    _wypin(HAL_pulseOut_channelConfig[ch].pin, pulses * 2U);

    HAL_pulseOut_channelData[ch].startx = _cnt();
    HAL_pulseOut_channelData[ch].pulses = pulses;
    // Store the actual clock cycles per pulse (accounting for the >>1 division and *2 for transitions)
    HAL_pulseOut_channelData[ch].clockCyclesPerPulse = clockCyclesPerPulse;
    HAL_pulseOut_channelData[ch].currentPulse = 0U;
}

bool HAL_pulseOut_private_updateHardwarePulse(HAL_pulseOut_channel_E ch)
{
    // Check Smart Pin IN flag to see if transitions are complete
    uint32_t pin = HAL_pulseOut_channelConfig[ch].pin;
    uint32_t in_flag_state;
    
    // Use inline assembly to check the Smart Pin IN flag with TESTP
#ifdef __FLEXC__
    __asm {
        testp pin wc       // Test Smart Pin IN flag, result in Carry
        muxc in_flag_state, #1  // Move Carry to bit 0 of in_flag_state
    }
    bool isComplete = (in_flag_state & 1) != 0;
#else
    // For LLVM, use _rdpin to check if the smart pin has data ready
    in_flag_state = _rdpin(pin);
    bool isComplete = (in_flag_state != 0);
#endif
    const uint32_t deltaClockCycles = (_cnt() - HAL_pulseOut_channelData[ch].startx);
    const uint32_t deltaPulses = deltaClockCycles / HAL_pulseOut_channelData[ch].clockCyclesPerPulse;
    const uint32_t deltaPulsesLimited = (deltaPulses > HAL_pulseOut_channelData[ch].pulses) ? HAL_pulseOut_channelData[ch].pulses : deltaPulses;
    if (isComplete) {
        // Clear the IN flag by reading the Smart Pin data
        _rdpin(pin);
        HAL_pulseOut_channelData[ch].currentPulse = HAL_pulseOut_channelData[ch].pulses;
    }
    else
    {
        HAL_pulseOut_channelData[ch].currentPulse = deltaPulsesLimited;
    }
    
    return isComplete;
}

void HAL_pulseOut_private_stopHardwarePulse(HAL_pulseOut_channel_E ch)
{
    _pinclear(HAL_pulseOut_channelConfig[ch].pin);
}

// Software Pulse

bool HAL_pulseOut_private_startSoftwarePulse(HAL_pulseOut_channel_E ch, uint32_t pulses, uint32_t clockCyclesPerPulse)
{
    HAL_pulseOut_channelData[ch].pulses = pulses;
    HAL_pulseOut_channelData[ch].clockCyclesPerPulse = clockCyclesPerPulse;
    HAL_pulseOut_channelData[ch].currentPulse = 0U;
    return true;
}

bool HAL_pulseOut_private_updateSoftwarePulse(HAL_pulseOut_channel_E ch)
{
    _pinl(HAL_pulseOut_channelConfig[ch].pin);
    _waitx(HAL_pulseOut_channelData[ch].clockCyclesPerPulse >> 1);
    _pinh(HAL_pulseOut_channelConfig[ch].pin);
    _waitx(HAL_pulseOut_channelData[ch].clockCyclesPerPulse >> 1);
    HAL_pulseOut_channelData[ch].currentPulse++;
    return (HAL_pulseOut_channelData[ch].currentPulse == HAL_pulseOut_channelData[ch].pulses);
}
/**********************************************************************
 * Public Function Definitions
 **********************************************************************/

void HAL_pulseOut_start(HAL_pulseOut_channel_E ch, uint32_t pulses, uint32_t frequency)
{
    const uint32_t clockCyclesPerStep = _clockfreq() / frequency;
    if (clockCyclesPerStep > HAL_pulseOut_channelConfig[ch].maxHardwareClockCyclePerStep)
    {
        HAL_pulseOut_private_startSoftwarePulse(ch, pulses, clockCyclesPerStep);
        HAL_pulseOut_channelData[ch].usingHardware = false;
    }
    else
    {
        HAL_pulseOut_private_startHardwarePulse(ch, pulses, clockCyclesPerStep);
        HAL_pulseOut_channelData[ch].usingHardware = true;
    }
    HAL_pulseOut_channelData[ch].enabled = true;
}

bool HAL_pulseOut_startVelocity(HAL_pulseOut_channel_E ch, uint32_t frequency)
{
    const uint32_t clk = _clockfreq();
    HAL_pulseOut_channelData[ch].clkFreq = clk;
    HAL_pulseOut_channelData[ch].velFreq = frequency;
    HAL_pulseOut_channelData[ch].freqClkProduct = 0U;
    HAL_pulseOut_channelData[ch].lastCnt = _cnt();
    HAL_pulseOut_channelData[ch].velocityMode = true;
    HAL_pulseOut_channelData[ch].usingHardware = true;
    HAL_pulseOut_channelData[ch].enabled = true;
    /* NCO frequency mode: add Y = frequency × 2^32 / clk to a 32-bit accumulator
     * every clock (base period 1); the pin reflects the accumulator MSB → a
     * square wave at `frequency`. Update Y on the fly with _wypin (glitch-free). */
    const uint32_t ncoWord = (uint32_t)(((uint64_t)frequency << 32) / (uint64_t)clk);
    _pinclear(HAL_pulseOut_channelConfig[ch].pin);
    _pinstart(HAL_pulseOut_channelConfig[ch].pin, P_NCO_FREQ | P_OE, 1U, ncoWord);
    return true;
}

void HAL_pulseOut_setFrequency(HAL_pulseOut_channel_E ch, uint32_t frequency)
{
    if (!HAL_pulseOut_channelData[ch].velocityMode)
    {
        return;
    }
    /* Bank the pulses emitted at the previous rate before switching. */
    const uint32_t now = _cnt();
    const uint32_t delta = now - HAL_pulseOut_channelData[ch].lastCnt;
    HAL_pulseOut_channelData[ch].freqClkProduct +=
        (uint64_t)HAL_pulseOut_channelData[ch].velFreq * (uint64_t)delta;
    HAL_pulseOut_channelData[ch].lastCnt = now;
    HAL_pulseOut_channelData[ch].velFreq = frequency;
    const uint32_t ncoWord =
        (uint32_t)(((uint64_t)frequency << 32) / (uint64_t)HAL_pulseOut_channelData[ch].clkFreq);
    _wypin(HAL_pulseOut_channelConfig[ch].pin, ncoWord);
}

bool HAL_pulseOut_run(HAL_pulseOut_channel_E ch, uint32_t *pulses)
{
    if (HAL_pulseOut_channelData[ch].enabled && HAL_pulseOut_channelData[ch].velocityMode)
    {
        /* Cumulative emitted = Σ(freq × Δclock) / clk. Never "completes". */
        const uint32_t now = _cnt();
        const uint32_t delta = now - HAL_pulseOut_channelData[ch].lastCnt;
        HAL_pulseOut_channelData[ch].freqClkProduct +=
            (uint64_t)HAL_pulseOut_channelData[ch].velFreq * (uint64_t)delta;
        HAL_pulseOut_channelData[ch].lastCnt = now;
        *pulses = (uint32_t)(HAL_pulseOut_channelData[ch].freqClkProduct /
                             (uint64_t)HAL_pulseOut_channelData[ch].clkFreq);
        return false; /* velocity mode never "completes" (matches the SIL model) */
    }
    bool running = false;
    if (HAL_pulseOut_channelData[ch].enabled)
    {
        if (HAL_pulseOut_channelData[ch].usingHardware)
        {
            running = HAL_pulseOut_private_updateHardwarePulse(ch);
            *pulses = HAL_pulseOut_channelData[ch].currentPulse;
        }
        else
        {
            running = HAL_pulseOut_private_updateSoftwarePulse(ch);
            *pulses = HAL_pulseOut_channelData[ch].currentPulse;
        }
    }
    return running;
}

void HAL_pulseOut_stop(HAL_pulseOut_channel_E ch)
{
    if (HAL_pulseOut_channelData[ch].enabled)
    {
        if (HAL_pulseOut_channelData[ch].usingHardware)
        {
            HAL_pulseOut_private_stopHardwarePulse(ch);
        }
        HAL_pulseOut_channelData[ch].enabled = false;
        HAL_pulseOut_channelData[ch].velocityMode = false;
    }
}

/**********************************************************************
 * End of File
 **********************************************************************/
