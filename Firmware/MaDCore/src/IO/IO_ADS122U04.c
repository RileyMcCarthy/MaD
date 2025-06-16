//
// Created by Riley McCarthy on 25/04/24.
//
/**********************************************************************
 * Includes
 **********************************************************************/
#include "IO_ADS122U04.h"

#include "lib_utility.h"
#include "HAL_serial.h"
#include "IO_Debug.h"

#include <propeller2.h>
/**********************************************************************
 * Constants
 **********************************************************************/

#define IO_ADS122U04_TIMEOUT_US 1000000U
#define IO_ADS122U04_SYNC 0x55
#define IO_ADS122U04_CMD_RESET 0x06
#define IO_ADS122U04_CMD_START 0x08

#define IO_ADS122U04_CONFIG0_MUX(mux) LIB_UTILITY_CREATE_MASK(4, 4, mux)
#define IO_ADS122U04_CONFIG0_GAIN(gain) LIB_UTILITY_CREATE_MASK(3, 1, gain)
#define IO_ADS122U04_CONFIG0_PGA_BYPASS(bypass) LIB_UTILITY_CREATE_MASK(1, 0, bypass)

#define IO_ADS122U04_CONFIG1_DATA_RATE(rate) LIB_UTILITY_CREATE_MASK(2, 5, rate)
#define IO_ADS122U04_CONFIG1_OPERATING_MODE(om) LIB_UTILITY_CREATE_MASK(1, 4, om)
#define IO_ADS122U04_CONFIG1_CONVERSION_MODE(cm) LIB_UTILITY_CREATE_MASK(1, 3, cm)
#define IO_ADS122U04_CONFIG1_VREF(vref) LIB_UTILITY_CREATE_MASK(2, 1, vref)
#define IO_ADS122U04_CONFIG1_TEMP_SENSOR(ts) LIB_UTILITY_CREATE_MASK(1, 0, ts)

#define IO_ADS122U04_CONFIG2_DRDY(drdy) LIB_UTILITY_CREATE_MASK(1, 7, drdy)
#define IO_ADS122U04_CONFIG2_DATA_COUNTER(dc) LIB_UTILITY_CREATE_MASK(1, 6, dc)
#define IO_ADS122U04_CONFIG2_CRC(crc) LIB_UTILITY_CREATE_MASK(2, 4, crc)
#define IO_ADS122U04_CONFIG2_BCS(bcs) LIB_UTILITY_CREATE_MASK(1, 3, bcs)
#define IO_ADS122U04_CONFIG2_IDAC(tfs) LIB_UTILITY_CREATE_MASK(3, 0, tfs)

#define IO_ADS122U04_CONFIG3_IDAC1(idac2) LIB_UTILITY_CREATE_MASK(3, 5, idac2)
#define IO_ADS122U04_CONFIG3_IDAC2(idac1) LIB_UTILITY_CREATE_MASK(3, 2, idac1)
#define IO_ADS122U04_CONFIG3_CONVERION_MODE(drdy) LIB_UTILITY_CREATE_MASK(1, 0, drdy)

#define IO_ADS122U04_CONFIG4_GPIO2_DIR(idac) LIB_UTILITY_CREATE_MASK(1, 6, idac)
#define IO_ADS122U04_CONFIG4_GPIO1_DIR(idac) LIB_UTILITY_CREATE_MASK(1, 5, idac)
#define IO_ADS122U04_CONFIG4_GPIO0_DIR(idac) LIB_UTILITY_CREATE_MASK(1, 4, idac)
#define IO_ADS122U04_CONFIG4_GPIO2_SEL(idac) LIB_UTILITY_CREATE_MASK(1, 3, idac)
#define IO_ADS122U04_CONFIG4_GPIO2_DAT(idac) LIB_UTILITY_CREATE_MASK(1, 2, idac)
#define IO_ADS122U04_CONFIG4_GPIO1_DAT(idac) LIB_UTILITY_CREATE_MASK(1, 1, idac)
#define IO_ADS122U04_CONFIG4_GPIO0_DAT(idac) LIB_UTILITY_CREATE_MASK(1, 0, idac)

