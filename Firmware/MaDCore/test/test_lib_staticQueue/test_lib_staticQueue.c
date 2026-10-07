/*
 * Unit tests for lib_staticQueue — the fixed-capacity ring every sample the
 * machine records passes through on its way to the SD card.
 *
 * This suite exists because the module had none. lib_staticQueue.c is compiled
 * into every test binary already (build_src_filter +<Library/>), so it was
 * linked into all 306 existing tests and exercised by none of them — the one
 * data structure between a 1 kHz sampler and the card, with no coverage.
 *
 * The contract under test is the SPSC ring's, not a container library's: what
 * matters is that a full queue REFUSES rather than overwrites (an overwrite
 * loses the oldest sample and nothing downstream could tell), that the wrap is
 * exact, and that count() agrees with what is actually in the ring on both
 * sides of it.
 */
#include <unity.h>
#include <stdint.h>
#include <stdbool.h>
#include <string.h>
#include "lib_staticQueue.h"
#include "vibes_behaviour.h"

/* Four slots, so the usable capacity is three and the wrap arrives quickly. */
#define SLOTS 4
static lib_staticQueue_S q;
static int32_t storage[SLOTS];

static bool push(int32_t v) { return lib_staticQueue_push(&q, &v); }

void setUp(void)
{
    memset(storage, 0, sizeof(storage));
    TEST_ASSERT_TRUE(lib_staticQueue_init(&q, storage, SLOTS, (int)sizeof(int32_t)));
}
void tearDown(void) {}

void test_a_fresh_queue_is_empty_and_holds_nothing(void)
{
    VIBES_TEST("queue.fresh-is-empty",
               "src/Library/lib_staticQueue.c#lib_staticQueue_init",
               "a queue initialised over a four-slot buffer");
    VIBES_EXPECT("empty", "the queue reports empty and a count of zero");
    VIBES_EXPECT_WHY("pop-refuses",
                     "a pop returns false and leaves the caller's variable untouched",
                     "a consumer that trusted the return would otherwise log whatever happened to be on its stack as a real sample");

    TEST_ASSERT_TRUE(lib_staticQueue_isempty(&q));
    TEST_ASSERT_FALSE(lib_staticQueue_isfull(&q));
    TEST_ASSERT_EQUAL_INT32(0, lib_staticQueue_count(&q));

    int32_t out = 0x5A5A5A5A;
    TEST_ASSERT_FALSE(lib_staticQueue_pop(&q, &out));
    TEST_ASSERT_EQUAL_INT32(0x5A5A5A5A, out);
}

void test_items_come_back_in_the_order_they_went_in(void)
{
    VIBES_TEST("queue.fifo-order",
               "src/Library/lib_staticQueue.c#lib_staticQueue_pop",
               "three values pushed in ascending order");
    VIBES_EXPECT_WHY("fifo",
                     "they pop in the same order they were pushed",
                     "the queue carries a time series, so an order inversion would reorder a stress-strain curve rather than lose it, which is far harder to notice");

    TEST_ASSERT_TRUE(push(10));
    TEST_ASSERT_TRUE(push(20));
    TEST_ASSERT_TRUE(push(30));
    TEST_ASSERT_EQUAL_INT32(3, lib_staticQueue_count(&q));

    int32_t out = 0;
    TEST_ASSERT_TRUE(lib_staticQueue_pop(&q, &out));
    TEST_ASSERT_EQUAL_INT32(10, out);
    TEST_ASSERT_TRUE(lib_staticQueue_pop(&q, &out));
    TEST_ASSERT_EQUAL_INT32(20, out);
    TEST_ASSERT_TRUE(lib_staticQueue_pop(&q, &out));
    TEST_ASSERT_EQUAL_INT32(30, out);
    TEST_ASSERT_TRUE(lib_staticQueue_isempty(&q));
}

void test_the_usable_capacity_is_one_less_than_the_buffer(void)
{
    VIBES_TEST("queue.capacity-is-slots-minus-one",
               "src/Library/lib_staticQueue.c#lib_staticQueue_isfull",
               "a four-slot queue filled until it refuses");
    VIBES_EXPECT_WHY("three-of-four",
                     "exactly three pushes succeed and the fourth is refused",
                     "one slot is spent distinguishing full from empty, so a caller sizing a buffer for N samples gets N-1 and needs to know it");

    TEST_ASSERT_TRUE(push(1));
    TEST_ASSERT_TRUE(push(2));
    TEST_ASSERT_TRUE(push(3));
    TEST_ASSERT_TRUE(lib_staticQueue_isfull(&q));
    TEST_ASSERT_FALSE(push(4));
    TEST_ASSERT_EQUAL_INT32(3, lib_staticQueue_count(&q));
}

