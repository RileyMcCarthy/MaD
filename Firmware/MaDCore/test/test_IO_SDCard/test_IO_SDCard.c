// Native Unity unit-test suite for src/IO/IO_SDCard.c
//
// Self-contained suite per the project test harness:
//  - #include the module under test by relative path (its peers — lib_staticQueue,
//    HAL mocks — are compiled/linked globally; we use the REAL static queue).
//  - We provide our OWN IO_SDCard_config (the real Config/IO_SDCard_config.c is NOT
//    compiled into this suite) so the suite does not depend on app_monitor / app_motion.
//  - File I/O uses real temp files under ./test/sd/ with per-test cleanup.
//
// IMPORTANT harness note: this suite defines its own main()/setUp()/tearDown() as a
// folder-isolated suite is expected to. See the coverage report for the harness caveat
// on this branch.

#include <unity.h>
#include <string.h>
#include <stdio.h>
#include <stdint.h>
#include <stdbool.h>
#include <unistd.h> /* rmdir — tearing down the provisioned-directory fixture */

#include "HAL_lock.h"

// ---- Module under test (pulled in by source include) --------------------------------
#include "../../src/IO/IO_SDCard.c"

// mock_propeller2.c provides these (test root, auto-linked):
extern void HAL_lock_mock_reset(void);

// IO_Debug.h (ENABLE_DEBUG_SERIAL=1) emits DEBUG_* output guarded by _stdio_debug_lock.
// mock_propeller2.c does NOT define it; the suite owns it.
extern int _stdio_debug_lock; /* shared in mock_propeller2.c */

// -------------------------------------------------------------------------------------
// Test-local config (replaces the real Config/IO_SDCard_config.c).
// Two channels matching IO_SDCARD_CHANNEL_COUNT == 2 (SAMPLE_DATA, GCODE).
// We use a small item type and a small queue so we can force full/empty deterministically.
// -------------------------------------------------------------------------------------
typedef struct
{
    uint32_t a;
    uint32_t b;
} test_item_S;

#define TEST_ITEM_SIZE (sizeof(test_item_S))
#define TEST_QUEUE_LEN 4u // circular buffer of 4 slots => holds 3 usable items

static test_item_S sampleBuffer[TEST_QUEUE_LEN];
static test_item_S gcodeBuffer[TEST_QUEUE_LEN];

// nameFormat: single %s for the base name; land files in the existing ./test/sd/ dir.
static const char sampleNameFormat[] = "./test/sd/iosd_sample_%s.bin";
static const char gcodeNameFormat[] = "./test/sd/iosd_gcode_%s.bin";

// A path nested under directories that do NOT exist — the shape the real channel
// configs use (`<mount>/gcode/%s.bin`) on a card that has never held a test.
static const char nestedNameFormat[] = "./test/sd/iosd_fresh/gcode/%s.bin";
static const char nestedFilePath[] = "./test/sd/iosd_fresh/gcode/unit.bin";

// The module declares `extern IO_SDCard_config_S IO_SDCard_config;` — define it here.
IO_SDCard_config_S IO_SDCard_config = {
    {
        {sampleBuffer, TEST_QUEUE_LEN, TEST_ITEM_SIZE, sampleNameFormat},
        {gcodeBuffer, TEST_QUEUE_LEN, TEST_ITEM_SIZE, gcodeNameFormat},
    },
};

// Resolved temp file paths (computed from nameFormat for cleanup / direct fopen checks).
static char sampleFilePath[255];
static char gcodeFilePath[255];

// -------------------------------------------------------------------------------------
// Helpers
// -------------------------------------------------------------------------------------
static const char *const TEST_BASE_NAME = "unit";

static void buildPaths(void)
{
    snprintf(sampleFilePath, sizeof(sampleFilePath), sampleNameFormat, TEST_BASE_NAME);
    snprintf(gcodeFilePath, sizeof(gcodeFilePath), gcodeNameFormat, TEST_BASE_NAME);
}

static void removeTempFiles(void)
{
    remove(sampleFilePath);
    remove(gcodeFilePath);
}