/*********************************************************************
 * Macros
 **********************************************************************/

/**********************************************************************
 * Typedefs
 **********************************************************************/

typedef enum
{
    IO_ADS122U04_CONFIG0_MUX_AIN0_AIN1 = 0b0000,
    IO_ADS122U04_CONFIG0_MUX_AIN0_AIN2 = 0b0001,
    IO_ADS122U04_CONFIG0_MUX_AIN0_AIN3 = 0b0010,
    IO_ADS122U04_CONFIG0_MUX_AIN1_AIN0 = 0b0011,
    IO_ADS122U04_CONFIG0_MUX_AIN1_AIN2 = 0b0100,
    IO_ADS122U04_CONFIG0_MUX_AIN1_AIN3 = 0b0101,
    IO_ADS122U04_CONFIG0_MUX_AIN2_AIN3 = 0b0110,
    IO_ADS122U04_CONFIG0_MUX_AIN3_AIN2 = 0b0111,
    IO_ADS122U04_CONFIG0_MUX_AIN0_AVSS = 0b1000,
    IO_ADS122U04_CONFIG0_MUX_AIN1_AVSS = 0b1001,
    IO_ADS122U04_CONFIG0_MUX_AIN2_AVSS = 0b1010,
    IO_ADS122U04_CONFIG0_MUX_AIN3_AVSS = 0b1011,
    IO_ADS122U04_CONFIG0_MUX_REFP_REFN = 0b1100,
    IO_ADS122U04_CONFIG0_MUX_AVDD_AVSS = 0b1101,
    IO_ADS122U04_CONFIG0_MUX_AINP_AINN = 0b1110,
    IO_ADS122U04_CONFIG0_MUX_RESERVED = 0b1111,
} IO_ADS122U04_config0_mux_E;

typedef enum
{
    IO_ADS122U04_CONFIG0_GAIN_1 = 0b000,
    IO_ADS122U04_CONFIG0_GAIN_2 = 0b001,
    IO_ADS122U04_CONFIG0_GAIN_4 = 0b010,
    IO_ADS122U04_CONFIG0_GAIN_8 = 0b011,
    IO_ADS122U04_CONFIG0_GAIN_16 = 0b100,
    IO_ADS122U04_CONFIG0_GAIN_32 = 0b101,
    IO_ADS122U04_CONFIG0_GAIN_64 = 0b110,
    IO_ADS122U04_CONFIG0_GAIN_128 = 0b111,
} IO_ADS122U04_config0_gain_E;

typedef enum
{
    IO_ADS122U04_CONFIG0_PGA_BYPASS_OFF = 0b0,
    IO_ADS122U04_CONFIG0_PGA_BYPASS_ON = 0b1,
} IO_ADS122U04_config0_pgaBypass_E;

typedef enum
{
    IO_ADS122U04_CONFIG1_DATA_RATE_20SPS = 0b000,
    IO_ADS122U04_CONFIG1_DATA_RATE_45SPS = 0b001,
    IO_ADS122U04_CONFIG1_DATA_RATE_90SPS = 0b010,
    IO_ADS122U04_CONFIG1_DATA_RATE_175SPS = 0b011,
    IO_ADS122U04_CONFIG1_DATA_RATE_330SPS = 0b100,
    IO_ADS122U04_CONFIG1_DATA_RATE_600SPS = 0b101,
    IO_ADS122U04_CONFIG1_DATA_RATE_1000SPS = 0b110,
} IO_ADS122U04_config1_dataRate_E;

typedef enum
{
    IO_ADS122U04_CONFIG1_OPERATING_MODE_NORMAL = 0b0,
    IO_ADS122U04_CONFIG1_OPERATING_MODE_TURBO = 0b1, // doubles the data rate
} IO_ADS122U04_config1_operatingMode_E;

