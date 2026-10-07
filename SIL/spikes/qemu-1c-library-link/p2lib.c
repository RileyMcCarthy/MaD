/*
 * SPIKE 1c: the smallest thing that proves QEMU can be driven as a library.
 *
 * system/main.c's main() is just qemu_init() -> qemu_main_loop() -> cleanup.
 * qemu_init() builds the machine, creates the CPU and its vCPU thread, and
 * (autostart) ends in qmp_cont() -> vm_start() -> resume_all_vcpus(). It
 * returns with the BQL and the replay mutex HELD -- main() releases both
 * before handing off, and so must we.
 *
 * So a host process only has to call qemu_init() and drop those two locks;
 * everything else main() does is the CLI's main loop, which the host replaces.
 */
#include "qemu/osdep.h"
#include "qemu/main-loop.h"
#include "system/replay.h"

void qemu_init(int argc, char **argv);

void p2lib_boot(int argc, char **argv)
{
    qemu_init(argc, argv);
    bql_unlock();
    replay_mutex_unlock();
}
