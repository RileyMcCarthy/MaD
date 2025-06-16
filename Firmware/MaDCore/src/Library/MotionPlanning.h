#ifndef MotionPlanning_H
#define MotionPlanning_H
#include <math.h>

double steps_to_mm(int steps, double diameter, double stepmm);
int steps_to_um(int steps, double diameter, double stepmm);
int mm_to_steps(double mm, double diameter, double stepmm);
#endif