typedef enum
{
    IO_ADS122U04_CONFIG1_CONVERSION_MODE_SINGLE = 0b0,
    IO_ADS122U04_CONFIG1_CONVERSION_MODE_CONTINUOUS = 0b1,
} IO_ADS122U04_config1_conversionMode_E;

typedef enum
{
    IO_ADS122U04_CONFIG1_VREF_INTERNAL = 0b00,
    IO_ADS122U04_CONFIG1_VREF_EXTERNAL = 0b01,
    IO_ADS122U04_CONFIG1_VREF_AVDD_AVSS = 0b10,
    IO_ADS122U04_CONFIG1_VREF_AVDD_AVSS_DIV4 = 0b11,
} IO_ADS122U04_config1_VREF_E;

typedef enum
{
    IO_ADS122U04_CONFIG1_TEMP_SENSOR_OFF = 0b0,
    IO_ADS122U04_CONFIG1_TEMP_SENSOR_ON = 0b1,
} IO_ADS122U04_config1_tempSensor_E;

typedef enum
{
    IO_ADS122U04_CONFIG2_DRDY_OFF = 0b0,
    IO_ADS122U04_CONFIG2_DRDY_ON = 0b1,
} IO_ADS122U04_config2_DRDY_E;

typedef enum
{
    IO_ADS122U04_CONFIG2_DATA_COUNTER_OFF = 0b0,
    IO_ADS122U04_CONFIG2_DATA_COUNTER_ON = 0b1,
} IO_ADS122U04_config2_dataCounter_E;

typedef enum
{
    IO_ADS122U04_CONFIG2_CRC_OFF = 0b0,
    IO_ADS122U04_CONFIG2_CRC_ON = 0b1,
} IO_ADS122U04_config2_CRC_E;

typedef enum
{
    IO_ADS122U04_CONFIG2_BCS_OFF = 0b0,
    IO_ADS122U04_CONFIG2_BCS_ON = 0b1,
} IO_ADS122U04_config2_BCS_E;

typedef enum
{
    IO_ADS122U04_CONFIG3_IDAC_OFF = 0b0,
    IO_ADS122U04_CONFIG3_IDAC_ON = 0b1,
} IO_ADS122U04_config3_IDAC_E;

typedef enum
{
    IO_ADS122U04_CONFIG3_CONVERSION_MANUAL = 0b0,
    IO_ADS122U04_CONFIG3_CONVERSION_AUTO = 0b1,
} IO_ADS122U04_config3_conversionMode_E;

typedef enum
{
    IO_ADS122U04_CONFIG_GPIO_DIR_INPUT = 0b0,
    IO_ADS122U04_CONFIG_GPIO_DIR_OUTPUT = 0b1,
} IO_ADS122U04_config_GPIODir_E;

typedef enum
{
    IO_ADS122U04_CONFIG3_GPIO2_SEL_GPIO2_DAT = 0b0,
    IO_ADS122U04_CONFIG3_GPIO2_SEL_DRDY = 0b1,
} IO_ADS122U04_config4_GPIO2Sel_E;

typedef enum
{
    IO_ADS122U04_CONFIG3_GPIO_STATE_LOW = 0b0,
    IO_ADS122U04_CONFIG3_GPIO_STATE_HIGH = 0b1,
} IO_ADS122U04_config4_GPIOState_E;

typedef enum
{
    IO_ADS122U04_CONFIG_REGISTER_0 = 0,
    IO_ADS122U04_CONFIG_REGISTER_1 = 1,
    IO_ADS122U04_CONFIG_REGISTER_2 = 2,
    IO_ADS122U04_CONFIG_REGISTER_3 = 3,
    IO_ADS122U04_CONFIG_REGISTER_4 = 4,
    IO_ADS122U04_REGISTER_COUNT,
} IO_ADS122U04_configRegister_E;

typedef struct
{
    HAL_serial_channel_E serialChannel;
    uint8_t configRegister[IO_ADS122U04_REGISTER_COUNT];
} IO_ADS122U04_channelConfig_S;

