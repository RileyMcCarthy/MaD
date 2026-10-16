/* Compiled by flexcc and run on the p2core ISS by tests/flexcc_servo_waveform.rs.
 *
 * It #includes the SHIPPED servo driver source, so the waveform feasibility
 * check below is the exact code the board runs, built by the exact compiler
 * that builds the board image, and executed by the same ISS the end-to-end
 * nightly boots. A native unit test cannot see a fault in either of those:
 * this is the check that covers them.
 *
 * Output, one record per line on the console, between BEGIN and END:
 *   sqrtf <in hex> <out hex>
 *   wave <name> <accepted 0|1> <ramp down hex> <ramp up hex>
 */
#include <stdio.h>
#include "dev_servo.c"

/* The HAL calls the driver makes. Nothing here moves: only the accept-time
 * planning is exercised, and that touches none of them. */
bool HAL_lock_try(int32_t lock) { (void)lock; return true; }
void HAL_lock_release(int32_t lock) { (void)lock; }
uint32_t HAL_time_getUs(void) { return 0U; }
void HAL_GPIO_setActive(HAL_GPIO_channel_E channel, bool active) { (void)channel; (void)active; }
int32_t HAL_encoder_value(HAL_encoder_channel_E channel) { (void)channel; return 0; }
void HAL_encoder_set(HAL_encoder_channel_E channel, int32_t value) { (void)channel; (void)value; }
bool HAL_pulseOut_run(HAL_pulseOut_channel_E channel, uint32_t *pulses) { (void)channel; *pulses = 0U; return true; }
void HAL_pulseOut_stop(HAL_pulseOut_channel_E channel) { (void)channel; }
void HAL_pulseOut_startVelocity(HAL_pulseOut_channel_E channel, uint32_t frequency) { (void)channel; (void)frequency; }
void HAL_pulseOut_setFrequency(HAL_pulseOut_channel_E channel, uint32_t frequency) { (void)channel; (void)frequency; }

static uint32_t bits(float f)
{
    union { float f; uint32_t u; } x;
    x.f = f;
    return x.u;
}

static void probe_sqrtf(float in)
{
    printf("sqrtf %08x %08x\n", (unsigned)bits(in), (unsigned)bits(sqrtf(in)));
}

static void probe_wave(const char *name, int32_t amp, uint32_t freqMicroHz, dev_servo_wave_E shape)
{
    dev_servo_waveform_S wf;
    memset(&wf, 0, sizeof(wf));
    wf.amplitudeCounts = amp;
    wf.freqMicroHz = freqMicroHz;
    wf.cycles = 2U;
    wf.skewPerMille = 500U;
    wf.shape = shape;
    dev_servo_data.channel[DEV_SERVO_CHANNEL_MAIN].waveRampDown = -1.0f;
    dev_servo_data.channel[DEV_SERVO_CHANNEL_MAIN].waveRampUp = -1.0f;
    const bool ok = dev_servo_startWaveform(DEV_SERVO_CHANNEL_MAIN, &wf);
    printf("wave %s %d %08x %08x\n", name, ok ? 1 : 0,
           (unsigned)bits(dev_servo_data.channel[DEV_SERVO_CHANNEL_MAIN].waveRampDown),
           (unsigned)bits(dev_servo_data.channel[DEV_SERVO_CHANNEL_MAIN].waveRampUp));
}

int main(void)
{
    printf("BEGIN\n");
    probe_sqrtf(0.25f);
    probe_sqrtf(2.0f);
    probe_sqrtf(0.78666666f);
    probe_sqrtf(0.89333333f);
    probe_sqrtf(1.0e-6f);
    probe_sqrtf(12345.678f);

    /* The shipped machine profile (dev_nvram_config.c), in encoder counts:
     * 50 mm/s and 600 mm/s^2 at 8192 counts/mm. */
    dev_servo_init(0, 50 * 8192, 600 * 8192);
    /* The end-to-end catalog's waveforms, as the nightly sends them. */
    probe_wave("WAVE-tri", 4 * 8192, 1000000U, DEV_SERVO_WAVE_TRIANGLE);
    probe_wave("WAVE-tri-slow", 8 * 8192, 500000U, DEV_SERVO_WAVE_TRIANGLE);
    probe_wave("WAVE-sine", 5 * 8192, 1000000U, DEV_SERVO_WAVE_SINE);
    probe_wave("WAVE-sine-fast", 3 * 8192, 2000000U, DEV_SERVO_WAVE_SINE);
    printf("END\n");
    for (;;)
    {
    }
}
