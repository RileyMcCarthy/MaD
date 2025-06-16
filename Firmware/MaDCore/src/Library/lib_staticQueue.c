#include "lib_staticQueue.h"
#include <propeller2.h>
#include <string.h>
#include <stdio.h>
#include "IO_Debug.h"

bool lib_staticQueue_init(lib_staticQueue_S *queue, void *buf, int max_size, int item_size, int lock)
{
    queue->buf = buf;
    queue->max_size = max_size;
    queue->item_size = item_size;
    queue->front = 0;
    queue->rear = 0;
    queue->lock = lock;
    return queue->lock != -1;
}

bool lib_staticQueue_push(lib_staticQueue_S *queue, void *data)
{
    if (data == NULL)
    {
        DEBUG_ERROR("%s", "lib_staticQueue_push: data is NULL\n");
        return false;
    }

    while (_locktry(queue->lock) == false)
    {
        // wait for lock
    }

    if (lib_staticQueue_isfull(queue))
    {
        DEBUG_ERROR("%s", "lib_staticQueue_push: data is FULL\n");
        _lockrel(queue->lock);
        exit(1);
        return false;
    }

    memcpy((void *)&(queue->buf[queue->rear * queue->item_size]), data, queue->item_size);
    queue->rear++;
    if (queue->rear == queue->max_size)
        queue->rear = 0;

    _lockrel(queue->lock);
    return true;
}

bool lib_staticQueue_pop(lib_staticQueue_S *queue, void *data)
{
    while (_locktry(queue->lock) == false)
    {
        // wait for lock
    }
    if (lib_staticQueue_isempty(queue))
    {
        _lockrel(queue->lock);
        return false;
    }

    if (data != NULL)
    {
        memcpy(data, &(queue->buf[queue->item_size * queue->front]), queue->item_size);
    }
    queue->front++;
    if (queue->front == queue->max_size)
    {
        queue->front = 0;
    }

    _lockrel(queue->lock);
    return true;
}

bool lib_staticQueue_isempty(lib_staticQueue_S *queue)
{
    return queue->rear == queue->front;
}

bool lib_staticQueue_isfull(lib_staticQueue_S *queue)
{
    return ((queue->rear + 1) % queue->max_size) == queue->front;
}

void lib_staticQueue_empty(lib_staticQueue_S *queue)
{
    while (_locktry(queue->lock) == 0)
    {
        // wait for lock
    }
    queue->front = 0;
    queue->rear = 0;
    _lockrel(queue->lock);
}

int32_t lib_staticQueue_count(lib_staticQueue_S *queue)
{
    while (_locktry(queue->lock) == 0)
    {
        // wait for lock
    }
    int count = 0;
    if (queue->rear >= queue->front)
    {
        count = queue->rear - queue->front;
    }
    else
    {
        count = queue->max_size - queue->front + queue->rear;
    }
    _lockrel(queue->lock);
    return count;
}