// Delete the whole provisioned tree so the nested test always starts from "these
// directories do not exist" — the condition that made the bug invisible on a dev
// machine (where a previous run had already created them) and fatal in CI.
static void removeNestedTree(void)
{
    remove(nestedFilePath);
    rmdir("./test/sd/iosd_fresh/gcode");
    rmdir("./test/sd/iosd_fresh");
}

// Pump the state machine N times.
static void runN(uint32_t n)
{
    for (uint32_t i = 0; i < n; i++)
    {
        IO_SDCard_run();
    }
}

// Write `count` known items directly to a channel file so READ-mode tests have data.
static void seedFile(const char *path, uint32_t count)
{
    FILE *f = fopen(path, "wb");
    TEST_ASSERT_NOT_NULL(f);
    for (uint32_t i = 0; i < count; i++)
    {
        test_item_S item = {.a = i, .b = i * 10u + 1u};
        TEST_ASSERT_EQUAL_UINT(1u, (unsigned)fwrite(&item, TEST_ITEM_SIZE, 1, f));
    }
    fclose(f);
}

// Read back the whole channel file into caller buffer; returns item count.
static uint32_t readFileItems(const char *path, test_item_S *out, uint32_t maxItems)
{
    FILE *f = fopen(path, "rb");
    if (f == NULL)
    {
        return 0;
    }
    uint32_t n = (uint32_t)fread(out, TEST_ITEM_SIZE, maxItems, f);
    fclose(f);
    return n;
}

// -------------------------------------------------------------------------------------
// setUp / tearDown
// -------------------------------------------------------------------------------------
void setUp(void)
{
    HAL_lock_mock_reset();
    _stdio_debug_lock = HAL_lock_create();
    int lock = HAL_lock_create();
    buildPaths();
    removeTempFiles();
    removeNestedTree();
    IO_SDCard_init(lock); // resets state to INIT, file=NULL, eof=false, queues empty
}

void tearDown(void)
{
    removeTempFiles();
    removeNestedTree();
    // The nested-path test repoints this channel; restore it here rather than at
    // the end of that test, so a failed assertion (Unity longjmps out) cannot
    // leak the override into every test that runs after it.
    IO_SDCard_config.channelConfig[IO_SDCARD_CHANNEL_GCODE].nameFormat = gcodeNameFormat;
}

// =====================================================================================
// Public API guard / boundary tests (no run loop)
// =====================================================================================

static void test_open_rejects_out_of_range_channel(void)
{
    TEST_ASSERT_FALSE(IO_SDCard_open(IO_SDCARD_CHANNEL_COUNT, TEST_BASE_NAME, IO_SDCARD_MODE_WRITE));
}

static void test_close_rejects_out_of_range_channel(void)
{
    TEST_ASSERT_FALSE(IO_SDCard_close(IO_SDCARD_CHANNEL_COUNT));
}

static void test_isClosed_true_after_init_and_false_for_bad_channel(void)
{
    TEST_ASSERT_TRUE(IO_SDCard_isClosed(IO_SDCARD_CHANNEL_SAMPLE_DATA));
    TEST_ASSERT_TRUE(IO_SDCard_isClosed(IO_SDCARD_CHANNEL_GCODE));
    // Out of range -> returns default false.
    TEST_ASSERT_FALSE(IO_SDCard_isClosed(IO_SDCARD_CHANNEL_COUNT));
}

static void test_push_size_mismatch_rejected(void)
{
    test_item_S item = {.a = 1, .b = 2};
    // Wrong size -> rejected, no enqueue.
    TEST_ASSERT_FALSE(IO_SDCard_push(IO_SDCARD_CHANNEL_SAMPLE_DATA, &item, TEST_ITEM_SIZE - 1u));
    // Correct size -> accepted.
    TEST_ASSERT_TRUE(IO_SDCard_push(IO_SDCARD_CHANNEL_SAMPLE_DATA, &item, TEST_ITEM_SIZE));
    // Out of range channel -> rejected.
    TEST_ASSERT_FALSE(IO_SDCard_push(IO_SDCARD_CHANNEL_COUNT, &item, TEST_ITEM_SIZE));
}

