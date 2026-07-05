#include "lib_staticQueue.h"
#include <string.h>
#include <stdio.h>
#include "IO_Debug.h"

/* Unsynchronized by design — locking policy belongs to the owning module.
 * See the header for the SPSC lock-free contract this file upholds: each
 * index has exactly one writer, published as a single volatile store after
 * the slot data is written. */

bool lib_staticQueue_init(lib_staticQueue_S *queue, void *buf, int max_size, int item_size)
{
    queue->buf = buf;
    queue->max_size = max_size;
    queue->item_size = item_size;
    queue->front = 0;
    queue->rear = 0;
    return queue->max_size > 0;
}

bool lib_staticQueue_push(lib_staticQueue_S *queue, void *data)
{
    if (data == NULL)
    {
        DEBUG_ERROR("%s", "lib_staticQueue_push: data is NULL\n");
        return false;
    }

    if (lib_staticQueue_isfull(queue))
    {
        DEBUG_ERROR("%s", "lib_staticQueue_push: data is FULL\n");
        return false;
    }

    memcpy((void *)&(queue->buf[queue->rear * queue->item_size]), data, queue->item_size);
    /* Publish the slot, then advance `rear` in a single store (no transient
     * out-of-range value) so a lock-free consumer never sees a bad index. */
    int next = queue->rear + 1;
    if (next == queue->max_size)
    {
        next = 0;
    }
    queue->rear = next;
    return true;
}

bool lib_staticQueue_pop(lib_staticQueue_S *queue, void *data)
{
    if (lib_staticQueue_isempty(queue))
    {
        return false;
    }

    if (data != NULL)
    {
        memcpy(data, &(queue->buf[queue->item_size * queue->front]), queue->item_size);
    }
    int next = queue->front + 1;
    if (next == queue->max_size)
    {
        next = 0;
    }
    queue->front = next;
    return true;
}

bool lib_staticQueue_isempty(lib_staticQueue_S *queue)
{
    return queue->rear == queue->front;
}

bool lib_staticQueue_isfull(lib_staticQueue_S *queue)
{
    if (queue->max_size <= 0) {
        return true; // Consider invalid queue as full
    }
    return ((queue->rear + 1) % queue->max_size) == queue->front;
}

void lib_staticQueue_empty(lib_staticQueue_S *queue)
{
    queue->front = 0;
    queue->rear = 0;
}

int32_t lib_staticQueue_count(lib_staticQueue_S *queue)
{
    int count = 0;
    if (queue->rear >= queue->front)
    {
        count = queue->rear - queue->front;
    }
    else
    {
        count = queue->max_size - queue->front + queue->rear;
    }
    return count;
}
