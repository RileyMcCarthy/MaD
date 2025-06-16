#include "JSON.h"
#include <stdio.h>
#include "IO_Debug.h"

// Used for decoding string into tokens
#define MAX_TOKENS 300
static json_t mem[MAX_TOKENS];

// Used for encoding structure into a string
#define JSON_BUFFER_SIZE 5000
static char json_buffer[JSON_BUFFER_SIZE];

/* Decoding */

// THIS FUNCTION CANNOT HANDLE EMPTY STRING VALUES IDK WHY
bool json_property_to_string(const json_t *parser, const char *name, char *value, size_t max_length)
{
    const json_t *property = json_getProperty(parser, name);
    if (property == NULL || JSON_TEXT != json_getType(property))
    {
        //////DEBUG_ERROR("Error, the %s property is not found.\n", name);
        return false;
    }
    
    const char * temp = json_getValue(property);
    size_t length = strlen(temp)+1;

    if (length > max_length)
    {
        return false;
    }
    strncpy(value, temp, length);
    return true;
}

bool json_property_to_string_ref(const json_t *parser, const char *name, const char **value)
{
    const json_t *property = json_getProperty(parser, name);
    if (property == NULL || JSON_TEXT != json_getType(property))
    {
        ////DEBUG_ERROR("Error, the %s property is not found.\n", name);
        return false;
    }
    
    *value = json_getValue(property);
    return true;
}

bool json_property_to_int(const json_t *parser, const char *name, int *value)
{
    const json_t *property = json_getProperty(parser, name);
    if (!property || JSON_INTEGER != json_getType(property))
    {
        return false;
    }
    
    int temp = json_getInteger(property);
    memcpy(value, &temp, sizeof(int));
    return true;
}

bool json_property_to_uint32(const json_t *parser, const char *name, uint32_t *value)
{
    const json_t *property = json_getProperty(parser, name);
    if (!property || JSON_INTEGER != json_getType(property))
    {
        return false;
    }
    
    uint32_t temp = (uint32_t)json_getInteger(property);
    memcpy(value, &temp, sizeof(uint32_t));
    return true;
}

bool json_property_to_bool(const json_t *parser, const char *name, bool *value)
{
    const json_t *property = json_getProperty(parser, name);
    if (!property || JSON_BOOLEAN != json_getType(property))
    {
        ////DEBUG_ERROR("Error, the %s property is not found.\n", name);
        return false;
    }
    *value = json_getBoolean(property);
    return true;
}

// THIS FUNCTION DOESNT ENJOY ROUNDING, MAYBE USE INTEGERS ONLY? EWNDIDE TO 3 DECIMNALS?
bool json_property_to_double(const json_t *json, const char *name, double *value)
{
    const json_t *property = json_getProperty(json, name);
    if (!property || JSON_REAL != json_getType(property))
    {
        DEBUG_ERROR("Error, the %s property is not found.", name);
        return false;
    }
    double temp = json_getReal(property);
    memcpy(value, &temp, sizeof(double));
    return true;
}

int json_property_to_double_array(double *array, const json_t *json, const char *name)
{
    const json_t *properties = json_getProperty(json, name);
    int index = 0;
    for (const json_t *property = json_getChild(properties); property != 0; property = json_getSibling(property))
    {
        array[index] = json_getReal(property);
        index++;
    }

    return index;
}

const json_t * json_create_static(char *json)
{
    const json_t *parser = json_create(json, mem, MAX_TOKENS);
    if (parser == NULL)
    {
        DEBUG_ERROR("%s", "Error, failed to create json parser\n");
        return NULL;
    }
    return parser;
}

/* Encoding */

bool double_to_json(const char *name, double value)
{
    size_t buffer_length = strlen(json_buffer);
    int result = snprintf(json_buffer + buffer_length, JSON_BUFFER_SIZE - buffer_length, "\"%s\":%f,", name, value);
    if (result < 0 || result >= JSON_BUFFER_SIZE - buffer_length)
    {
        //DEBUG_PRINTF("Error: JSON string exceeded buffer size\n");
        return false;
    }
    return true;
}

bool int_to_json(const char *name, int value)
{
    size_t buffer_length = strlen(json_buffer);
    int result = snprintf(json_buffer + buffer_length, JSON_BUFFER_SIZE - buffer_length, "\"%s\":%d,", name, value);
    if (result < 0 || result >= JSON_BUFFER_SIZE - buffer_length)
    {
        //DEBUG_PRINTF("Error: JSON string exceeded buffer size\n");
        return false;
    }
    return true;
}

bool string_to_json(const char *name, const char *value)
{
    size_t buffer_length = strlen(json_buffer);
    int result = snprintf(json_buffer + buffer_length, JSON_BUFFER_SIZE - buffer_length, "\"%s\":\"%s\",", name, value);
    if (result < 0 || result >= JSON_BUFFER_SIZE - buffer_length)
    {
        //DEBUG_PRINTF("Error: JSON string exceeded buffer size\n");
        return false;
    }
    return true;
}

void clear_json_buffer()
{
    memset(json_buffer, 0, JSON_BUFFER_SIZE);
}

char *get_json_buffer()
{
    return json_buffer;
}

bool custom_string_to_json(const char *string)
{
    size_t buffer_length = strlen(json_buffer);
    int result = snprintf(json_buffer + buffer_length, JSON_BUFFER_SIZE - buffer_length, "%s", string);
    if (result < 0 || result >= JSON_BUFFER_SIZE - buffer_length)
    {
        //DEBUG_PRINTF("Error: JSON string exceeded buffer size\n");
        return false;
    }
    return true;
}

bool header_to_json(const char *name)
{
    size_t buffer_length = strlen(json_buffer);
    int result = snprintf(json_buffer + buffer_length, JSON_BUFFER_SIZE - buffer_length, "\"%s\":", name);
    if (result < 0 || result >= JSON_BUFFER_SIZE - buffer_length)
    {
        //DEBUG_PRINTF("Error: JSON string exceeded buffer size\n");
        return false;
    }
    return true;
}

bool close_json_block()
{
    size_t buffer_length = strlen(json_buffer);
    if (buffer_length + 1 >= JSON_BUFFER_SIZE)
    {
        //DEBUG_PRINTF("Error: JSON string exceeded buffer size\n");
        return false;
    }
    strcat(json_buffer, "}");
    return true;
}

bool open_json_block()
{
    size_t buffer_length = strlen(json_buffer);
    if (buffer_length + 1 >= JSON_BUFFER_SIZE)
    {
        //DEBUG_PRINTF("Error: JSON string exceeded buffer size\n");
        return false;
    }
    strcat(json_buffer, "{");
    return true;
}

bool json_append_comma()
{
    size_t buffer_length = strlen(json_buffer);
    if (buffer_length + 1 >= JSON_BUFFER_SIZE)
    {
        //DEBUG_PRINTF("Error: JSON string exceeded buffer size\n");
        return false;
    }
    strcat(json_buffer, ",");
    return true;
}

bool delete_json_last_comma()
{
    size_t buffer_length = strlen(json_buffer);
    json_buffer[buffer_length - 1] = '\0';
    return true;
}
