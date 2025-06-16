#include <stdbool.h>
#include <stdlib.h>
#include "I2C.h"

void i2c_setup(I2C *self, uint8_t scl, uint8_t sda, uint32_t khz, int pullup)
{
    self->setup(scl, sda, khz, pullup);
}

void i2c_start(I2C *self)
{
    self->start();
}

bool i2c_write(I2C *self, uint8_t byte)
{
    return self->write(byte);
}

uint8_t i2c_read(I2C *self, bool ack)
{
    return self->read(ack);
}

void i2c_stop(I2C *self)
{
    self->stop();
}
