#ifndef LIB_STATIC_QUEUE_H
#define LIB_STATIC_QUEUE_H
#include <stdbool.h>
#include <stdlib.h>
#include <stdint.h>

typedef struct
{
    uint8_t *buf;
    int front;
    int rear;
    int size;
    int max_size;
    int item_size;
    int lock;
} lib_staticQueue_S;

bool lib_staticQueue_init(lib_staticQueue_S *queue, void *buf, int max_size, int item_size, int lock);
bool lib_staticQueue_push(lib_staticQueue_S *queue, void *data);
bool lib_staticQueue_pop(lib_staticQueue_S *queue, void *data);
void lib_staticQueue_empty(lib_staticQueue_S *queue);
bool lib_staticQueue_isempty(lib_staticQueue_S *queue);
bool lib_staticQueue_isfull(lib_staticQueue_S *queue);
int32_t lib_staticQueue_count(lib_staticQueue_S *queue);

#endif // LIB_STATIC_QUEUE_H