// =====================================================================================
// Queue passthrough: push/pop/popMultiple against the REAL static queue
// =====================================================================================

static void test_push_pop_roundtrip(void)
{
    test_item_S in = {.a = 42, .b = 99};
    TEST_ASSERT_TRUE(IO_SDCard_push(IO_SDCARD_CHANNEL_SAMPLE_DATA, &in, TEST_ITEM_SIZE));

    test_item_S out = {0};
    TEST_ASSERT_TRUE(IO_SDCard_pop(IO_SDCARD_CHANNEL_SAMPLE_DATA, &out));
    TEST_ASSERT_EQUAL_UINT32(42, out.a);
    TEST_ASSERT_EQUAL_UINT32(99, out.b);

    // Now empty -> pop fails.
    TEST_ASSERT_FALSE(IO_SDCard_pop(IO_SDCARD_CHANNEL_SAMPLE_DATA, &out));
    // Out of range pop -> false.
    TEST_ASSERT_FALSE(IO_SDCard_pop(IO_SDCARD_CHANNEL_COUNT, &out));
}

static void test_push_until_full_boundary(void)
{
    // Circular buffer of TEST_QUEUE_LEN slots holds TEST_QUEUE_LEN-1 usable items.
    uint32_t usable = TEST_QUEUE_LEN - 1u;
    for (uint32_t i = 0; i < usable; i++)
    {
        test_item_S item = {.a = i, .b = i};
        TEST_ASSERT_TRUE(IO_SDCard_push(IO_SDCARD_CHANNEL_GCODE, &item, TEST_ITEM_SIZE));
    }
    // One more must fail (full).
    test_item_S overflow = {.a = 0xDEAD, .b = 0xBEEF};
    TEST_ASSERT_FALSE(IO_SDCard_push(IO_SDCARD_CHANNEL_GCODE, &overflow, TEST_ITEM_SIZE));
}

static void test_popMultiple_counts_and_guards(void)
{
    uint32_t usable = TEST_QUEUE_LEN - 1u; // 3
    for (uint32_t i = 0; i < usable; i++)
    {
        test_item_S item = {.a = i + 1u, .b = (i + 1u) * 2u};
        TEST_ASSERT_TRUE(IO_SDCard_push(IO_SDCARD_CHANNEL_SAMPLE_DATA, &item, TEST_ITEM_SIZE));
    }

    test_item_S out[TEST_QUEUE_LEN] = {0};
    // Ask for more than available -> get exactly `usable`.
    uint32_t got = IO_SDCard_popMultiple(IO_SDCARD_CHANNEL_SAMPLE_DATA, out, TEST_QUEUE_LEN);
    TEST_ASSERT_EQUAL_UINT32(usable, got);
    TEST_ASSERT_EQUAL_UINT32(1u, out[0].a);
    TEST_ASSERT_EQUAL_UINT32(2u, out[0].b);
    TEST_ASSERT_EQUAL_UINT32(usable, out[usable - 1u].a);

    // Empty now -> returns 0.
    TEST_ASSERT_EQUAL_UINT32(0u, IO_SDCard_popMultiple(IO_SDCARD_CHANNEL_SAMPLE_DATA, out, TEST_QUEUE_LEN));

    // Guard paths: NULL buffer, zero maxCount, bad channel.
    TEST_ASSERT_EQUAL_UINT32(0u, IO_SDCard_popMultiple(IO_SDCARD_CHANNEL_SAMPLE_DATA, NULL, 1u));
    TEST_ASSERT_EQUAL_UINT32(0u, IO_SDCard_popMultiple(IO_SDCARD_CHANNEL_SAMPLE_DATA, out, 0u));
    TEST_ASSERT_EQUAL_UINT32(0u, IO_SDCard_popMultiple(IO_SDCARD_CHANNEL_COUNT, out, 1u));
}

