
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
    /* Continuous-velocity (NCO) output, the only mode. emitted =
     * freqClkProduct / clkFreq, where freqClkProduct accumulates
     * Σ(frequency × Δclock) across on-the-fly rate changes so the count stays
     * exact and monotonic. */
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
// channel config table lives in HAL/Config/HAL_pulseOut_config.c (data-only, all targets)
static HAL_pulseOut_channelData_S HAL_pulseOut_channelData[HAL_PULSE_OUT_CHANNEL_COUNT];
/**********************************************************************
 * Private Function Prototypes
 **********************************************************************/

/**********************************************************************
 * Private Function Definitions
 **********************************************************************/

/**********************************************************************
 * Public Function Definitions
 **********************************************************************/

void HAL_pulseOut_startVelocity(HAL_pulseOut_channel_E ch, uint32_t frequency)
{
    const uint32_t clk = _clockfreq();
    HAL_pulseOut_channelData[ch].clkFreq = clk;
    HAL_pulseOut_channelData[ch].velFreq = frequency;
    HAL_pulseOut_channelData[ch].freqClkProduct = 0U;
    HAL_pulseOut_channelData[ch].lastCnt = _cnt();
    HAL_pulseOut_channelData[ch].enabled = true;
    /* NCO frequency mode: add Y = frequency × 2^32 / clk to a 32-bit accumulator
     * every clock (base period 1); the pin reflects the accumulator MSB → a
     * square wave at `frequency`. Update Y on the fly with _wypin (glitch-free). */
    const uint32_t ncoWord = (uint32_t)(((uint64_t)frequency << 32) / (uint64_t)clk);
    _pinclear(HAL_pulseOut_channelConfig[ch].pin);
    _pinstart(HAL_pulseOut_channelConfig[ch].pin, P_NCO_FREQ | P_OE, 1U, ncoWord);
}

void HAL_pulseOut_setFrequency(HAL_pulseOut_channel_E ch, uint32_t frequency)
{
    if (!HAL_pulseOut_channelData[ch].enabled)
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
    if (HAL_pulseOut_channelData[ch].enabled)
    {
        /* Cumulative emitted = Σ(freq × Δclock) / clk. Never "completes". */
        const uint32_t now = _cnt();
        const uint32_t delta = now - HAL_pulseOut_channelData[ch].lastCnt;
        HAL_pulseOut_channelData[ch].freqClkProduct +=
            (uint64_t)HAL_pulseOut_channelData[ch].velFreq * (uint64_t)delta;
        HAL_pulseOut_channelData[ch].lastCnt = now;
        *pulses = (uint32_t)(HAL_pulseOut_channelData[ch].freqClkProduct /
                             (uint64_t)HAL_pulseOut_channelData[ch].clkFreq);
    }
    return false; /* velocity mode never "completes" (matches the SIL model) */
}

void HAL_pulseOut_stop(HAL_pulseOut_channel_E ch)
{
    if (HAL_pulseOut_channelData[ch].enabled)
    {
        _pinclear(HAL_pulseOut_channelConfig[ch].pin);
        HAL_pulseOut_channelData[ch].enabled = false;
    }
}

/**********************************************************************
 * End of File
 **********************************************************************/
