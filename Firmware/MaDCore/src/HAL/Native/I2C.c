#include <stdbool.h>
#include <stdlib.h>
#include "I2C.h"

void i2c_setup(I2C *self, uint8_t scl, uint8_t sda, uint32_t khz, int pullup)
{
    return;
}

void i2c_start(I2C *self)
{
    return;
}

bool i2c_write(I2C *self, uint8_t byte)
{
    return false;
}

uint8_t i2c_read(I2C *self, bool ack)
{
    return 0;
}

void i2c_stop(I2C *self)
{
    return;
}