// =====================================================================================
// State machine: WRITE session open -> active -> close (file content verified)
// =====================================================================================

static void test_write_session_opens_flushes_and_closes(void)
{
    TEST_ASSERT_TRUE(IO_SDCard_open(IO_SDCARD_CHANNEL_SAMPLE_DATA, TEST_BASE_NAME, IO_SDCARD_MODE_WRITE));

    // run #1: stage enable, INIT->OPEN entry fopen("wb"); run #2: OPEN->ACTIVE.
    runN(2);
    TEST_ASSERT_FALSE(IO_SDCard_isClosed(IO_SDCARD_CHANNEL_SAMPLE_DATA));
    TEST_ASSERT_FALSE(IO_SDCard_lastOpenFailed(IO_SDCARD_CHANNEL_SAMPLE_DATA));

    // Queue a few items, then run so processWrite() drains them to the file.
    for (uint32_t i = 0; i < 3u; i++)
    {
        test_item_S item = {.a = 100u + i, .b = 200u + i};
        TEST_ASSERT_TRUE(IO_SDCard_push(IO_SDCARD_CHANNEL_SAMPLE_DATA, &item, TEST_ITEM_SIZE));
    }
    runN(1); // ACTIVE: processWrite drains queue to file + fflush

    // File should now contain the 3 items (fflush makes them visible).
    test_item_S readBack[8] = {0};
    uint32_t n = readFileItems(sampleFilePath, readBack, 8);
    TEST_ASSERT_EQUAL_UINT32(3u, n);
    TEST_ASSERT_EQUAL_UINT32(100u, readBack[0].a);
    TEST_ASSERT_EQUAL_UINT32(202u, readBack[2].b);

    // Request close; WRITE close requires queue empty (it is) -> ACTIVE->CLOSE->INIT.
    TEST_ASSERT_TRUE(IO_SDCard_close(IO_SDCARD_CHANNEL_SAMPLE_DATA));
    runN(3); // stage disable -> ACTIVE->CLOSE (entry fclose) -> CLOSE->INIT
    TEST_ASSERT_TRUE(IO_SDCard_isClosed(IO_SDCARD_CHANNEL_SAMPLE_DATA));
}

static void test_write_close_flushes_remaining_queue_on_close(void)
{
    TEST_ASSERT_TRUE(IO_SDCard_open(IO_SDCARD_CHANNEL_GCODE, TEST_BASE_NAME, IO_SDCARD_MODE_WRITE));
    runN(2); // INIT->OPEN->ACTIVE

    // Push items but DO NOT run an active cycle to drain them; request close in the
    // same turn. close requires queueEmpty to transition; the entry action for CLOSE
    // flushes remaining data via processWrite before fclose. We must reach an ACTIVE
    // cycle that drains the queue first (queueEmpty gate), so:
    for (uint32_t i = 0; i < 2u; i++)
    {
        test_item_S item = {.a = i, .b = i + 7u};
        TEST_ASSERT_TRUE(IO_SDCard_push(IO_SDCARD_CHANNEL_GCODE, &item, TEST_ITEM_SIZE));
    }
    IO_SDCard_close(IO_SDCARD_CHANNEL_GCODE);

    // run: processWrite drains queue (queueEmpty becomes true next stageInputs);
    // need enough cycles for disable+empty gate to fire then CLOSE->INIT.
    runN(4);
    TEST_ASSERT_TRUE(IO_SDCard_isClosed(IO_SDCARD_CHANNEL_GCODE));

    test_item_S readBack[8] = {0};
    uint32_t n = readFileItems(gcodeFilePath, readBack, 8);
    TEST_ASSERT_EQUAL_UINT32(2u, n);
    TEST_ASSERT_EQUAL_UINT32(8u, readBack[1].b);
}

