#ifndef I2C_H
#define I2C_H
#include <stdint.h>
#include <stdbool.h>
#include "I2C_private.h"

void i2c_setup(I2C *self, uint8_t scl, uint8_t sda, uint32_t khz, int pullup);
void i2c_start(I2C *self);
bool i2c_write(I2C *self, uint8_t byte);
uint8_t i2c_read(I2C *self, bool ack);
void i2c_stop(I2C *self);

#endif // I2C_H