/**********************************************************************
 * External Variables
 **********************************************************************/

/**********************************************************************
 * Private Variable Definitions
 **********************************************************************/

static IO_ADS122U04_channelConfig_S IO_ADS122U04_channelConfig[IO_ADS122U04_CHANNEL_COUNT] = {
    {
        HAL_SERIAL_CHANNEL_FORCE_GAUGE,
        {
            (
                IO_ADS122U04_CONFIG0_MUX(IO_ADS122U04_CONFIG0_MUX_AIN0_AIN1) |
                IO_ADS122U04_CONFIG0_GAIN(IO_ADS122U04_CONFIG0_GAIN_1) |
                IO_ADS122U04_CONFIG0_PGA_BYPASS(IO_ADS122U04_CONFIG0_PGA_BYPASS_OFF)
            ),
            (
                IO_ADS122U04_CONFIG1_DATA_RATE(IO_ADS122U04_CONFIG1_DATA_RATE_1000SPS) |
                IO_ADS122U04_CONFIG1_OPERATING_MODE(IO_ADS122U04_CONFIG1_OPERATING_MODE_NORMAL) |
                IO_ADS122U04_CONFIG1_CONVERSION_MODE(IO_ADS122U04_CONFIG1_CONVERSION_MODE_CONTINUOUS) |
                IO_ADS122U04_CONFIG1_VREF(IO_ADS122U04_CONFIG1_VREF_INTERNAL) |
                IO_ADS122U04_CONFIG1_TEMP_SENSOR(IO_ADS122U04_CONFIG1_TEMP_SENSOR_OFF)
            ),
            (
                IO_ADS122U04_CONFIG2_DRDY(IO_ADS122U04_CONFIG2_DRDY_OFF) |
                IO_ADS122U04_CONFIG2_DATA_COUNTER(IO_ADS122U04_CONFIG2_DATA_COUNTER_OFF) |
                IO_ADS122U04_CONFIG2_CRC(IO_ADS122U04_CONFIG2_CRC_OFF) |
                IO_ADS122U04_CONFIG2_BCS(IO_ADS122U04_CONFIG2_BCS_OFF) |
                IO_ADS122U04_CONFIG2_IDAC(IO_ADS122U04_CONFIG2_IDAC(IO_ADS122U04_CONFIG3_IDAC_OFF))
            ),
            (
                IO_ADS122U04_CONFIG3_IDAC1(IO_ADS122U04_CONFIG3_IDAC1(IO_ADS122U04_CONFIG3_IDAC_OFF)) |
                IO_ADS122U04_CONFIG3_IDAC2(IO_ADS122U04_CONFIG3_IDAC2(IO_ADS122U04_CONFIG3_IDAC_OFF)) |
                IO_ADS122U04_CONFIG3_CONVERION_MODE(IO_ADS122U04_CONFIG3_CONVERSION_AUTO)
            ),
            (
                IO_ADS122U04_CONFIG4_GPIO2_DIR(IO_ADS122U04_CONFIG_GPIO_DIR_INPUT) |
                IO_ADS122U04_CONFIG4_GPIO1_DIR(IO_ADS122U04_CONFIG_GPIO_DIR_INPUT) |
                IO_ADS122U04_CONFIG4_GPIO0_DIR(IO_ADS122U04_CONFIG_GPIO_DIR_INPUT) |
                IO_ADS122U04_CONFIG4_GPIO2_SEL(IO_ADS122U04_CONFIG3_GPIO2_SEL_GPIO2_DAT) |
                IO_ADS122U04_CONFIG4_GPIO2_DAT(IO_ADS122U04_CONFIG3_GPIO_STATE_LOW) |
                IO_ADS122U04_CONFIG4_GPIO1_DAT(IO_ADS122U04_CONFIG3_GPIO_STATE_LOW) |
                IO_ADS122U04_CONFIG4_GPIO0_DAT(IO_ADS122U04_CONFIG3_GPIO_STATE_LOW)
            ),
        }
    },
};
/**********************************************************************
 * Private Function Prototypes
 **********************************************************************/