// Regression: `fopen(path, "wb")` creates the file but not the directories above
// it, so on a card that has never held a test — a freshly formatted SD, or the
// SIL emulator's SD root in a clean checkout — every WRITE open failed with
// ENOENT. The G-code for a test was therefore never stored, the run executed
// zero moves and never completed. It reproduced only on a virgin card, which is
// why it never showed on a dev machine and failed every CI run.
static void test_write_open_provisions_missing_directories(void)
{
    IO_SDCard_config.channelConfig[IO_SDCARD_CHANNEL_GCODE].nameFormat = nestedNameFormat;

    TEST_ASSERT_TRUE(IO_SDCard_open(IO_SDCARD_CHANNEL_GCODE, TEST_BASE_NAME, IO_SDCARD_MODE_WRITE));
    runN(2); // INIT->OPEN (provision path, then fopen "wb") -> ACTIVE
    TEST_ASSERT_FALSE(IO_SDCard_lastOpenFailed(IO_SDCARD_CHANNEL_GCODE));
    TEST_ASSERT_FALSE(IO_SDCard_isClosed(IO_SDCARD_CHANNEL_GCODE));

    const test_item_S item = {.a = 42u, .b = 43u};
    TEST_ASSERT_TRUE(IO_SDCard_push(IO_SDCARD_CHANNEL_GCODE, &item, TEST_ITEM_SIZE));
    TEST_ASSERT_TRUE(IO_SDCard_close(IO_SDCARD_CHANNEL_GCODE));
    runN(4); // drain queue, then ACTIVE->CLOSE (flush + fclose) -> INIT
    TEST_ASSERT_TRUE(IO_SDCard_isClosed(IO_SDCARD_CHANNEL_GCODE));

    // The data reached the file, not just the open succeeding.
    test_item_S readBack[2] = {0};
    TEST_ASSERT_EQUAL_UINT32(1u, readFileItems(nestedFilePath, readBack, 2));
    TEST_ASSERT_EQUAL_UINT32(42u, readBack[0].a);
    TEST_ASSERT_EQUAL_UINT32(43u, readBack[0].b);
}

// A READ open must NOT conjure directories: a missing file has to keep failing,
// or `lastOpenFailed` stops meaning anything for the download path.
static void test_read_open_does_not_provision_directories(void)
{
    IO_SDCard_config.channelConfig[IO_SDCARD_CHANNEL_GCODE].nameFormat = nestedNameFormat;

    TEST_ASSERT_TRUE(IO_SDCard_open(IO_SDCARD_CHANNEL_GCODE, TEST_BASE_NAME, IO_SDCARD_MODE_READ));
    runN(2);
    TEST_ASSERT_TRUE(IO_SDCard_lastOpenFailed(IO_SDCARD_CHANNEL_GCODE));
    TEST_ASSERT_TRUE(IO_SDCard_isClosed(IO_SDCARD_CHANNEL_GCODE));

    FILE *const probe = fopen(nestedFilePath, "rb");
    TEST_ASSERT_NULL(probe);
}

// =====================================================================================
// State machine: open failure (nonexistent directory) latches lastOpenFailed
// =====================================================================================

static void test_open_failure_latches_and_clears(void)
{
    // Base name that resolves to a path in a directory that does not exist (READ mode
    // "rb" of a missing file fails). Use READ so fopen returns NULL deterministically.
    TEST_ASSERT_TRUE(IO_SDCard_open(IO_SDCARD_CHANNEL_SAMPLE_DATA, "does_not_exist_xyz", IO_SDCARD_MODE_READ));
    // run: INIT->OPEN (fopen "rb" of missing file -> NULL), exit OPEN latches failure,
    // getDesiredState OPEN with file==NULL -> back to INIT.
    runN(2);
    TEST_ASSERT_TRUE(IO_SDCard_isClosed(IO_SDCARD_CHANNEL_SAMPLE_DATA));
    TEST_ASSERT_TRUE(IO_SDCard_lastOpenFailed(IO_SDCARD_CHANNEL_SAMPLE_DATA));

    IO_SDCard_clearLastOpenFailed(IO_SDCARD_CHANNEL_SAMPLE_DATA);
    TEST_ASSERT_FALSE(IO_SDCard_lastOpenFailed(IO_SDCARD_CHANNEL_SAMPLE_DATA));

    // lastOpenFailed bad channel -> false; clear bad channel -> no-op (no crash).
    TEST_ASSERT_FALSE(IO_SDCard_lastOpenFailed(IO_SDCARD_CHANNEL_COUNT));
    IO_SDCard_clearLastOpenFailed(IO_SDCARD_CHANNEL_COUNT);
}

