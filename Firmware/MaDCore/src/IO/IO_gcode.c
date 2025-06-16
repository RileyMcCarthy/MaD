#include "IO_gcode.h"
#include "IO_Debug.h"
#include <string.h>
#include <stdio.h>

bool IO_gcode_decodeMove(const char *gcode, app_motion_move_t *move)
{
    if (!gcode || !move)
    {
        return false;
    }

    // Initialize move structure with default values
    move->g = 0;
    move->x = 0;
    move->f = 0;
    move->p = 0;

    // Make a copy of the gcode string since strtok modifies it
    char gcode_copy[256];
    strncpy(gcode_copy, gcode, sizeof(gcode_copy) - 1);
    gcode_copy[sizeof(gcode_copy) - 1] = '\0';

    // Parse each parameter
    char *token = strtok(gcode_copy, " ");
    while (token != NULL)
    {
        switch (token[0])
        {
        case 'G':
            sscanf(token + 1, "%hhu", &move->g);
            break;
        case 'X':
        {
            double x;
            if (sscanf(token + 1, "%lf", &x) == 1)
            {
                move->x = (int32_t)(x * 1000); // mm -> um
            }
            break;
        }
        case 'F':
        {
            double f;
            if (sscanf(token + 1, "%lf", &f) == 1)
            {
                move->f = (int32_t)(f * 1000); // mm/s -> um/s
            }
            break;
        }
        case 'P':
            sscanf(token + 1, "%u", &move->p);
            break;
        default:
            // Ignore unknown parameters
            break;
        }
        token = strtok(NULL, " ");
    }

    DEBUG_INFO("Decoded G-code: G%u X%.3f F%.3f P%u",
               move->g,
               (double)move->x / 1000.0,
               (double)move->f / 1000.0,
               move->p);
    return true;
}

bool IO_gcode_isEndTest(const char *gcode)
{
    return (gcode && strcmp(gcode, "G144") == 0);
}
