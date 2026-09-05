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
 * @brief Append one behaviour record. Called via VIBES_BEHAVIOUR.
 * @param func Unity's name for this test (__func__) — the pass/fail join key.
 */
static void vibes_behaviour_emit(const char *id, const char *covers, const char *given,
                                 const char *then, const char *why, const char *func,
                                 const char *file)
{
    const char *path = getenv("VIBES_BEHAVIOURS");
    if ((path == NULL) || (path[0] == '\0'))
    {
        return; /* not running under Vibes */
    }

    /* "a" is O_APPEND: each suite is its own process under pio, and a record
     * this size lands atomically, so suites never interleave a partial line. */
    FILE *f = fopen(path, "a");
    if (f == NULL)
    {
        return; /* reporting problem, not a test failure */
    }

    (void)fputs("{\"v\":1,\"lang\":\"c\"", f);
    vibes_field(f, "id", id);
    vibes_field(f, "test", func);
    vibes_field(f, "file", file);
    vibes_field(f, "covers", covers);
    vibes_field(f, "given", given);
    vibes_field(f, "then", then);
    vibes_field(f, "why", why);
    (void)fputs("}\n", f);
    (void)fclose(f);
}

/** Declare a behaviour. MUST be the first statement in the test body. */
#define VIBES_BEHAVIOUR(id, covers, given, then)                                                   \
    vibes_behaviour_emit((id), (covers), (given), (then), NULL, __func__, __FILE__)

/** As VIBES_BEHAVIOUR, plus why the behaviour matters (a pinned defect, a requirement). */
#define VIBES_BEHAVIOUR_WHY(id, covers, given, then, why)                                          \
    vibes_behaviour_emit((id), (covers), (given), (then), (why), __func__, __FILE__)

#endif /* VIBES_BEHAVIOUR_H */
