#include "JsonDecoder.h"
#include "JSON.h"
#include "IO_Debug.h"
#include <string.h>

/**
 * @brief Converts JSON string to a MachineProfile structure.
 *
 * @param json A JSON string containing a machine profile.
 * @return A MachineProfile structure containing the machine profile from JSON.
 */
bool json_to_machine_profile(MachineProfile *profile, char *json)
{
    const json_t *parser = json_create_static(json);
    const jsonType_t parserType = json_getType(parser);
    if ((profile == NULL) || (parser == NULL) || (parserType != JSON_OBJ))
    {
        DEBUG_ERROR("%s", "Error, the  JSON cannot be parsed.\n");
        return false;
    }
    bool success = true;
    success &= json_property_to_string(parser, "Name", profile->name, sizeof(profile->name));
    success &= json_property_to_int(parser, "Encoder (step/mm)", &(profile->encoderStepsPerMM));
    success &= json_property_to_int(parser, "Servo (step/mm)", &(profile->servoStepsPerMM));
    success &= json_property_to_int(parser, "Force Gauge (N/step)", &(profile->forceGaugeNPerStep));
    success &= json_property_to_int(parser, "Force Gauge Zero Offset (steps)", &(profile->forceGaugeZeroOffset));
    success &= json_property_to_int(parser, "Position Max (mm)", &(profile->maxPosition));
    success &= json_property_to_int(parser, "Velocity Max (mm/s)", &(profile->maxVelocity));
    success &= json_property_to_int(parser, "Acceleration Max (mm/s^2)", &(profile->maxAcceleration));
    success &= json_property_to_int(parser, "Tensile Force Max (N)", &(profile->maxForceTensile));
    DEBUG_INFO("SUCESS: %d\n", success);
    return success;
}

bool json_to_test_header_name(const char **name, char *json)
{
    // Use tiny-json to parse the string
    const json_t *parser = json_create_static(json);
    if (!parser || JSON_OBJ != json_getType(parser))
    {
        DEBUG_ERROR("%s", "Error, the  JSON cannot be parsed.\n");
        return false;
    }

    return json_property_to_string_ref(parser, "test_name", name);
}

// {G:0,X:254,F:1000}
bool json_to_move(lib_json_move_S *move, char *json)
{
    // Use tiny-json to parse the string
    // HII riley tmrw, looks like we a parsing floats into an integer pointer
    // should probally make a lib_json struct for the move using floats
    // then we can multiply to um and cast to int in messageSlave
    const json_t *parser = json_create_static(json);
    if (!parser || JSON_OBJ != json_getType(parser))
    {
        DEBUG_ERROR("%s", "Error, the  JSON cannot be parsed.\n");
        return false;
    }

    bool success = true;
    success &= json_property_to_int(parser, "G", &(move->g));
    if (success && (move->g == 0 || move->g == 1))
    {
        DEBUG_INFO("%s", "Parsing G0 or G1 mov\n");
        success &= json_property_to_double(parser, "X", &(move->x));
        success &= json_property_to_double(parser, "F", &(move->f));
    }
    else if (success && (move->g == 4))
    {
        DEBUG_INFO("%s", "Parsing G4 move\n");
        success &= json_property_to_int(parser, "P", &(move->p));
    }
    return success;
}

bool json_to_sample_profile(SampleProfile *profile, char *json)
{
    // Use tiny-json to parse the string
    const json_t *parser = json_create_static(json);
    if (!parser || JSON_OBJ != json_getType(parser))
    {
        DEBUG_ERROR("%s", "Error, the JSON cannot be parsed.\n");
        return false;
    }

    bool success = true;
    success &= json_property_to_uint32(parser, "maxForce", &(profile->maxForce));
    success &= json_property_to_uint32(parser, "maxVelocity", &(profile->maxVelocity));
    success &= json_property_to_uint32(parser, "maxDisplacement", &(profile->maxDisplacement));
    success &= json_property_to_uint32(parser, "sampleWidth", &(profile->sampleWidth));
    success &= json_property_to_uint32(parser, "serialNumber", &profile->serialNumber);

    return success;
}
