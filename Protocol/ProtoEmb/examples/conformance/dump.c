/* Encode fixed values and print their wire bytes as hex (one struct per line).
   Used by verify.sh to prove C/Rust/TS agree on the wire byte-for-byte. */
#include "thermostat.h"
#include <stdio.h>
static void hex(const uint8_t *b, int n) { for (int i = 0; i < n; i++) printf("%02x", b[i]); printf("\n"); }
int main(void) {
    Thermostat_Reading_t r; r.temp = 23; r.humidity = 44;
    uint8_t b1[THERMOSTAT_READING_WIRE_SIZE]; Thermostat_Reading_encode(b1, &r); hex(b1, THERMOSTAT_READING_WIRE_SIZE);
    Thermostat_Datum_t d; d.channel = 7; d.value.tag = THERMOSTAT_SAMPLE_TAG_TEMPERATURE; d.value.u.temperature = 20;
    uint8_t b2[THERMOSTAT_DATUM_WIRE_SIZE]; Thermostat_Datum_encode(b2, &d); hex(b2, THERMOSTAT_DATUM_WIRE_SIZE);
    Thermostat_Datum_t d2; d2.channel = 3; d2.value.tag = THERMOSTAT_SAMPLE_TAG_HUMIDITY; d2.value.u.humidity = 55;
    uint8_t b3[THERMOSTAT_DATUM_WIRE_SIZE]; Thermostat_Datum_encode(b3, &d2); hex(b3, THERMOSTAT_DATUM_WIRE_SIZE);
    return 0;
}