void test_a_full_queue_refuses_rather_than_dropping_the_oldest(void)
{
    VIBES_TEST("queue.full-refuses-not-overwrites",
               "src/Library/lib_staticQueue.c#lib_staticQueue_push",
               "a full queue offered a further value");
    VIBES_EXPECT_WHY("oldest-survives",
                     "the push is refused and the values already queued are unchanged",
                     "backpressure must lose the NEW sample and say so, because silently overwriting the oldest punches a hole in the middle of a recorded test that no downstream check could detect");

    TEST_ASSERT_TRUE(push(1));
    TEST_ASSERT_TRUE(push(2));
    TEST_ASSERT_TRUE(push(3));
    TEST_ASSERT_FALSE(push(99));

    /* The refusal is not a silent overwrite: the ring still holds 1,2,3. */
    int32_t out = 0;
    TEST_ASSERT_TRUE(lib_staticQueue_pop(&q, &out));
    TEST_ASSERT_EQUAL_INT32(1, out);
    TEST_ASSERT_TRUE(lib_staticQueue_pop(&q, &out));
    TEST_ASSERT_EQUAL_INT32(2, out);
    TEST_ASSERT_TRUE(lib_staticQueue_pop(&q, &out));
    TEST_ASSERT_EQUAL_INT32(3, out);
}

void test_the_ring_wraps_without_losing_or_reordering(void)
{
    VIBES_TEST("queue.wrap-is-exact",
               "src/Library/lib_staticQueue.c#lib_staticQueue_push",
               "twenty push/pop cycles through a four-slot ring, which wraps five times");
    VIBES_EXPECT_WHY("survives-the-wrap",
                     "every value comes back exactly once and in order across every wrap",
                     "the indices wrap by hand rather than by masking, so an off-by-one at the fold would corrupt only the samples that straddle it and only after the queue had been running a while");

    int32_t out = 0;
    for (int32_t i = 0; i < 20; i++)
    {
        TEST_ASSERT_TRUE(push(i));
        TEST_ASSERT_TRUE(lib_staticQueue_pop(&q, &out));
        TEST_ASSERT_EQUAL_INT32(i, out);
        TEST_ASSERT_TRUE(lib_staticQueue_isempty(&q));
    }
}

void test_count_is_right_on_both_sides_of_the_fold(void)
{
    VIBES_TEST("queue.count-across-the-fold",
               "src/Library/lib_staticQueue.c#lib_staticQueue_count",
               "a queue whose write index has wrapped past its read index");
    VIBES_EXPECT_WHY("both-branches",
                     "count reports the true occupancy whether the write index is ahead of the read index or behind it",
                     "count() takes a different branch in each case and the wrapped branch is the one a long run spends most of its time in, so an error there under-reports backpressure exactly when it matters");

    /* Advance both indices so that a later push folds rear past front. */
    TEST_ASSERT_TRUE(push(1));
    TEST_ASSERT_TRUE(push(2));
    int32_t out = 0;
    TEST_ASSERT_TRUE(lib_staticQueue_pop(&q, &out)); /* front = 1 */
    TEST_ASSERT_TRUE(lib_staticQueue_pop(&q, &out)); /* front = 2, rear = 2 */
    TEST_ASSERT_EQUAL_INT32(0, lib_staticQueue_count(&q));

    TEST_ASSERT_TRUE(push(3)); /* rear = 3 : rear > front */
    TEST_ASSERT_EQUAL_INT32(1, lib_staticQueue_count(&q));
    TEST_ASSERT_TRUE(push(4)); /* rear wraps to 0 : rear < front */
    TEST_ASSERT_EQUAL_INT32(2, lib_staticQueue_count(&q));
    TEST_ASSERT_TRUE(push(5)); /* rear = 1 : still folded */
    TEST_ASSERT_EQUAL_INT32(3, lib_staticQueue_count(&q));
    TEST_ASSERT_TRUE(lib_staticQueue_isfull(&q));

    TEST_ASSERT_TRUE(lib_staticQueue_pop(&q, &out));
    TEST_ASSERT_EQUAL_INT32(3, out);
    TEST_ASSERT_TRUE(lib_staticQueue_pop(&q, &out));
    TEST_ASSERT_EQUAL_INT32(4, out);
    TEST_ASSERT_TRUE(lib_staticQueue_pop(&q, &out));
    TEST_ASSERT_EQUAL_INT32(5, out);
    TEST_ASSERT_EQUAL_INT32(0, lib_staticQueue_count(&q));
}

