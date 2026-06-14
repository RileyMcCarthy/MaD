#include <unity.h>
#include <stdint.h>
#include <string.h>

#include "lib_staticQueue.h"

/* Pin the queue's contract: unsynchronized ring buffer, one-writer-per-index
 * publication, capacity max_size − 1 (one slot kept open to distinguish full
 * from empty). */

#define QUEUE_SLOTS 4

void test_lib_staticQueue(void)
{
    lib_staticQueue_S queue;
    int32_t buffer[QUEUE_SLOTS];
    int32_t value;

    TEST_ASSERT_TRUE(lib_staticQueue_init(&queue, buffer, QUEUE_SLOTS, sizeof(int32_t)));
    TEST_ASSERT_FALSE(lib_staticQueue_init(&queue, buffer, 0, sizeof(int32_t)));
    TEST_ASSERT_TRUE(lib_staticQueue_init(&queue, buffer, QUEUE_SLOTS, sizeof(int32_t)));

    /* Fresh queue: empty, not full, count 0; pop fails. */
    TEST_ASSERT_TRUE(lib_staticQueue_isempty(&queue));
    TEST_ASSERT_FALSE(lib_staticQueue_isfull(&queue));
    TEST_ASSERT_EQUAL_INT32(0, lib_staticQueue_count(&queue));
    TEST_ASSERT_FALSE(lib_staticQueue_pop(&queue, &value));

    /* NULL data push is rejected. */
    TEST_ASSERT_FALSE(lib_staticQueue_push(&queue, NULL));

    /* Fill to capacity (max_size − 1), then the next push is rejected. */
    for (int32_t i = 0; i < QUEUE_SLOTS - 1; i++)
    {
        TEST_ASSERT_TRUE(lib_staticQueue_push(&queue, &i));
    }
    TEST_ASSERT_TRUE(lib_staticQueue_isfull(&queue));
    TEST_ASSERT_EQUAL_INT32(QUEUE_SLOTS - 1, lib_staticQueue_count(&queue));
    value = 99;
    TEST_ASSERT_FALSE(lib_staticQueue_push(&queue, &value));

    /* FIFO order out. */
    for (int32_t i = 0; i < QUEUE_SLOTS - 1; i++)
    {
        TEST_ASSERT_TRUE(lib_staticQueue_pop(&queue, &value));
        TEST_ASSERT_EQUAL_INT32(i, value);
    }
    TEST_ASSERT_TRUE(lib_staticQueue_isempty(&queue));

    /* Wraparound: interleaved push/pop walks the indices past max_size and the
     * count stays consistent across the wrap. */
    for (int32_t i = 0; i < 3 * QUEUE_SLOTS; i++)
    {
        TEST_ASSERT_TRUE(lib_staticQueue_push(&queue, &i));
        TEST_ASSERT_EQUAL_INT32(1, lib_staticQueue_count(&queue));
        TEST_ASSERT_TRUE(lib_staticQueue_pop(&queue, &value));
        TEST_ASSERT_EQUAL_INT32(i, value);
    }
    TEST_ASSERT_TRUE(lib_staticQueue_isempty(&queue));

    /* pop with NULL data discards the item but still advances. */
    value = 7;
    TEST_ASSERT_TRUE(lib_staticQueue_push(&queue, &value));
    TEST_ASSERT_TRUE(lib_staticQueue_pop(&queue, NULL));
    TEST_ASSERT_TRUE(lib_staticQueue_isempty(&queue));

    /* empty() resets a partially-filled queue. */
    value = 1;
    TEST_ASSERT_TRUE(lib_staticQueue_push(&queue, &value));
    TEST_ASSERT_TRUE(lib_staticQueue_push(&queue, &value));
    lib_staticQueue_empty(&queue);
    TEST_ASSERT_TRUE(lib_staticQueue_isempty(&queue));
    TEST_ASSERT_EQUAL_INT32(0, lib_staticQueue_count(&queue));
}
