/**
 * @file vibes_behaviour.h
 * @brief Declare a behaviour from a C test and emit it to behaviours.jsonl.
 *
 * Unity registers tests as bare functions, so unlike the TypeScript binding
 * this cannot wrap the test — it is a statement inside the body:
 *
 *     void test_dev_nvram_loads_defaults(void)
 *     {
 *         VIBES_BEHAVIOUR("nvram.defaults",
 *                         "src/DEV/dev_nvram.c#dev_nvram_loadDefaultMachineProfile",
 *                         "a fresh NVRAM with no stored profile",
 *                         "the default machine profile is returned");
 *         ...
 *     }
 *
 * See ../SCHEMA.md for the wire contract. Two rules it imposes:
 *
 *   1. FIRST STATEMENT IN THE BODY. The line must be written on entry. If it
 *      were written at the end, a failing or crashing test would emit nothing
 *      and Vibes would report the behaviour as REMOVED — "this PR deleted a
 *      behaviour" when a test merely crashed is the worst misreport available.
 *
 *   2. NO STATUS. Pass/fail has not happened yet. Vibes joins it from Unity's
 *      own output on the `test` field, which this macro fills from __func__ so
 *      the join key cannot drift from the function Unity actually ran.
 *
 * Inert unless $VIBES_BEHAVIOURS names a file, so the suite runs normally on
 * its own. Never fails a test: a ledger that cannot be written is a reporting
 * problem, and the test's own verdict is unaffected by it.
 */

#ifndef VIBES_BEHAVIOUR_H
#define VIBES_BEHAVIOUR_H

#include <stdio.h>
#include <stdlib.h>

/** Longest JSON string field we will emit. Keeps a record under PIPE_BUF so a
 *  line cannot be interleaved with another writer's. */
#define VIBES_MAX_FIELD 512

/** Writes `s` as a JSON string body (no surrounding quotes), escaped. */
static void vibes_json_escape(FILE *f, const char *s)
{
    if (s == NULL)
    {
        return;
    }
    size_t written = 0U;
    for (const unsigned char *p = (const unsigned char *)s;
         (*p != '\0') && (written < (size_t)VIBES_MAX_FIELD); ++p, ++written)
    {
        switch (*p)
        {
        case '"':
            (void)fputs("\\\"", f);
            break;
        case '\\':
            (void)fputs("\\\\", f);
            break;
        case '\n':
            (void)fputs("\\n", f);
            break;
        case '\r':
            (void)fputs("\\r", f);
            break;
        case '\t':
            (void)fputs("\\t", f);
            break;
        default:
            if (*p < 0x20U)
            {
                /* Any other control character would make the line unparseable. */
                (void)fprintf(f, "\\u%04x", (unsigned)*p);
            }
            else
            {
                (void)fputc((int)*p, f);
            }
            break;
        }
    }
}

static void vibes_field(FILE *f, const char *key, const char *value)
{
    if ((value == NULL) || (value[0] == '\0'))
    {
        return;
    }
    (void)fprintf(f, ",\"%s\":\"", key);
    vibes_json_escape(f, value);
    (void)fputc('"', f);
}

/**
 * @brief The test currently being declared. Unity runs one test at a time in
 *        one process, so a file-static is the whole of the state needed:
 *        VIBES_TEST stores the condition, each VIBES_EXPECT spends it.
 */
static const char *vibes_cur_id;
static const char *vibes_cur_covers;
static const char *vibes_cur_given;
static const char *vibes_cur_test;
static const char *vibes_cur_file;

/** @brief Record the test's identity and the condition it sets up. */
static void vibes_test_begin(const char *id, const char *covers, const char *given,
                             const char *func, const char *file)
{
    vibes_cur_id = id;
    vibes_cur_covers = covers;
    vibes_cur_given = given;
    vibes_cur_test = func;
    vibes_cur_file = file;
}

/**
 * @brief Append one expectation of the current test.
 * @param expect Short id, unique within the test — the stable half of identity.
 */
static void vibes_expect_emit(const char *expect, const char *then, const char *why)
{
    const char *path = getenv("VIBES_BEHAVIOURS");
    if ((path == NULL) || (path[0] == '\0'))
    {
        return; /* not running under Vibes */
    }
    if (vibes_cur_id == NULL)
    {
        return; /* VIBES_EXPECT without a VIBES_TEST above it */
    }

    /* "a" is O_APPEND: each suite is its own process under pio, and a record
     * this size lands atomically, so suites never interleave a partial line. */
    FILE *f = fopen(path, "a");
    if (f == NULL)
    {
        return; /* reporting problem, not a test failure */
    }

    (void)fputs("{\"v\":2,\"lang\":\"c\"", f);
    vibes_field(f, "id", vibes_cur_id);
    vibes_field(f, "expect", expect);
    vibes_field(f, "test", vibes_cur_test);
    vibes_field(f, "file", vibes_cur_file);
    vibes_field(f, "covers", vibes_cur_covers);
    vibes_field(f, "given", vibes_cur_given);
    vibes_field(f, "then", then);
    vibes_field(f, "why", why);
    (void)fputs("}\n", f);
    (void)fclose(f);
}

/**
 * Declare the test and the condition it sets up. MUST be the first statement
 * in the test body — a crash before it leaves every expectation unrecorded,
 * and the report then reads as though they were deleted.
 */
#define VIBES_TEST(id, covers, given)                                                              \
    vibes_test_begin((id), (covers), (given), __func__, __FILE__)

/** One expectation for the condition above. Follows VIBES_TEST. */
#define VIBES_EXPECT(expect, then) vibes_expect_emit((expect), (then), NULL)

/** As VIBES_EXPECT, plus the standing requirement this expectation serves. */
#define VIBES_EXPECT_WHY(expect, then, why) vibes_expect_emit((expect), (then), (why))

#endif /* VIBES_BEHAVIOUR_H */