static void test_open_clears_previous_failure_flag(void)
{
    // First a failing open to latch the flag.
    IO_SDCard_open(IO_SDCARD_CHANNEL_SAMPLE_DATA, "does_not_exist_xyz", IO_SDCARD_MODE_READ);
    runN(2);
    TEST_ASSERT_TRUE(IO_SDCard_lastOpenFailed(IO_SDCARD_CHANNEL_SAMPLE_DATA));

    // A fresh open() must clear lastOpenFailed immediately (before any run).
    IO_SDCard_open(IO_SDCARD_CHANNEL_SAMPLE_DATA, TEST_BASE_NAME, IO_SDCARD_MODE_WRITE);
    TEST_ASSERT_FALSE(IO_SDCard_lastOpenFailed(IO_SDCARD_CHANNEL_SAMPLE_DATA));
}

// =====================================================================================
// State machine: READ session fills queue from file, reports EOF/readDone
// =====================================================================================

static void test_read_session_fills_queue_and_reports_done(void)
{
    // Seed file with 2 items (< usable capacity 3) so EOF is hit in one processRead.
    seedFile(sampleFilePath, 2u);

    TEST_ASSERT_TRUE(IO_SDCard_open(IO_SDCARD_CHANNEL_SAMPLE_DATA, TEST_BASE_NAME, IO_SDCARD_MODE_READ));
    runN(2); // INIT->OPEN (fopen "rb") -> ACTIVE
    TEST_ASSERT_FALSE(IO_SDCard_isClosed(IO_SDCARD_CHANNEL_SAMPLE_DATA));
    TEST_ASSERT_FALSE(IO_SDCard_lastOpenFailed(IO_SDCARD_CHANNEL_SAMPLE_DATA));

    // One ACTIVE cycle: processRead fills queue until full or EOF. With 2 items it hits
    // EOF (fread returns 0 on the 3rd attempt), so eof becomes true but queue has 2 items.
    runN(1);

    // Not done yet: queue still has items.
    TEST_ASSERT_FALSE(IO_SDCard_isReadDone(IO_SDCARD_CHANNEL_SAMPLE_DATA));

    test_item_S out = {0};
    TEST_ASSERT_TRUE(IO_SDCard_pop(IO_SDCARD_CHANNEL_SAMPLE_DATA, &out));
    TEST_ASSERT_EQUAL_UINT32(0u, out.a);
    TEST_ASSERT_EQUAL_UINT32(1u, out.b); // seeded b = i*10+1 => for i=0 -> 1
    TEST_ASSERT_TRUE(IO_SDCard_pop(IO_SDCARD_CHANNEL_SAMPLE_DATA, &out));
    TEST_ASSERT_EQUAL_UINT32(1u, out.a);
    TEST_ASSERT_EQUAL_UINT32(11u, out.b); // i=1 -> 1*10+1

    // Now EOF + empty queue -> read done.
    TEST_ASSERT_TRUE(IO_SDCard_isReadDone(IO_SDCARD_CHANNEL_SAMPLE_DATA));
    // Bad channel -> false.
    TEST_ASSERT_FALSE(IO_SDCard_isReadDone(IO_SDCARD_CHANNEL_COUNT));
}

// =====================================================================================
// readDirectEx: direct synchronous read with seek + status codes
// =====================================================================================

