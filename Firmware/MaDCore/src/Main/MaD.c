#include <stdint.h>
#include <propeller2.h>
#include "MaD.h"
#include "JSON.h"
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
    _waitms(1000);
    _reboot();
  }

  dev_nvram_init(dev_nvram_lock);
  if (dev_nvram_nosync_runUntilReady() == false)
  {
    DEBUG_ERROR("%s", "WARNING NVRAM INIT FAILED!!!, Using failsafe records\n");
  }
}

void mad_begin()
{
  // Create a lock for the debug output
  _stdio_debug_lock = _locknew();
  if (_stdio_debug_lock == -1)
  {
    printf("WARNING NO LOCKS AVAILABLE!!!, EXITING PROGRAM\n");
    _waitms(1000);
    _reboot();
  }

  DEBUG_INFO("%s", "Starting MaD\n");

  // Start up nvram before everything else
  int criticalLock = _locknew();
  if (criticalLock == -1)
  {
    DEBUG_ERROR("%s", "WARNING NO LOCKS AVAILABLE!!!, EXITING PROGRAM\n");
    _waitms(1000);
    _reboot();
  }

  mad_startupNVRAM(criticalLock); // start the non-volatile memory system

  watchdog_init(criticalLock);
  dev_cogManager_init(criticalLock);

  app_notification_send(APP_NOTIFICATION_TYPE_SUCCESS, "Device is alive!\n");

  while (true)
  {
    dev_nvram_run();
    dev_cogManager_run();
    watchdog_run();
  }
}
