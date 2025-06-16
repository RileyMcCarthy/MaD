#include <stdint.h>
#include <stdbool.h>

typedef struct I2C_s {
    uint8_t scl;
    uint8_t sda;
    uint32_t khz;
    int pullup;
} I2C;
