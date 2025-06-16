#include "MotionPlanning.h"
#define LIB_MOTION_PLANNING_PI 3.14159

double steps_to_mm(int steps, double diameter, double stepmm)
{
    return steps * (diameter * LIB_MOTION_PLANNING_PI) / stepmm;
}

int steps_to_um(int steps, double diameter, double stepmm)
{
    return (int)round(steps * (diameter * LIB_MOTION_PLANNING_PI) / stepmm * 1000);
}

int mm_to_steps(double mm, double diameter, double stepmm)
{
    return (int)round(mm * stepmm / (double)(diameter * LIB_MOTION_PLANNING_PI));
}