static void test_readDirect_ok_with_seek_offset(void)
{
    seedFile(sampleFilePath, 5u); // items 0..4

    test_item_S out[3] = {0};
    IO_SDCard_readDirectStatus_E status = (IO_SDCard_readDirectStatus_E)0xFF;
    // Read 2 items starting at index 2.
    uint32_t n = IO_SDCard_readDirectEx(IO_SDCARD_CHANNEL_SAMPLE_DATA, TEST_BASE_NAME, out, 2u, 2u, &status);
    TEST_ASSERT_EQUAL_UINT32(2u, n);
    TEST_ASSERT_EQUAL_INT(IO_SDCARD_READDIRECT_STATUS_OK, status);
    TEST_ASSERT_EQUAL_UINT32(2u, out[0].a);
    TEST_ASSERT_EQUAL_UINT32(21u, out[0].b); // i=2 -> 2*10+1
    TEST_ASSERT_EQUAL_UINT32(3u, out[1].a);

    // Non-Ex convenience wrapper returns same count.
    test_item_S out2[2] = {0};
    TEST_ASSERT_EQUAL_UINT32(2u, IO_SDCard_readDirect(IO_SDCARD_CHANNEL_SAMPLE_DATA, TEST_BASE_NAME, out2, 0u, 2u));
    TEST_ASSERT_EQUAL_UINT32(0u, out2[0].a);
}

static void test_readDirect_file_error_when_missing(void)
{
    test_item_S out[1] = {0};
    IO_SDCard_readDirectStatus_E status = IO_SDCARD_READDIRECT_STATUS_OK;
    uint32_t n = IO_SDCard_readDirectEx(IO_SDCARD_CHANNEL_SAMPLE_DATA, "missing_file_zzz", out, 0u, 1u, &status);
    TEST_ASSERT_EQUAL_UINT32(0u, n);
    TEST_ASSERT_EQUAL_INT(IO_SDCARD_READDIRECT_STATUS_FILE_ERROR, status);
}

static void test_readDirect_guard_paths(void)
{
    test_item_S out[1] = {0};
    IO_SDCard_readDirectStatus_E status = IO_SDCARD_READDIRECT_STATUS_OK;

    // Bad channel.
    TEST_ASSERT_EQUAL_UINT32(0u, IO_SDCard_readDirectEx(IO_SDCARD_CHANNEL_COUNT, TEST_BASE_NAME, out, 0u, 1u, &status));
    // NULL buffer.
    TEST_ASSERT_EQUAL_UINT32(0u, IO_SDCard_readDirectEx(IO_SDCARD_CHANNEL_SAMPLE_DATA, TEST_BASE_NAME, NULL, 0u, 1u, &status));
    // Zero itemCount.
    TEST_ASSERT_EQUAL_UINT32(0u, IO_SDCard_readDirectEx(IO_SDCARD_CHANNEL_SAMPLE_DATA, TEST_BASE_NAME, out, 0u, 0u, &status));
}

static void test_readDirect_returns_zero_past_eof_but_status_ok(void)
{
    seedFile(sampleFilePath, 2u);
    test_item_S out[2] = {0};
    IO_SDCard_readDirectStatus_E status = (IO_SDCard_readDirectStatus_E)0xFF;
    // Seek to index 5 (past EOF): fseek succeeds, fread returns 0 -> OK + 0 items.
    uint32_t n = IO_SDCard_readDirectEx(IO_SDCARD_CHANNEL_SAMPLE_DATA, TEST_BASE_NAME, out, 5u, 2u, &status);
    TEST_ASSERT_EQUAL_UINT32(0u, n);
    TEST_ASSERT_EQUAL_INT(IO_SDCARD_READDIRECT_STATUS_OK, status);
}

static void test_readDirect_busy_while_write_active(void)
{
    // Open SAMPLE_DATA in WRITE mode and drive to ACTIVE.
    TEST_ASSERT_TRUE(IO_SDCard_open(IO_SDCARD_CHANNEL_SAMPLE_DATA, TEST_BASE_NAME, IO_SDCARD_MODE_WRITE));
    runN(2); // INIT->OPEN->ACTIVE, mode=WRITE, state != INIT

    // readDirect on the same channel must report BUSY (state != INIT && mode WRITE).
    test_item_S out[1] = {0};
    IO_SDCard_readDirectStatus_E status = (IO_SDCard_readDirectStatus_E)0xFF;
    uint32_t n = IO_SDCard_readDirectEx(IO_SDCARD_CHANNEL_SAMPLE_DATA, TEST_BASE_NAME, out, 0u, 1u, &status);
    TEST_ASSERT_EQUAL_UINT32(0u, n);
    TEST_ASSERT_EQUAL_INT(IO_SDCARD_READDIRECT_STATUS_BUSY, status);

    // Cleanup: close it so tearDown removes the file.
    IO_SDCard_close(IO_SDCARD_CHANNEL_SAMPLE_DATA);
    runN(3);
}

