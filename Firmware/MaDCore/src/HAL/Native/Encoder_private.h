#include <stdint.h>
#include <stdbool.h>

typedef struct Encoder_e {
    int32_t socket_a;
    int32_t socket_b;
    uint8_t btn;
    bool d4x;
    int32_t preset;
    int32_t lo;
    int32_t hi;
    int32_t value;
} Encoder;
