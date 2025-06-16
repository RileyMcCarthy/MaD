#ifndef WATCHDOG_H
#define WATCHDOG_H
#include <stdbool.h>
#include <stdint.h>
#include "watchdog_config.h"

void watchdog_init(int lock);
void watchdog_run(void);
void watchdog_kick(watchdog_channel_t channel);
bool watchdog_isAlive(watchdog_channel_t channel);
bool watchdog_isAllAlive(void);

#endif // WATCHDOG_H
