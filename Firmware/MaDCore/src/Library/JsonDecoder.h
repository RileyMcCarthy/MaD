#ifndef JSONDECODER_H
#define JSONDECODER_H
/** Decoding API **/
#include <stdbool.h>
#include "app_motion.h"
#include "dev_nvram.h"

typedef struct TestDataRequest
{
    uint32_t index; // Index of the requested data
    uint8_t count;  // Number of data points requested
} TestDataRequest;

typedef struct
{
    int g;
    double x;
    double f;
    int p;
} lib_json_move_S;

bool json_to_machine_profile(MachineProfile *profile, char *json);
bool json_to_sample_profile(SampleProfile *profile, char *json);
bool json_to_test_data_request(TestDataRequest *request, char *json);
bool json_to_test_header_name(const char **name, char *json);
bool json_to_move(lib_json_move_S *move, char *json);

#endif // JSONDECODER_H