/**********************************************************************
 * Private Function Definitions
 **********************************************************************/
static void IO_ADS122U04_writeRegister(IO_ADS122U04_channel_E channel, IO_ADS122U04_configRegister_E registerAddress, uint8_t data)
{
    const uint8_t package[3] = {IO_ADS122U04_SYNC, 0x40 + (registerAddress << 1), data};
    HAL_serial_transmitData(IO_ADS122U04_channelConfig[channel].serialChannel, package, 3);
}

static bool IO_ADS122U04_readRegister(IO_ADS122U04_channel_E channel, IO_ADS122U04_configRegister_E registerAddress, uint8_t *data)
{
    const uint8_t package[2] = {IO_ADS122U04_SYNC, 0x20 + (registerAddress << 1)};
    HAL_serial_transmitData(IO_ADS122U04_channelConfig[channel].serialChannel, package, 2);
    return HAL_serial_recieveDataTimeout(IO_ADS122U04_channelConfig[channel].serialChannel, data, 1, IO_ADS122U04_TIMEOUT_US);
}

static void IO_ADS122U04_sendCommand(IO_ADS122U04_channel_E channel, uint8_t command)
{
    const uint8_t package[2] = {IO_ADS122U04_SYNC, command};
    HAL_serial_transmitData(IO_ADS122U04_channelConfig[channel].serialChannel, package, 2);
}
/**********************************************************************
 * Public Function Definitions
 **********************************************************************/

bool IO_ADS122U04_start(IO_ADS122U04_channel_E channel)
{
    // start the serial channel
    HAL_serial_start(IO_ADS122U04_channelConfig[channel].serialChannel);

    // reset the device
    IO_ADS122U04_sendCommand(channel, IO_ADS122U04_CMD_RESET);
    _waitms(100);


    // write the configuration
    for (IO_ADS122U04_configRegister_E reg = (IO_ADS122U04_configRegister_E)0U; reg < IO_ADS122U04_REGISTER_COUNT; reg++)
    {
        IO_ADS122U04_writeRegister(channel, reg, IO_ADS122U04_channelConfig[channel].configRegister[reg]);
    }

    // read back the configuration
    for (IO_ADS122U04_configRegister_E reg = (IO_ADS122U04_configRegister_E)0U; reg < IO_ADS122U04_REGISTER_COUNT; reg++)
    {
        uint8_t temp = 0U;
        if (IO_ADS122U04_readRegister(channel, reg, &temp) == false)
        {
            DEBUG_ERROR("ADS122U04 Configuration Error: Register %d timeout\n", reg);
            return false;
        }
        if (temp != IO_ADS122U04_channelConfig[channel].configRegister[reg])
        {
            DEBUG_ERROR("ADS122U04 Configuration Error: Register %d, Expected %d, Got %d\n", reg, IO_ADS122U04_channelConfig[channel].configRegister[reg], temp);
            return false;
        }
    }

    // Begin conversion
    IO_ADS122U04_sendCommand(channel, IO_ADS122U04_CMD_START);
    DEBUG_INFO("%s", "ADS122U04 Started\n");

    return true;
}

void IO_ADS122U04_stop(IO_ADS122U04_channel_E channel)
{
    HAL_serial_stop(IO_ADS122U04_channelConfig[channel].serialChannel);
}

bool IO_ADS122U04_receiveConversion(IO_ADS122U04_channel_E channel, uint32_t *conversion, uint32_t timeout_ms)
{
    uint8_t bval[3];
    const bool valid = HAL_serial_recieveDataTimeout(IO_ADS122U04_channelConfig[channel].serialChannel, &bval[0], 3, timeout_ms);
    *conversion = (bval[2] << 16) | (bval[1] << 8) | bval[0];
    return valid;
}

/**********************************************************************
 * End of File
 **********************************************************************/
