#ifndef JSON_H
#define JSON_H
#include "tiny-json.h"
#include <stdbool.h>
#include <stdint.h>
#include <string.h>

/** Decoding **/
bool json_property_to_string(const json_t *parser, const char *name, char *value, size_t length);
bool json_property_to_string_ref(const json_t *parser, const char *name, const char **value);
bool json_property_to_int(const json_t *parser, const char *name, int *value);
bool json_property_to_uint32(const json_t *parser, const char *name, uint32_t *value);
bool json_property_to_bool(const json_t *parser, const char *name, bool *value);
bool json_property_to_double(const json_t *json, const char *name, double *value);
int json_property_to_double_array(double *array, const json_t *json, const char *name);
const json_t *json_create_static(char *json);

/** Encoding **/
bool double_to_json(const char *name, double value);
bool int_to_json(const char *name, int value);
bool string_to_json(const char *name, const char *value);
bool custom_string_to_json(const char *string);
void clear_json_buffer();
char *get_json_buffer();
bool header_to_json(const char *name);
bool close_json_block();
bool open_json_block();
bool json_append_comma();
bool delete_json_last_comma();

#endif
