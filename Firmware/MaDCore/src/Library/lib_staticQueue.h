#ifndef LIB_STATIC_QUEUE_H
#define LIB_STATIC_QUEUE_H
#include <stdbool.h>
#include <stdlib.h>
#include <stdint.h>

/* Unsynchronized ring-buffer queue — the OWNING MODULE decides how to lock.
 *
 * Concurrency contract:
 *  - SPSC is safe lock-free BY CONSTRUCTION: with at most one cog pushing and
 *    at most one cog popping (a single cog doing both is the degenerate case),
 *    no lock is needed — push() writes only `rear`, pop() writes only `front`,
 *    both as single stores of volatile aligned ints.
 *  - Anything more (multiple producers, multiple consumers, or compound
 *    operations like check-then-push) requires the CALLER to wrap calls in its
 *    own lock. Never call into another module while holding that lock.
 *  - isempty()/isfull()/count() are snapshot reads: exact under the caller's
 *    lock, advisory otherwise.
 */

typedef struct
{
    uint8_t *buf;
    /* volatile: read cross-cog (and cross-thread on the native emulator) in
     * lock-free SPSC use — keep loads/stores un-cached. */
    volatile int front;
    volatile int rear;
    int max_size;
    int item_size;
} lib_staticQueue_S;

bool lib_staticQueue_init(lib_staticQueue_S *queue, void *buf, int max_size, int item_size);
bool lib_staticQueue_push(lib_staticQueue_S *queue, void *data);
bool lib_staticQueue_pop(lib_staticQueue_S *queue, void *data);
void lib_staticQueue_empty(lib_staticQueue_S *queue);
bool lib_staticQueue_isempty(lib_staticQueue_S *queue);
bool lib_staticQueue_isfull(lib_staticQueue_S *queue);
int32_t lib_staticQueue_count(lib_staticQueue_S *queue);

#endif // LIB_STATIC_QUEUE_H