void test_a_null_payload_is_refused_rather_than_copied(void)
{
    VIBES_TEST("queue.null-payload-refused",
               "src/Library/lib_staticQueue.c#lib_staticQueue_push",
               "a push handed a null data pointer");
    VIBES_EXPECT_WHY("refused",
                     "the push returns false and the queue stays empty",
                     "the alternative is a memcpy from address zero inside the sampling path, which on the P2 reads the interrupt vectors rather than trapping");

    TEST_ASSERT_FALSE(lib_staticQueue_push(&q, NULL));
    TEST_ASSERT_TRUE(lib_staticQueue_isempty(&q));
}

void test_a_pop_may_discard_without_a_destination(void)
{
    VIBES_TEST("queue.pop-null-discards",
               "src/Library/lib_staticQueue.c#lib_staticQueue_pop",
               "a pop with a null destination on a queue holding one value");
    VIBES_EXPECT_WHY("consumed-not-copied",
                     "the value is consumed and the queue becomes empty",
                     "the drain path uses this to throw away a record it cannot write, so a null destination has to advance the ring rather than refuse");

    TEST_ASSERT_TRUE(push(7));
    TEST_ASSERT_TRUE(lib_staticQueue_pop(&q, NULL));
    TEST_ASSERT_TRUE(lib_staticQueue_isempty(&q));
}

void test_empty_discards_everything_queued(void)
{
    VIBES_TEST("queue.empty-resets",
               "src/Library/lib_staticQueue.c#lib_staticQueue_empty",
               "a queue holding values, then emptied");
    VIBES_EXPECT("reset", "the queue reports empty with a count of zero and accepts a full load again");

    TEST_ASSERT_TRUE(push(1));
    TEST_ASSERT_TRUE(push(2));
    lib_staticQueue_empty(&q);
    TEST_ASSERT_TRUE(lib_staticQueue_isempty(&q));
    TEST_ASSERT_EQUAL_INT32(0, lib_staticQueue_count(&q));
    TEST_ASSERT_TRUE(push(1));
    TEST_ASSERT_TRUE(push(2));
    TEST_ASSERT_TRUE(push(3));
    TEST_ASSERT_TRUE(lib_staticQueue_isfull(&q));
}

void test_a_zero_sized_queue_reports_full_and_never_writes(void)
{
    VIBES_TEST("queue.zero-sized-refuses",
               "src/Library/lib_staticQueue.c#lib_staticQueue_init",
               "a queue initialised with a maximum size of zero");
    VIBES_EXPECT_WHY("init-reports-failure",
                     "init returns false, the queue reports full, and every push is refused",
                     "a misconfigured channel must not turn into a memcpy against a zero-length buffer; reporting full is what makes the refusal happen at the push rather than at the write");

    lib_staticQueue_S bad;
    int32_t none[1] = { 0 };
    TEST_ASSERT_FALSE(lib_staticQueue_init(&bad, none, 0, (int)sizeof(int32_t)));
    TEST_ASSERT_TRUE(lib_staticQueue_isfull(&bad));

    int32_t v = 1;
    TEST_ASSERT_FALSE(lib_staticQueue_push(&bad, &v));
    TEST_ASSERT_EQUAL_INT32(0, none[0]);
}

int main(void)
{
    UNITY_BEGIN();
    RUN_TEST(test_a_fresh_queue_is_empty_and_holds_nothing);
    RUN_TEST(test_items_come_back_in_the_order_they_went_in);
    RUN_TEST(test_the_usable_capacity_is_one_less_than_the_buffer);
    RUN_TEST(test_a_full_queue_refuses_rather_than_dropping_the_oldest);
    RUN_TEST(test_the_ring_wraps_without_losing_or_reordering);
    RUN_TEST(test_count_is_right_on_both_sides_of_the_fold);
    RUN_TEST(test_a_null_payload_is_refused_rather_than_copied);
    RUN_TEST(test_a_pop_may_discard_without_a_destination);
    RUN_TEST(test_empty_discards_everything_queued);
    RUN_TEST(test_a_zero_sized_queue_reports_full_and_never_writes);
    return UNITY_END();
}
