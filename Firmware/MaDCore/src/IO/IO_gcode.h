#ifndef IO_GCODE_H
#define IO_GCODE_H

#include <stdbool.h>
#include "app_motion.h"
// should really be a library
/**
 * @brief Decodes a G-code string into a motion move structure
 *
 * @param gcode The G-code string to decode
 * @param move Pointer to the motion move structure to fill
 * @return true if decoding was successful
 * @return false if decoding failed
 */
bool IO_gcode_decodeMove(const char *gcode, app_motion_move_t *move);

/**
 * @brief Checks if a G-code string is the end test command (G144)
 *
 * @param gcode The G-code string to check
 * @return true if the string is G144
 * @return false otherwise
 */
bool IO_gcode_isEndTest(const char *gcode);

#endif // IO_GCODE_H
