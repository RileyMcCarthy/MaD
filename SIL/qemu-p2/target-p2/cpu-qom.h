/* Parallax Propeller 2 CPU QOM header. SPDX-License-Identifier: LGPL-2.1-or-later */
#ifndef TARGET_P2_CPU_QOM_H
#define TARGET_P2_CPU_QOM_H

#include "hw/core/cpu.h"

#define TYPE_P2_CPU "p2-cpu"

OBJECT_DECLARE_CPU_TYPE(P2CPU, P2CPUClass, P2_CPU)

#define P2_CPU_TYPE_SUFFIX "-" TYPE_P2_CPU
#define P2_CPU_TYPE_NAME(name) (name P2_CPU_TYPE_SUFFIX)

#endif