// =====================================================================================
// close()-while-INIT must not latch disable (documented bug-guard in close()).
// =====================================================================================

static void test_close_while_init_is_noop(void)
{
    // Channel starts INIT. close() should clear disable and succeed without latching.
    TEST_ASSERT_TRUE(IO_SDCard_close(IO_SDCARD_CHANNEL_GCODE));
    // internal/external disable must both be false (guarded path).
    TEST_ASSERT_FALSE(IO_SDCARD_LOCKED_REQUEST(IO_SDCARD_CHANNEL_GCODE).disable);
    TEST_ASSERT_FALSE(IO_SDCARD_INTERNAL_REQUEST(IO_SDCARD_CHANNEL_GCODE).disable);

    // Now a real WRITE session: open, push a move, close, run — file must contain the
    // item (not be truncated by a stuck disable from the prior redundant close).
    TEST_ASSERT_TRUE(IO_SDCard_open(IO_SDCARD_CHANNEL_GCODE, TEST_BASE_NAME, IO_SDCARD_MODE_WRITE));
    runN(2); // -> ACTIVE
    test_item_S item = {.a = 0x55, .b = 0xAA};
    TEST_ASSERT_TRUE(IO_SDCard_push(IO_SDCARD_CHANNEL_GCODE, &item, TEST_ITEM_SIZE));
    runN(1); // drain to file
    IO_SDCard_close(IO_SDCARD_CHANNEL_GCODE);
    runN(4);
    TEST_ASSERT_TRUE(IO_SDCard_isClosed(IO_SDCARD_CHANNEL_GCODE));

    test_item_S readBack[2] = {0};
    TEST_ASSERT_EQUAL_UINT32(1u, readFileItems(gcodeFilePath, readBack, 2));
    TEST_ASSERT_EQUAL_UINT32(0x55u, readBack[0].a);
    TEST_ASSERT_EQUAL_UINT32(0xAAu, readBack[0].b);
}

// =====================================================================================
// Runner
// =====================================================================================
int main(void)
{
    UNITY_BEGIN();

    RUN_TEST(test_open_rejects_out_of_range_channel);
    RUN_TEST(test_close_rejects_out_of_range_channel);
    RUN_TEST(test_isClosed_true_after_init_and_false_for_bad_channel);
    RUN_TEST(test_push_size_mismatch_rejected);

    RUN_TEST(test_push_pop_roundtrip);
    RUN_TEST(test_push_until_full_boundary);
    RUN_TEST(test_popMultiple_counts_and_guards);

    RUN_TEST(test_write_session_opens_flushes_and_closes);
    RUN_TEST(test_write_close_flushes_remaining_queue_on_close);
    RUN_TEST(test_write_open_provisions_missing_directories);
    RUN_TEST(test_read_open_does_not_provision_directories);

    RUN_TEST(test_open_failure_latches_and_clears);
    RUN_TEST(test_open_clears_previous_failure_flag);

    RUN_TEST(test_read_session_fills_queue_and_reports_done);

    RUN_TEST(test_readDirect_ok_with_seek_offset);
    RUN_TEST(test_readDirect_file_error_when_missing);
    RUN_TEST(test_readDirect_guard_paths);
    RUN_TEST(test_readDirect_returns_zero_past_eof_but_status_ok);
    RUN_TEST(test_readDirect_busy_while_write_active);

    RUN_TEST(test_close_while_init_is_noop);

    return UNITY_END();
}
