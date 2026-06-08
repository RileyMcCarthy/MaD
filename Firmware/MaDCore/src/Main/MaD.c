#include <stdint.h>
#include "HAL_lock.h"
#include "HAL_time.h"
#include "HAL_system.h"
#include "MaD.h"
#include "app_motion.h"
#include "app_notification.h"
#include "IO_Debug.h"
#include "dev_nvram.h"
#include "watchdog.h"
#include "dev_cogManager.h"

int _stdio_debug_lock;

void mad_startupNVRAM(int dev_nvram_lock)
{
  if (dev_nvram_lock == -1)
  {
    DEBUG_ERROR("%s", "WARNING NO LOCKS AVAILABLE!!!, EXITING PROGRAM\n");
    HAL_time_waitMs(1000);
    HAL_system_reboot();
  }

  dev_nvram_init(dev_nvram_lock);
  if (dev_nvram_nosync_runUntilReady() == false)
  {
    DEBUG_ERROR("%s", "WARNING NVRAM INIT FAILED!!!, Using failsafe records\n");
    dev_nvram_forceSave(DEV_NVRAM_CHANNEL_MACHINE_PROFILE);
  }
}

void mad_begin()
{
  // Create a lock for the debug output
  _stdio_debug_lock = HAL_lock_create();
  if (_stdio_debug_lock == -1)
  {
    printf("WARNING NO LOCKS AVAILABLE!!!, EXITING PROGRAM\n");
    HAL_time_waitMs(1000);
    HAL_system_reboot();
  }

  DEBUG_INFO("%s", "Starting MaD\n");

  // Start up nvram before everything else
  int criticalLock = HAL_lock_create();
  if (criticalLock == -1)
  {
    DEBUG_ERROR("%s", "WARNING NO LOCKS AVAILABLE!!!, EXITING PROGRAM\n");
    HAL_time_waitMs(1000);
    HAL_system_reboot();
  }

  mad_startupNVRAM(criticalLock); // start the non-volatile memory system
  watchdog_init(criticalLock);
  dev_cogManager_init(criticalLock);

  while (true)
  {
    dev_nvram_run();
    dev_cogManager_run();
    watchdog_run();
    HAL_time_waitMs(100);
  }
}
